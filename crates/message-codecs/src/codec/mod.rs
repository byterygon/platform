//! The codec registry (Mightyconsole spec §5.2): decode and encode a key or a value with a
//! chosen codec, or detect one.
//!
//! **Auto-detect order** (key and value separately): (1) the Confluent wire format when the
//! profile has a registry and the id resolves; (2) a mapping for the topic, subject, stream or
//! bucket; (3) `json`; (4) `cbor`; (5) `msgpack`; (6) `utf8`; (7) `hex`. `base64` is never
//! detected. Raw bytes are never replaced: a failed decode keeps them and says why.

pub mod avro;
pub mod cbor;
pub mod jsonschema;
pub mod msgpack;
pub mod plain;
pub mod protobuf;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};

use crate::registry::{RegistryClient, RegistrySchema};
use crate::schema::{CompiledSchema, LocalSchemas, find_mapping};
use crate::types::{
    CodecChoice, CodecId, CodecSelector, ComposePayload, LocalSchema, NamingConfig, NamingStrategy,
    Part, RegistryRef, SchemaIssue, SchemaMapping, SchemaRef, SchemaVersion, Target, WireFormat,
};
use crate::{CodecError, ErrorKind, Result, wire};

/// One entry of `messaging.codecs.list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct CodecInfo {
    pub id: CodecId,
    pub label: String,
    pub needs_schema: bool,
    pub can_encode: bool,
}

/// Every codec (spec §5.8, `messaging.codecs.list`).
pub fn codec_list() -> Vec<CodecInfo> {
    CodecId::ALL
        .iter()
        .map(|&id| CodecInfo {
            id,
            label: id.label().to_owned(),
            needs_schema: id.needs_schema(),
            can_encode: true,
        })
        .collect()
}

/// A decoded key or value.
#[derive(Debug, Clone, PartialEq)]
pub struct Decoded {
    /// The codec used (the chosen one, or the detected one).
    pub codec: CodecId,
    /// Canonical JSON text, or text (hex and base64 as their text); `None` when decoding failed.
    pub text: Option<String>,
    /// The JSON value, for JSON-shaped codecs; text codecs leave it `None`.
    pub json: Option<serde_json::Value>,
    /// `registry:<id>`, `registry:<subject>/<version>` or `local:<schemaId>[#MessageType]`.
    pub schema_ref: Option<String>,
    /// Why the codec failed, or a JSON Schema's violations (with the text still present).
    pub error: Option<String>,
}

impl Decoded {
    fn text(codec: CodecId, text: String) -> Self {
        Self {
            codec,
            text: Some(text),
            json: None,
            schema_ref: None,
            error: None,
        }
    }

    fn json(codec: CodecId, text: String, json: serde_json::Value) -> Self {
        Self {
            codec,
            text: Some(text),
            json: Some(json),
            schema_ref: None,
            error: None,
        }
    }

    fn failed(codec: CodecId, error: impl Into<String>) -> Self {
        Self {
            codec,
            text: None,
            json: None,
            schema_ref: None,
            error: Some(error.into()),
        }
    }

    fn with_ref(mut self, r: Option<String>) -> Self {
        self.schema_ref = r;
        self
    }

    /// The value as the filter sees it: the JSON, else the text as a JSON string.
    pub fn value(&self) -> serde_json::Value {
        match (&self.json, &self.text) {
            (Some(j), _) => j.clone(),
            (None, Some(t)) => serde_json::Value::String(t.clone()),
            (None, None) => serde_json::Value::Null,
        }
    }
}

/// Encoded bytes, ready to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Encoded {
    pub bytes: Vec<u8>,
    /// The registry id written in the wire format, if any.
    pub schema_id: Option<u32>,
    pub schema_ref: Option<String>,
}

/// What a connected profile gives the codecs.
#[derive(Debug, Clone, Default)]
pub struct CodecsConfig {
    pub registry: Option<RegistryClient>,
    pub local_schemas: Vec<LocalSchema>,
    pub mappings: Vec<SchemaMapping>,
    pub naming: NamingConfig,
    /// The mappings' counts; pass the current codecs' to keep them across a change.
    pub stats: MappingStats,
}

/// How many messages a mapping decoded, and how many of them failed (this session).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct MappingCount {
    pub decoded: u64,
    pub failed: u64,
}

