//! The server's part of the messaging core (Mightyconsole spec §5): messages as Arrow batches
//! ([`arrow`]), live tail and browse ([`tail`]), a test backend ([`testing`]) and the shared
//! `messaging.*` procedures of §5.8. Codecs, schemas and the filter are `message_codecs`.
//!
//! A tool that carries messages (NATS, Kafka) gives its live handle a [`Codecs`] with
//! [`crate::core::Hub::set_codecs`] on connect; the `messaging.*` procedures that name a
//! `connId` use that handle's registry, local schemas and mappings, whatever the tool.

pub mod arrow;
pub mod record;
pub mod registry;
pub mod tail;
pub mod testing;

use std::sync::Arc;

use ambidex::{Ctx, RpcError, rpc};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use message_codecs::filter::{Filter, FilterIssue};
use message_codecs::inspect::{Inspection, inspect};
use message_codecs::schema::compile_local;
use message_codecs::{
    CodecError, CodecId, CodecInfo, CodecSelector, Codecs, CodecsConfig, ComposePayload,
    DecodeOptions, Decoded, ErrorKind, LocalSchema, MappingCount, Message, Part, SchemaIssue,
    SchemaMapping, SchemaRef, Target, codec_list,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use self::arrow::Row;
use super::{ErrorPosition, Hub, RemoteError, ToolError, ToolErrorKind, ToolResult};

/// The system name of the shared procedures' errors.
pub const SYSTEM: &str = "messaging";

/// A codec or registry error as a tool's error (spec §2.6).
pub fn tool_error(system: &str, e: CodecError) -> ToolError {
    let kind = match e.kind {
        ErrorKind::Invalid => ToolErrorKind::Invalid,
        ErrorKind::NotFound => ToolErrorKind::NotFound,
        ErrorKind::Connect => ToolErrorKind::Connect,
        ErrorKind::Auth => ToolErrorKind::Auth,
        ErrorKind::Tls => ToolErrorKind::Tls,
        ErrorKind::Forbidden => ToolErrorKind::Forbidden,
        ErrorKind::Conflict => ToolErrorKind::Conflict,
        ErrorKind::Remote => ToolErrorKind::Remote,
    };
    let mut t = ToolError::new(kind, system, e.message);
    t.field = e.field;
    t.position = e.position.map(|p| ErrorPosition {
        line: p.line,
        column: p.column,
    });
    if kind == ToolErrorKind::NotFound {
        t.resource = Some("schema".into());
    }
    if let Some(r) = e.remote {
        t.remote = Some(RemoteError {
            code: r.code,
            name: None,
            detail: r.detail,
        });
    }
    t
}

/// Decodes one message for a batch: the key and the value with their choices, the payload cut
/// at the inline cap (spec §5.1). A payload over the cap is not decoded: its first bytes are
/// shown as text when they read as text, and "Load full payload" fetches the rest.
pub async fn decode_row(
    codecs: &Codecs,
    message: Message,
    opts: &DecodeOptions,
    target: Option<&Target>,
    row_id: u64,
) -> Row {
    let key = match &message.key {
        Some(k) => Some(codecs.decode(k, target, Part::Key, &opts.key).await),
        None => None,
    };
    let cap = opts.max_payload_bytes();
    let (value, inline_len) = if message.tombstone {
        (
            Decoded {
                codec: CodecId::Utf8,
                text: None,
                json: None,
                schema_ref: None,
                error: None,
            },
            0,
        )
    } else if message.payload.len() > cap {
        (
            truncated(&message.payload[..cap], message.payload.len()),
            cap,
        )
    } else {
        (
            codecs
                .decode(&message.payload, target, Part::Value, &opts.value)
                .await,
            message.payload.len(),
        )
    };
    let filter_value = value.value();
    Row {
        row_id,
        message,
        key,
        value,
        inline_len,
        filter_value,
    }
}

fn truncated(prefix: &[u8], size: usize) -> Decoded {
    let cut = match std::str::from_utf8(prefix) {
        Ok(s) => s.len(),
        Err(e) if e.error_len().is_none() => e.valid_up_to(), // a character cut at the end
        Err(_) => 0,
    };
    let text = (cut > 0 && message_codecs::codec::plain::looks_like_text(&prefix[..cut]))
        .then(|| String::from_utf8_lossy(&prefix[..cut]).into_owned());
    Decoded {
        codec: if text.is_some() {
            CodecId::Utf8
        } else {
            CodecId::Hex
        },
        text,
        json: None,
        schema_ref: None,
        error: Some(format!(
            "the payload is {size} bytes; the first {} are shown (Load full payload)",
            prefix.len()
        )),
    }
}

/// The codecs of `connId`, or plain codecs without one.
fn codecs_for(hub: &Hub, session: &str, conn_id: Option<&str>) -> Result<Codecs, ToolError> {
    match conn_id.filter(|c| !c.is_empty()) {
        Some(c) => hub.codecs(session, c),
        None => Ok(Codecs::default()),
    }
}

// --- Wire types -------------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecodeInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub conn_id: Option<String>,
    /// The bytes, base64.
    pub bytes: String,
    pub part: Part,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub target: Option<Target>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub choice: Option<message_codecs::CodecChoice>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DecodeOutput {
    pub codec: CodecId,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub json: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schema_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

impl From<Decoded> for DecodeOutput {
    fn from(d: Decoded) -> Self {
        Self {
            codec: d.codec,
            text: d.text,
            json: d.json,
            schema_ref: d.schema_ref,
            error: d.error,
        }
    }
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EncodeInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub conn_id: Option<String>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub target: Option<Target>,
    pub part: Part,
    pub payload: ComposePayload,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EncodeOutput {
    /// The bytes, base64.
    pub bytes: String,
    pub size: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schema_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub schema_ref: Option<String>,
}

/// A schema to inspect: a reference, or a local schema not saved yet (the schema editor).
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(untagged)]
pub enum InspectSchema {
    Local(LocalSchema),
    Ref(SchemaRef),
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct InspectInput {
    #[serde(default)]
    #[ts(optional = nullable)]
    pub conn_id: Option<String>,
    pub schema: InspectSchema,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub message_type: Option<String>,
}

/// `messaging.query`: a jq program on a JSON value the UI shows (the message detail's Query bar
/// and Profile, spec §5.6), run in a worker with the limits of §5.4.1.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueryInput {
    /// The value's JSON text, at most 8 MiB.
    pub text: String,
    /// A jq program, run by jaq.
    pub jq: String,
    /// The deadline in milliseconds (the user's setting); 2 s when absent, clamped to 0.5 to 30 s.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct QueryOutput {
    /// The program's outputs, in order.
    #[ts(type = "unknown[]")]
    #[schemars(with = "Vec<serde_json::Value>")]
    pub results: Vec<serde_json::Value>,
    /// How many outputs `results` holds.
    pub count: u32,
    /// The results' JSON text, in bytes.
    pub bytes: u64,
    /// Why the run returned before the program ended: the 1 MiB cap, or the deadline.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stopped: Option<super::jq::Stopped>,
    pub ms: u64,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilterCheckInput {
    pub filter: Filter,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FilterCheckOutput {
    pub ok: bool,
    pub errors: Vec<FilterIssue>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemasUpdateInput {
    pub conn_id: String,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schemas: Option<Vec<LocalSchema>>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub mappings: Option<Vec<SchemaMapping>>,
}

#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemasUpdateOutput {
    /// Schemas that do not compile, with file and line; the others are in use.
    pub issues: Vec<SchemaIssue>,
}

#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemasStatusInput {
    pub conn_id: String,
}

/// A local schema in use on a connection.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemaStatus {
    pub id: String,
    /// Protobuf: the message types offered; empty for the other types.
    pub message_types: Vec<String>,
}

/// A mapping's counts this session.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MappingStatus {
    pub id: String,
    pub count: MappingCount,
}

/// What a connection's codecs hold now (the Schemas tab).
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SchemasStatusOutput {
    /// The schemas that compiled, in id order.
    pub schemas: Vec<SchemaStatus>,
    /// Schemas that do not compile, with file and line.
    pub issues: Vec<SchemaIssue>,
    /// Every mapping, in order, with what it decoded.
    pub mappings: Vec<MappingStatus>,
    /// The registry the connection uses, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub registry_url: Option<String>,
}

/// Messages a mapping test decodes by default and at most.
pub const MAPPING_TEST_DEFAULT: u32 = 20;
pub const MAPPING_TEST_MAX: u32 = 100;
/// Decoded text a test row keeps.
const MAPPING_TEST_TEXT: usize = 400;

/// A tool's `<tool>.schemas.test` input: a mapping, maybe not saved, tried on the last messages
/// it matches.
#[derive(Debug, Clone, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MappingTestInput {
    pub conn_id: String,
    pub mapping: SchemaMapping,
    /// The profile's schemas as edited (the saved ones when absent).
    #[serde(default)]
    #[ts(optional = nullable)]
    pub schemas: Option<Vec<LocalSchema>>,
    /// How many messages, 20 by default, 100 at most.
    #[serde(default)]
    #[ts(optional = nullable)]
    pub limit: Option<u32>,
}

impl MappingTestInput {
    pub fn limit(&self) -> usize {
        self.limit
            .unwrap_or(MAPPING_TEST_DEFAULT)
            .clamp(1, MAPPING_TEST_MAX) as usize
    }
}

/// One message of a mapping test.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MappingTestRow {
    /// Where the message lives: its subject, or its KV key.
    pub subject: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sequence: Option<u64>,
    pub codec: CodecId,
    /// The decoded value, cut at 400 characters; hex when it failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// What a mapping test found.
#[derive(Debug, Clone, Serialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct MappingTestOutput {
    /// What was read, in the tool's words ("streams ORDERS, AUDIT").
    pub source: String,
    /// The oldest first.
    pub rows: Vec<MappingTestRow>,
    pub decoded: u32,
    pub failed: u32,
    /// Problems of the mapping's schema as edited.
    pub issues: Vec<SchemaIssue>,
    /// Why there are no messages, when there are none.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
}

/// A message a tool sampled for a mapping test.
pub struct MappingSample {
    pub subject: String,
    pub sequence: Option<u64>,
    pub payload: Vec<u8>,
}

/// Decodes a tool's samples with a mapping (shared by `nats.schemas.test` and Kafka's): the
/// connection's registry, the schemas as edited, and only this mapping, so nothing is counted.
pub async fn test_mapping(
    base: &Codecs,
    input: &MappingTestInput,
    source: String,
    samples: Vec<MappingSample>,
    note: Option<String>,
) -> MappingTestOutput {
    let codecs = match &input.schemas {
        Some(schemas) => Codecs::new(CodecsConfig {
            registry: base.registry().cloned(),
            local_schemas: schemas.clone(),
            naming: base.naming().clone(),
            ..CodecsConfig::default()
        }),
        None => base.clone(),
    };
    let issues = match &input.mapping.schema_id {
        Some(id) => codecs
            .issues()
            .iter()
            .filter(|i| i.schema_id.as_deref() == Some(id.as_str()))
            .cloned()
            .collect(),
        None => Vec::new(),
    };
    let mut failed = 0;
    let mut rows = Vec::with_capacity(samples.len());
    for s in samples {
        let d = codecs.decode_mapping(&input.mapping, &s.payload).await;
        if d.error.is_some() {
            failed += 1;
        }
        rows.push(MappingTestRow {
            subject: s.subject,
            sequence: s.sequence,
            codec: d.codec,
            text: d.text.map(|t| cut(t, MAPPING_TEST_TEXT)),
            error: d.error,
        });
    }
    let decoded = rows.len() as u32 - failed;
    MappingTestOutput {
        source,
        note: if rows.is_empty() { note } else { None },
        rows,
        decoded,
        failed,
        issues,
    }
}