/// The counts of a connection's mappings, by mapping id; shared by its codecs and their clones.
#[derive(Debug, Clone, Default)]
pub struct MappingStats(Arc<Mutex<HashMap<String, MappingCount>>>);

impl MappingStats {
    fn record(&self, id: &str, failed: bool) {
        let mut counts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let c = counts.entry(id.to_owned()).or_default();
        c.decoded += 1;
        if failed {
            c.failed += 1;
        }
    }

    pub fn get(&self, id: &str) -> MappingCount {
        let counts = self.0.lock().unwrap_or_else(|e| e.into_inner());
        counts.get(id).copied().unwrap_or_default()
    }
}

/// A schema found for a decode or an encode.
#[derive(Debug, Clone)]
pub struct ResolvedSchema {
    pub compiled: Arc<CompiledSchema>,
    /// The `schemaRef` text.
    pub reference: String,
    /// Set for registry schemas: what the wire format writes.
    pub registry_id: Option<u32>,
    /// The mapping's message type, for Protobuf.
    pub message_type: Option<String>,
}

/// The codecs of one connected profile: its registry, its compiled local schemas and mappings.
/// Cheap to clone; shared by the profile's streams.
#[derive(Debug, Clone)]
pub struct Codecs {
    inner: Arc<CodecsInner>,
}

#[derive(Debug)]
struct CodecsInner {
    registry: Option<RegistryClient>,
    local: LocalSchemas,
    mappings: Vec<SchemaMapping>,
    naming: NamingConfig,
    issues: Vec<SchemaIssue>,
    stats: MappingStats,
}

impl Default for Codecs {
    fn default() -> Self {
        Self::new(CodecsConfig::default())
    }
}

impl Codecs {
    /// Compiles the local schemas; the ones that fail are listed in [`Codecs::issues`].
    pub fn new(config: CodecsConfig) -> Self {
        let (local, issues) = LocalSchemas::compile(&config.local_schemas);
        Self {
            inner: Arc::new(CodecsInner {
                registry: config.registry,
                local,
                mappings: config.mappings,
                naming: config.naming,
                issues,
                stats: config.stats,
            }),
        }
    }

    pub fn issues(&self) -> &[SchemaIssue] {
        &self.inner.issues
    }

    pub fn registry(&self) -> Option<&RegistryClient> {
        self.inner.registry.as_ref()
    }

    pub fn local(&self) -> &LocalSchemas {
        &self.inner.local
    }

    pub fn naming(&self) -> &NamingConfig {
        &self.inner.naming
    }

    pub fn mappings(&self) -> &[SchemaMapping] {
        &self.inner.mappings
    }

    pub fn stats(&self) -> &MappingStats {
        &self.inner.stats
    }

    /// Finds a schema by reference.
    pub async fn resolve(&self, schema: &SchemaRef) -> Result<ResolvedSchema> {
        match schema {
            SchemaRef::Local(id) => {
                let compiled = self.inner.local.get(id).ok_or_else(|| {
                    let failed = self
                        .inner
                        .issues
                        .iter()
                        .any(|i| i.schema_id.as_deref() == Some(id));
                    if failed {
                        CodecError::invalid(format!("local schema {id} does not compile"))
                    } else {
                        CodecError::not_found(format!("no local schema {id} in this profile"))
                    }
                })?;
                Ok(ResolvedSchema {
                    compiled,
                    reference: format!("local:{id}"),
                    registry_id: None,
                    message_type: None,
                })
            }
            SchemaRef::Registry(r) => {
                let registry = self.registry_or_err()?;
                match r {
                    RegistryRef::Id { id } => {
                        let s = registry.schema_by_id(*id).await?;
                        Ok(registry_resolved(&s, format!("registry:{id}")))
                    }
                    RegistryRef::Subject { subject, version } => {
                        let v = registry.subject_version(subject, *version).await?;
                        Ok(registry_resolved(
                            &v.schema,
                            format!("registry:{subject}/{}", v.version),
                        ))
                    }
                }
            }
        }
    }

    fn registry_or_err(&self) -> Result<&RegistryClient> {
        self.inner.registry.as_ref().ok_or_else(|| {
            CodecError::new(ErrorKind::Invalid, "this profile has no Schema Registry")
        })
    }