fn cut(mut text: String, max: usize) -> String {
    if text.chars().count() > max {
        text = text.chars().take(max).collect();
        text.push('…');
    }
    text
}

// --- Procedures -------------------------------------------------------------------------------

/// `messaging.decode`, `messaging.encode` and `messaging.query`.
pub struct MessagingApi(pub Arc<Hub>);

#[rpc::router(namespace = "messaging")]
impl MessagingApi {
    /// Decodes bytes with a codec choice (previews and tests; streams decode in place).
    #[rpc::query(perm = "messaging.read", risk = Risk::Read)]
    async fn decode(&self, ctx: Ctx, input: DecodeInput) -> ToolResult<DecodeOutput> {
        let codecs = codecs_for(&self.0, &ctx.session().id, input.conn_id.as_deref())?;
        let bytes = BASE64
            .decode(input.bytes.trim())
            .map_err(|e| ToolError::invalid(SYSTEM, "bytes", format!("not valid base64: {e}")))?;
        let choice = input.choice.unwrap_or_default();
        Ok(codecs
            .decode(&bytes, input.target.as_ref(), input.part, &choice)
            .await
            .into())
    }

    /// Encodes a Composer payload (Validate): the bytes and their size.
    #[rpc::query(perm = "messaging.read", risk = Risk::Read)]
    async fn encode(&self, ctx: Ctx, input: EncodeInput) -> ToolResult<EncodeOutput> {
        let codecs = codecs_for(&self.0, &ctx.session().id, input.conn_id.as_deref())?;
        let e = codecs
            .encode(input.target.as_ref(), input.part, &input.payload)
            .await
            .map_err(|e| tool_error(SYSTEM, e))?;
        Ok(EncodeOutput {
            size: e.bytes.len() as u64,
            bytes: BASE64.encode(&e.bytes),
            schema_id: e.schema_id,
            schema_ref: e.schema_ref,
        })
    }