    /// The schema of the mapping for a target, when that mapping names one.
    fn mapped(&self, target: Option<&Target>, part: Part) -> Option<Result<ResolvedSchema>> {
        let m = find_mapping(&self.inner.mappings, target?, part)?;
        m.schema_id.as_ref()?;
        Some(self.mapping_schema(m))
    }

    fn mapping_schema(&self, m: &SchemaMapping) -> Result<ResolvedSchema> {
        let Some(id) = m.schema_id.as_deref() else {
            return Err(CodecError::invalid(format!(
                "mapping {} names no schema",
                m.id
            )));
        };
        match self.inner.local.get(id) {
            Some(compiled) => Ok(ResolvedSchema {
                compiled,
                reference: local_ref(id, m.message_type.as_deref()),
                registry_id: None,
                message_type: m.message_type.clone(),
            }),
            None => Err(CodecError::invalid(format!(
                "mapping {} names local schema {id}, which is missing or does not compile",
                m.id
            ))),
        }
    }

    /// Decodes bytes with one mapping, whether or not it matches them (the mapping test, and
    /// step 2 of auto-detect). A failure keeps the bytes as hex and says why.
    pub fn decode_mapping(&self, m: &SchemaMapping, bytes: &[u8]) -> Decoded {
        let d = self.decode_mapping_as(m, bytes);
        if d.text.is_some() {
            return d;
        }
        // Keep the bytes readable as hex next to the reason.
        Decoded {
            codec: CodecId::Hex,
            text: Some(plain::decode_hex(bytes)),
            ..d
        }
    }

    fn decode_mapping_as(&self, m: &SchemaMapping, bytes: &[u8]) -> Decoded {
        let resolved = match m.schema_id {
            Some(_) => match self.mapping_schema(m) {
                Ok(r) => Some(r),
                Err(e) => {
                    return Decoded::failed(m.codec.unwrap_or(CodecId::Hex), e.message);
                }
            },
            None => None,
        };
        let schema_type = resolved.as_ref().map(|r| r.compiled.schema_type());
        let Some(codec) = m.codec_with(schema_type) else {
            return Decoded::failed(
                CodecId::Hex,
                format!("mapping {} names neither a codec nor a schema", m.id),
            );
        };
        let confluent = m.wire_format == Some(WireFormat::Confluent);
        let payload = if confluent {
            match wire::split(bytes) {
                Some((_, rest)) => rest,
                None => {
                    return Decoded::failed(
                        codec,
                        "not in the Confluent wire format (magic byte 0 and a schema id)",
                    );
                }
            }
        } else {
            bytes
        };
        match resolved {
            None if codec.needs_schema() => Decoded::failed(
                codec,
                format!(
                    "{} needs a schema; mapping {} names none",
                    codec.label(),
                    m.id
                ),
            ),
            None => decode_plain(codec, payload),
            Some(r) => {
                if r.compiled.schema_type().codec() != codec {
                    Decoded::failed(
                        codec,
                        format!(
                            "the schema is {:?}, not {}",
                            r.compiled.schema_type(),
                            codec.label()
                        ),
                    )
                    .with_ref(Some(r.reference.clone()))
                } else {
                    // Confluent Protobuf: the message indexes follow the id; the mapping's type
                    // names the message.
                    let body = match (confluent, r.compiled.as_ref()) {
                        (true, CompiledSchema::Protobuf(_)) => {
                            match wire::split_message_indexes(payload) {
                                Ok((_, rest)) => rest,
                                Err(e) => {
                                    return Decoded::failed(codec, e.message)
                                        .with_ref(Some(r.reference.clone()));
                                }
                            }
                        }
                        _ => payload,
                    };
                    decode_schema(&r, body, false, m.message_type.as_deref())
                }
            }
        }
    }

    /// Decodes one key or value (spec §5.2). Never fails: a failure is in [`Decoded::error`].
    pub async fn decode(
        &self,
        bytes: &[u8],
        target: Option<&Target>,
        part: Part,
        choice: &CodecChoice,
    ) -> Decoded {
        match choice.codec {
            CodecSelector::Auto(_) => self.detect_and_decode(bytes, target, part).await,
            CodecSelector::Codec(codec) => {
                self.decode_with(codec, bytes, target, part, choice).await
            }
        }
    }

    async fn detect_and_decode(
        &self,
        bytes: &[u8],
        target: Option<&Target>,
        part: Part,
    ) -> Decoded {
        let mut note = None;
        // (1) Confluent wire format with a registry id that resolves.
        if let (Some(registry), Some((header, rest))) =
            (self.inner.registry.as_ref(), wire::split(bytes))
        {
            match registry.schema_by_id(header.schema_id).await {
                Ok(s) => {
                    let resolved = registry_resolved(&s, format!("registry:{}", header.schema_id));
                    return decode_schema(&resolved, rest, true, None);
                }
                Err(e) if e.kind == ErrorKind::NotFound => {}
                Err(e) => {
                    note = Some(format!(
                        "registry schema {}: {}",
                        header.schema_id, e.message
                    ))
                }
            }
        }
        // (2) A mapping: a codec, with a local schema when it needs one.
        if let Some(m) = target.and_then(|t| find_mapping(&self.inner.mappings, t, part)) {
            let d = self.decode_mapping(m, bytes);
            self.inner.stats.record(&m.id, d.error.is_some());
            return d;
        }
        // (3)-(6)
        let mut d = decode_plain_detected(bytes);
        if d.error.is_none() {
            d.error = note;
        }
        d
    }

    async fn decode_with(
        &self,
        codec: CodecId,
        bytes: &[u8],
        target: Option<&Target>,
        part: Part,
        choice: &CodecChoice,
    ) -> Decoded {
        if !codec.needs_schema() {
            return decode_plain(codec, bytes);
        }
        // An explicit schema; else the wire format's id; else a mapping.
        let (resolved, wire_format) = match &choice.schema {
            Some(schema @ SchemaRef::Registry(_)) => (self.resolve(schema).await, true),
            Some(schema @ SchemaRef::Local(_)) => (self.resolve(schema).await, false),
            None => match (self.inner.registry.as_ref(), wire::split(bytes)) {
                (Some(registry), Some((h, _))) => (
                    registry
                        .schema_by_id(h.schema_id)
                        .await
                        .map(|s| registry_resolved(&s, format!("registry:{}", h.schema_id))),
                    true,
                ),
                _ => match self.mapped(target, part) {
                    Some(r) => (r, false),
                    None => {
                        return Decoded::failed(
                            codec,
                            format!(
                                "{} needs a schema: choose one, or map one to this {}",
                                codec.label(),
                                part.as_str()
                            ),
                        );
                    }
                },
            },
        };
        let resolved = match resolved {
            Ok(r) => r,
            Err(e) => return Decoded::failed(codec, e.message),
        };
        if resolved.compiled.schema_type().codec() != codec {
            return Decoded::failed(
                codec,
                format!(
                    "the schema is {:?}, not {}",
                    resolved.compiled.schema_type(),
                    codec.label()
                ),
            )
            .with_ref(Some(resolved.reference));
        }
        let message_type = choice
            .message_type
            .clone()
            .or_else(|| resolved.message_type.clone());
        let payload = if wire_format {
            match wire::split(bytes) {
                Some((_, rest)) => rest,
                None => {
                    return Decoded::failed(
                        codec,
                        "not in the Confluent wire format (magic byte 0 and a schema id)",
                    )
                    .with_ref(Some(resolved.reference));
                }
            }
        } else {
            bytes
        };
        decode_schema(&resolved, payload, wire_format, message_type.as_deref())
    }