    /// Runs a jq program on a JSON value in a worker (spec §5.4.1); only the results travel back.
    #[rpc::query(
        perm = "messaging.read",
        risk = Risk::Read,
        timeout_default = "35s",
        timeout_max = "35s"
    )]
    async fn query(&self, _ctx: Ctx, input: QueryInput) -> ToolResult<QueryOutput> {
        let out = super::jq::run(
            SYSTEM,
            &input.jq,
            input.text.into_bytes(),
            super::jq::MAX_TEXT_INPUT_BYTES,
            super::jq::timeout(input.timeout_ms),
        )
        .await?;
        Ok(QueryOutput {
            count: out.results.len() as u32,
            results: out.results,
            bytes: out.bytes as u64,
            stopped: out.stopped,
            ms: out.ms,
        })
    }
}

/// `messaging.codecs.list`.
pub struct CodecsApi(pub Arc<Hub>);

#[rpc::router(namespace = "messaging.codecs")]
impl CodecsApi {
    /// Every codec, for the codec selects.
    #[rpc::query(perm = "messaging.read", risk = Risk::Read)]
    async fn list(&self, _ctx: Ctx, _input: super::Empty) -> Result<Vec<CodecInfo>, RpcError> {
        Ok(codec_list())
    }
}

/// `messaging.schemas.inspect` and `messaging.schemas.update`.
pub struct SchemasApi(pub Arc<Hub>);