    /// Encodes a Composer payload (spec §5.7). For Kafka topics with a registry and no schema
    /// chosen, the subject comes from the naming strategy (`TopicNameStrategy` only, since the
    /// record strategies need the record's name, which needs the schema).
    pub async fn encode(
        &self,
        target: Option<&Target>,
        part: Part,
        payload: &ComposePayload,
    ) -> Result<Encoded> {
        let field = part.as_str();
        let plain = |bytes: Result<Vec<u8>>| {
            bytes
                .map(|bytes| Encoded {
                    bytes,
                    schema_id: None,
                    schema_ref: None,
                })
                .map_err(|e| e.field(field))
        };
        match payload.codec {
            CodecId::Utf8 => return plain(Ok(payload.text.clone().into_bytes())),
            CodecId::Json => return plain(plain::encode_json(&payload.text)),
            CodecId::Hex => return plain(plain::encode_hex(&payload.text)),
            CodecId::Base64 => return plain(plain::encode_base64(&payload.text)),
            CodecId::Msgpack => return plain(msgpack::encode(&payload.text)),
            CodecId::Cbor => return plain(cbor::encode(&payload.text)),
            CodecId::Avro | CodecId::Protobuf | CodecId::Jsonschema => {}
        }
        let resolved = match &payload.schema {
            Some(s) => self.resolve(s).await,
            None => match self.mapped(target, part) {
                Some(r) => r,
                None => match (self.inner.registry.as_ref(), target) {
                    (Some(_), Some(Target::Topic { name }))
                        if self.inner.naming.strategy_for(name)
                            == NamingStrategy::TopicNameStrategy =>
                    {
                        let subject = self.inner.naming.subject(name, part, None)?;
                        self.resolve(&SchemaRef::Registry(RegistryRef::Subject {
                            subject,
                            version: SchemaVersion::Latest(crate::types::Latest::Latest),
                        }))
                        .await
                    }
                    _ => Err(CodecError::invalid(format!(
                        "{} needs a schema",
                        payload.codec.label()
                    ))),
                },
            },
        }
        .map_err(|e| e.field(field))?;
        if resolved.compiled.schema_type().codec() != payload.codec {
            return Err(CodecError::invalid(format!(
                "the schema is {:?}, not {}",
                resolved.compiled.schema_type(),
                payload.codec.label()
            ))
            .field(field));
        }
        let json = || {
            serde_json::from_str::<serde_json::Value>(&payload.text)
                .map_err(|e| CodecError::json(&e).field(field))
        };
        let message_type = payload
            .message_type
            .clone()
            .or_else(|| resolved.message_type.clone());
        let (body, indexes) = match resolved.compiled.as_ref() {
            CompiledSchema::Avro(s) => (s.encode(&json()?).map_err(|e| e.field(field))?, None),
            CompiledSchema::JsonSchema(s) => {
                s.check(&json()?).map_err(|e| e.field(field))?;
                (payload.text.as_bytes().to_vec(), None)
            }
            CompiledSchema::Protobuf(s) => {
                let msg = s
                    .message(message_type.as_deref())
                    .map_err(|e| e.field(field))?;
                let body = s.encode(&msg, &payload.text).map_err(|e| e.field(field))?;
                let indexes = match resolved.registry_id {
                    Some(_) => Some(s.indexes_of(&msg).map_err(|e| e.field(field))?),
                    None => None,
                };
                (body, indexes)
            }
        };
        let schema_ref = Some(match (resolved.compiled.as_ref(), resolved.registry_id) {
            (CompiledSchema::Protobuf(s), None) => {
                let used = s
                    .message(message_type.as_deref())
                    .map(|m| m.full_name().to_owned())
                    .unwrap_or_default();
                format!(
                    "{}#{used}",
                    resolved.reference.split('#').next().unwrap_or_default()
                )
            }
            _ => resolved.reference.clone(),
        });
        let wire_format = payload
            .wire_format
            .unwrap_or(if resolved.registry_id.is_some() {
                WireFormat::Confluent
            } else {
                WireFormat::None
            });
        match (wire_format, resolved.registry_id) {
            (WireFormat::Confluent, Some(id)) => Ok(Encoded {
                bytes: wire::write(id, indexes.as_deref(), &body),
                schema_id: Some(id),
                schema_ref,
            }),
            (WireFormat::Confluent, None) => Err(CodecError::invalid(
                "the Confluent wire format needs a schema from the registry",
            )
            .field(field)),
            (WireFormat::None, _) => Ok(Encoded {
                bytes: body,
                schema_id: None,
                schema_ref,
            }),
        }
    }
}

fn local_ref(id: &str, message_type: Option<&str>) -> String {
    match message_type {
        Some(t) => format!("local:{id}#{t}"),
        None => format!("local:{id}"),
    }
}

fn registry_resolved(s: &RegistrySchema, reference: String) -> ResolvedSchema {
    ResolvedSchema {
        compiled: s.compiled.clone(),
        reference,
        registry_id: Some(s.id),
        message_type: None,
    }
}

/// Decodes with a schema. `wire_format`: the payload followed the 5-byte header, so for
/// Protobuf the message indexes come first.
fn decode_schema(
    resolved: &ResolvedSchema,
    bytes: &[u8],
    wire_format: bool,
    message_type: Option<&str>,
) -> Decoded {
    let reference = Some(resolved.reference.clone());
    match resolved.compiled.as_ref() {
        CompiledSchema::Avro(s) => match s.decode(bytes) {
            Ok(j) => Decoded::json(CodecId::Avro, j.to_text(), j.to_value()),
            Err(e) => Decoded::failed(CodecId::Avro, e.message),
        }
        .with_ref(reference),
        CompiledSchema::Protobuf(s) => {
            let (msg, body) = if wire_format && resolved.registry_id.is_some() {
                match wire::split_message_indexes(bytes)
                    .and_then(|(ix, rest)| Ok((s.message_by_indexes(&ix)?, rest)))
                {
                    Ok(v) => v,
                    Err(e) => {
                        return Decoded::failed(CodecId::Protobuf, e.message).with_ref(reference);
                    }
                }
            } else {
                match s.message(message_type) {
                    Ok(m) => (m, bytes),
                    Err(e) => {
                        return Decoded::failed(CodecId::Protobuf, e.message).with_ref(reference);
                    }
                }
            };
            let reference = Some(if resolved.registry_id.is_some() {
                resolved.reference.clone()
            } else {
                format!(
                    "{}#{}",
                    resolved.reference.split('#').next().unwrap_or_default(),
                    msg.full_name()
                )
            });
            match s.decode(&msg, body) {
                Ok((text, json)) => Decoded::json(CodecId::Protobuf, text, json),
                Err(e) => Decoded::failed(CodecId::Protobuf, e.message),
            }
            .with_ref(reference)
        }
        CompiledSchema::JsonSchema(s) => match plain::decode_json(bytes) {
            Ok((text, json)) => {
                let violations = s.violations(&json);
                let mut d = Decoded::json(CodecId::Jsonschema, text, json);
                if !violations.is_empty() {
                    d.error = Some(format!(
                        "does not match the schema: {}",
                        violations.join("; ")
                    ));
                }
                d
            }
            Err(e) => Decoded::failed(CodecId::Jsonschema, e.message),
        }
        .with_ref(reference),
    }
}

fn decode_plain(codec: CodecId, bytes: &[u8]) -> Decoded {
    match codec {
        CodecId::Utf8 => match plain::decode_utf8(bytes) {
            Ok(t) => Decoded::text(codec, t),
            Err(e) => Decoded::failed(codec, e.message),
        },
        CodecId::Json => match plain::decode_json(bytes) {
            Ok((t, j)) => Decoded::json(codec, t, j),
            Err(e) => Decoded::failed(codec, e.message),
        },
        CodecId::Hex => Decoded::text(codec, plain::decode_hex(bytes)),
        CodecId::Base64 => Decoded::text(codec, plain::decode_base64(bytes)),
        CodecId::Msgpack => match msgpack::decode(bytes) {
            Ok(j) => Decoded::json(codec, j.to_text(), j.to_value()),
            Err(e) => Decoded::failed(codec, e.message),
        },
        CodecId::Cbor => match cbor::decode(bytes) {
            Ok(j) => Decoded::json(codec, j.to_text(), j.to_value()),
            Err(e) => Decoded::failed(codec, e.message),
        },
        CodecId::Avro | CodecId::Protobuf | CodecId::Jsonschema => {
            Decoded::failed(codec, "needs a schema")
        }
    }
}

/// Steps (3) to (6) of auto-detect.
fn decode_plain_detected(bytes: &[u8]) -> Decoded {
    if plain::looks_like_json(bytes) {
        return decode_plain(CodecId::Json, bytes);
    }
    // MessagePack wins over CBOR only where both read the whole value (see `cbor`).
    let is_msgpack = msgpack::detect(bytes);
    if !is_msgpack && cbor::detect(bytes) {
        return decode_plain(CodecId::Cbor, bytes);
    }
    if is_msgpack {
        return decode_plain(CodecId::Msgpack, bytes);
    }
    if plain::looks_like_text(bytes) {
        return decode_plain(CodecId::Utf8, bytes);
    }
    decode_plain(CodecId::Hex, bytes)
}

/// The codec auto-detect would pick without a registry or mappings (steps 3 to 6).
pub fn detect_plain(bytes: &[u8]) -> CodecId {
    decode_plain_detected(bytes).codec
}