#[rpc::router(namespace = "messaging.schemas")]
impl SchemasApi {
    /// A schema as JSON Schema with an example; a local schema's compile errors with file and
    /// line in `errors`.
    #[rpc::query(perm = "messaging.read", risk = Risk::Read)]
    async fn inspect(&self, ctx: Ctx, input: InspectInput) -> ToolResult<Inspection> {
        let (compiled, text) = match &input.schema {
            InspectSchema::Local(local) => match compile_local(local) {
                Ok(c) => (Arc::new(c), local_text(local)),
                Err(errors) => {
                    return Ok(Inspection {
                        schema_type: local.schema_type,
                        message_types: Vec::new(),
                        all_message_types: Vec::new(),
                        json_schema: serde_json::json!({}),
                        example: String::new(),
                        text: local_text(local),
                        errors,
                    });
                }
            },
            InspectSchema::Ref(r) => {
                let codecs = codecs_for(&self.0, &ctx.session().id, input.conn_id.as_deref())?;
                let resolved = codecs.resolve(r).await.map_err(|e| tool_error(SYSTEM, e))?;
                let text = match (r, codecs.registry()) {
                    (SchemaRef::Registry(_), Some(reg)) => match resolved.registry_id {
                        Some(id) => reg
                            .schema_by_id(id)
                            .await
                            .map(|s| s.schema.clone())
                            .unwrap_or_default(),
                        None => String::new(),
                    },
                    _ => String::new(),
                };
                (resolved.compiled, text)
            }
        };
        let mut out =
            inspect(&compiled, input.message_type.as_deref()).map_err(|e| tool_error(SYSTEM, e))?;
        if !text.is_empty() {
            out.text = text;
        }
        Ok(out)
    }

    /// The connection's schemas in use, the ones that do not compile, and every mapping with
    /// what it decoded this session.
    #[rpc::query(perm = "messaging.read", risk = Risk::Read)]
    async fn status(&self, ctx: Ctx, input: SchemasStatusInput) -> ToolResult<SchemasStatusOutput> {
        let codecs = self.0.codecs(&ctx.session().id, &input.conn_id)?;
        let mut ids: Vec<&str> = codecs.local().ids().collect();
        ids.sort_unstable();
        let schemas = ids
            .into_iter()
            .map(|id| SchemaStatus {
                id: id.to_owned(),
                message_types: codecs
                    .local()
                    .get(id)
                    .map(|c| c.message_types())
                    .unwrap_or_default(),
            })
            .collect();
        let mappings = codecs
            .mappings()
            .iter()
            .map(|m| MappingStatus {
                id: m.id.clone(),
                count: codecs.stats().get(&m.id),
            })
            .collect();
        Ok(SchemasStatusOutput {
            schemas,
            issues: codecs.issues().to_vec(),
            mappings,
            registry_url: codecs.registry().map(|r| r.url()),
        })
    }

    /// Replaces a connection's local schemas and mappings (the profile changed); the registry
    /// and the mappings' counts stay. Streams already running keep the codecs they started with.
    #[rpc::mutation(perm = "messaging.read", risk = Risk::Read)]
    async fn update(&self, ctx: Ctx, input: SchemasUpdateInput) -> ToolResult<SchemasUpdateOutput> {
        let session = &ctx.session().id;
        let current = self.0.codecs(session, &input.conn_id)?;
        let codecs = Codecs::new(message_codecs::CodecsConfig {
            registry: current.registry().cloned(),
            local_schemas: input.schemas.unwrap_or_default(),
            mappings: input.mappings.unwrap_or_default(),
            naming: current.naming().clone(),
            stats: current.stats().clone(),
            wire_format_on: current.wire_format_on().map(<[String]>::to_vec),
        });
        let issues = codecs.issues().to_vec();
        self.0.set_codecs(session, &input.conn_id, codecs)?;
        Ok(SchemasUpdateOutput { issues })
    }
}

fn local_text(local: &LocalSchema) -> String {
    match &local.files {
        message_codecs::LocalSchemaFiles::Files(files) => {
            files.first().map(|f| f.text.clone()).unwrap_or_default()
        }
        message_codecs::LocalSchemaFiles::DescriptorSet { .. } => String::new(),
    }
}

/// `messaging.filter.check`.
pub struct FilterApi(pub Arc<Hub>);

#[rpc::router(namespace = "messaging.filter")]
impl FilterApi {
    /// Compiles a filter; each problem names its part and, for jq, the line and column.
    #[rpc::query(perm = "messaging.read", risk = Risk::Read)]
    async fn check(
        &self,
        _ctx: Ctx,
        input: FilterCheckInput,
    ) -> Result<FilterCheckOutput, RpcError> {
        let errors = message_codecs::filter::check(&input.filter);
        Ok(FilterCheckOutput {
            ok: errors.is_empty(),
            errors,
        })
    }
}

/// Mounts the `messaging.*` procedures.
pub fn mount(router: &ambidex::Router, hub: &Arc<Hub>) -> Result<(), ambidex::RegistryError> {
    router.mount(MessagingApi(Arc::clone(hub)))?;
    router.mount(CodecsApi(Arc::clone(hub)))?;
    router.mount(SchemasApi(Arc::clone(hub)))?;
    router.mount(FilterApi(Arc::clone(hub)))?;
    router.mount(registry::RegistryApi(Arc::clone(hub)))?;
    Ok(())
}

/// The codec ids for `app.info`.
pub fn codec_ids() -> Vec<String> {
    CodecId::ALL.iter().map(|c| c.as_str().to_owned()).collect()
}

/// Whether a codec choice names a schema codec without a schema (for tools' input checks).
pub fn needs_schema_without_one(choice: &message_codecs::CodecChoice) -> bool {
    matches!(choice.codec, CodecSelector::Codec(c) if c.needs_schema()) && choice.schema.is_none()
}

#[cfg(test)]
mod tests {
    use super::*;
    use message_codecs::TimestampKind;

    #[tokio::test]
    async fn a_large_payload_is_cut_and_not_decoded() {
        let codecs = Codecs::default();
        let mut m = Message::new("t", vec![b'a'; 2 * 1024 * 1024], 0, TimestampKind::Stored);
        m.key = Some(b"k".to_vec());
        let row = decode_row(&codecs, m, &DecodeOptions::default(), None, 0).await;
        assert_eq!(row.inline_len, 1024 * 1024);
        assert_eq!(row.value.codec, CodecId::Utf8);
        assert_eq!(row.value.text.as_ref().map(String::len), Some(1024 * 1024));
        assert!(
            row.value
                .error
                .as_deref()
                .unwrap()
                .contains("2097152 bytes")
        );
        assert_eq!(row.key.unwrap().text.as_deref(), Some("k"));

        let bin = Message::new("t", vec![0u8; 20], 0, TimestampKind::Stored);
        let opts = DecodeOptions {
            max_payload_bytes: Some(8),
            ..DecodeOptions::default()
        };
        let row = decode_row(&codecs, bin, &opts, None, 1).await;
        assert_eq!(
            (row.value.codec, row.value.text.is_none(), row.inline_len),
            (CodecId::Hex, true, 8)
        );
    }

    #[test]
    fn codec_errors_keep_field_position_and_remote() {
        let mut e = CodecError::invalid("bad")
            .field("value")
            .at(message_codecs::Position { line: 2, column: 3 });
        e.remote = Some(message_codecs::error::RemoteCode {
            code: "42201".into(),
            detail: None,
        });
        let t = tool_error("kafka", e);
        assert_eq!(t.kind, ToolErrorKind::Invalid);
        assert_eq!(t.field.as_deref(), Some("value"));
        assert_eq!(t.position, Some(ErrorPosition { line: 2, column: 3 }));
        assert_eq!(t.remote.unwrap().code, "42201");
        let t = tool_error("kafka", CodecError::not_found("no subject"));
        assert_eq!(t.resource.as_deref(), Some("schema"));
    }
}
