//! Wire types: what a tool's procedures take and return about codecs and schemas (Mightyconsole
//! spec §4.2, §5.2, §5.3, §5.7). Plain serde types, camelCase on the wire; with the `codegen`
//! feature they also derive `ts_rs::TS` and `schemars::JsonSchema` for Ambidex codegen.
//!
//! Optional input fields are `#[serde(default)]` with `#[ts(optional = nullable)]`, optional output
//! fields `skip_serializing_if` with `#[ts(optional)]` (the repository's codegen rule).

use serde::{Deserialize, Serialize};

/// A codec id (spec §5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum CodecId {
    Utf8,
    Json,
    Hex,
    Base64,
    Msgpack,
    Cbor,
    Avro,
    Protobuf,
    Jsonschema,
}

impl CodecId {
    /// Every codec, in the order the codec selects list them.
    pub const ALL: [CodecId; 9] = [
        CodecId::Utf8,
        CodecId::Json,
        CodecId::Hex,
        CodecId::Base64,
        CodecId::Msgpack,
        CodecId::Cbor,
        CodecId::Avro,
        CodecId::Protobuf,
        CodecId::Jsonschema,
    ];

    /// The id as it appears on the wire and in the `payloadCodec` column.
    pub fn as_str(self) -> &'static str {
        match self {
            CodecId::Utf8 => "utf8",
            CodecId::Json => "json",
            CodecId::Hex => "hex",
            CodecId::Base64 => "base64",
            CodecId::Msgpack => "msgpack",
            CodecId::Cbor => "cbor",
            CodecId::Avro => "avro",
            CodecId::Protobuf => "protobuf",
            CodecId::Jsonschema => "jsonschema",
        }
    }

    /// The label the codec selects show.
    pub fn label(self) -> &'static str {
        match self {
            CodecId::Utf8 => "UTF-8 text",
            CodecId::Json => "JSON",
            CodecId::Hex => "Hex",
            CodecId::Base64 => "Base64",
            CodecId::Msgpack => "MessagePack",
            CodecId::Cbor => "CBOR",
            CodecId::Avro => "Avro",
            CodecId::Protobuf => "Protobuf",
            CodecId::Jsonschema => "JSON Schema",
        }
    }

    /// Whether the codec needs a schema (from the registry or the profile).
    pub fn needs_schema(self) -> bool {
        matches!(
            self,
            CodecId::Avro | CodecId::Protobuf | CodecId::Jsonschema
        )
    }

    /// The schema type the codec reads, if it needs one.
    pub fn schema_type(self) -> Option<SchemaType> {
        match self {
            CodecId::Avro => Some(SchemaType::Avro),
            CodecId::Protobuf => Some(SchemaType::Protobuf),
            CodecId::Jsonschema => Some(SchemaType::Jsonschema),
            _ => None,
        }
    }
}

impl std::fmt::Display for CodecId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// `"auto"` in a [`CodecChoice`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum Auto {
    Auto,
}

/// `"auto"` or a codec id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(untagged)]
pub enum CodecSelector {
    Auto(Auto),
    Codec(CodecId),
}

impl Default for CodecSelector {
    fn default() -> Self {
        CodecSelector::Auto(Auto::Auto)
    }
}

/// Which part of a message a codec reads or writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum Part {
    Key,
    Value,
}

impl Part {
    pub fn as_str(self) -> &'static str {
        match self {
            Part::Key => "key",
            Part::Value => "value",
        }
    }
}

/// Where a message lives, for mappings and subject naming: a Kafka topic, a NATS subject (core
/// or JetStream) or a KV bucket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Target {
    Topic {
        name: String,
    },
    /// A NATS subject; `stream` when the message was read from a JetStream stream.
    Subject {
        subject: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[cfg_attr(feature = "codegen", ts(optional = nullable))]
        stream: Option<String>,
    },
    KvBucket {
        bucket: String,
    },
}

impl Target {
    /// A NATS subject outside a stream (core NATS).
    pub fn subject(subject: impl Into<String>) -> Self {
        Target::Subject {
            subject: subject.into(),
            stream: None,
        }
    }

    /// A NATS subject read from a JetStream stream.
    pub fn stream_subject(stream: impl Into<String>, subject: impl Into<String>) -> Self {
        Target::Subject {
            subject: subject.into(),
            stream: Some(stream.into()),
        }
    }
}

/// A registry schema version: a number or `"latest"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(untagged)]
pub enum SchemaVersion {
    Number(u32),
    Latest(Latest),
}

/// `"latest"`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum Latest {
    Latest,
}

/// A schema in the registry, by id or by subject and version.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(untagged)]
pub enum RegistryRef {
    Id {
        id: u32,
    },
    Subject {
        subject: String,
        version: SchemaVersion,
    },
}

/// Where a schema comes from (spec §5.7): `{ registry: … }` or `{ local: schemaId }`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub enum SchemaRef {
    Registry(RegistryRef),
    Local(String),
}

/// The decoder for one part (spec §5.2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct CodecChoice {
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub codec: CodecSelector,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub schema: Option<SchemaRef>,
    /// Protobuf: the fully qualified message type.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub message_type: Option<String>,
}

impl CodecChoice {
    pub fn auto() -> Self {
        Self::default()
    }

    pub fn codec(codec: CodecId) -> Self {
        Self {
            codec: CodecSelector::Codec(codec),
            ..Self::default()
        }
    }
}

/// Sent by every message stream (spec §5.2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DecodeOptions {
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub key: CodecChoice,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub value: CodecChoice,
    /// Inline payload bytes per message; 1 MiB when absent.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub max_payload_bytes: Option<u32>,
}

/// The default inline payload cap (spec §5.1, Open question 9).
pub const DEFAULT_MAX_PAYLOAD_BYTES: usize = 1024 * 1024;

impl DecodeOptions {
    pub fn max_payload_bytes(&self) -> usize {
        self.max_payload_bytes
            .map_or(DEFAULT_MAX_PAYLOAD_BYTES, |n| n as usize)
    }

    pub fn choice(&self, part: Part) -> &CodecChoice {
        match part {
            Part::Key => &self.key,
            Part::Value => &self.value,
        }
    }
}

/// Whether encoding writes the Confluent wire format (spec §5.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum WireFormat {
    Confluent,
    None,
}

/// What the Composer sends for a key or a value (spec §5.7).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ComposePayload {
    pub codec: CodecId,
    /// What the user typed: text, JSON, hex or base64.
    pub text: String,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub schema: Option<SchemaRef>,
    /// Protobuf: the fully qualified message type.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub message_type: Option<String>,
    /// `confluent` by default when the schema comes from the registry.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub wire_format: Option<WireFormat>,
}

/// The type of a schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum SchemaType {
    Avro,
    Protobuf,
    Jsonschema,
}

impl SchemaType {
    pub fn codec(self) -> CodecId {
        match self {
            SchemaType::Avro => CodecId::Avro,
            SchemaType::Protobuf => CodecId::Protobuf,
            SchemaType::Jsonschema => CodecId::Jsonschema,
        }
    }

    /// The Schema Registry's `schemaType` (absent means Avro).
    pub fn registry_name(self) -> &'static str {
        match self {
            SchemaType::Avro => "AVRO",
            SchemaType::Protobuf => "PROTOBUF",
            SchemaType::Jsonschema => "JSON",
        }
    }

    pub fn from_registry_name(name: Option<&str>) -> Option<Self> {
        match name {
            None | Some("AVRO") => Some(SchemaType::Avro),
            Some("PROTOBUF") => Some(SchemaType::Protobuf),
            Some("JSON") => Some(SchemaType::Jsonschema),
            Some(_) => None,
        }
    }
}

/// One source file of a local schema.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SchemaFile {
    /// For Protobuf, the import path (`lab/common/money.proto`).
    pub path: String,
    pub text: String,
}

/// The sources of a local schema: files, or a compiled Protobuf `FileDescriptorSet`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(untagged)]
pub enum LocalSchemaFiles {
    Files(Vec<SchemaFile>),
    DescriptorSet {
        #[serde(rename = "descriptorSetBase64")]
        descriptor_set_base64: String,
    },
}

/// A schema the user added to a profile (spec §4.2, `extras.schemas`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct LocalSchema {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub schema_type: SchemaType,
    pub files: LocalSchemaFiles,
    /// Protobuf: the message types offered (all top-level messages of the first file when absent).
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub message_types: Option<Vec<String>>,
}

/// What a mapping applies to (spec §4.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MappingTarget {
    /// A NATS subject pattern with `*` and `>`, in core NATS and in JetStream.
    Subject {
        pattern: String,
    },
    /// The messages of a JetStream stream, whatever their subject.
    Stream {
        name: String,
    },
    Topic {
        name: String,
    },
    KvBucket {
        bucket: String,
    },
}

/// A codec, with a local schema when it needs one, mapped to messages (spec §4.2,
/// `extras.mappings`); the first mapping that matches a message wins.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SchemaMapping {
    pub id: String,
    pub target: MappingTarget,
    pub part: Part,
    /// The local schema, for Avro, Protobuf and JSON Schema; none for the codecs without one.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub schema_id: Option<String>,
    /// A schema from the profile's registry instead of a local one: a subject and version, or
    /// an id. With neither, a `confluent` mapping takes the id each message carries.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub registry: Option<RegistryRef>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub message_type: Option<String>,
    /// The codec; the schema's when absent (mappings saved before CBOR name a schema only).
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub codec: Option<CodecId>,
    /// `confluent`: the bytes start with the wire format's magic byte and schema id (and, for
    /// Protobuf, the message indexes), which are skipped. Raw bytes when absent.
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub wire_format: Option<WireFormat>,
}

impl SchemaMapping {
    /// The codec this mapping decodes with: its own, else its schema's type's (needs the
    /// compiled schemas, so the caller passes the schema's type).
    pub fn codec_with(&self, schema_type: Option<SchemaType>) -> Option<CodecId> {
        self.codec.or(schema_type.map(SchemaType::codec))
    }
}

/// A Kafka subject naming strategy (spec §5.3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
pub enum NamingStrategy {
    #[default]
    TopicNameStrategy,
    RecordNameStrategy,
    TopicRecordNameStrategy,
}

/// The profile's naming strategies: a default and per-topic overrides (`fields.namingStrategy`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct NamingConfig {
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub default: NamingStrategy,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub topics: Vec<TopicNaming>,
}

/// A per-topic naming strategy.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TopicNaming {
    pub topic: String,
    pub strategy: NamingStrategy,
}

/// TLS to a target (spec §4.2, `TlsOptions`); the client key comes separately, from `secrets`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TlsOptions {
    pub enabled: bool,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub ca_pem: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub client_cert_pem: Option<String>,
    #[serde(default)]
    #[cfg_attr(feature = "codegen", ts(optional = nullable))]
    pub server_name: Option<String>,
}

/// A problem found compiling a schema, with the file and line when known (spec §5.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SchemaIssue {
    /// The local schema's id, when the issue is about one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub schema_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub file: Option<String>,
    /// 1-based.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub line: Option<u32>,
    /// 1-based.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "codegen", ts(optional))]
    pub column: Option<u32>,
    pub message: String,
}

impl SchemaIssue {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            schema_id: None,
            file: None,
            line: None,
            column: None,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn wire_shapes() {
        let c: CodecChoice = serde_json::from_value(json!({ "codec": "auto" })).unwrap();
        assert_eq!(c, CodecChoice::auto());
        let c: CodecChoice = serde_json::from_value(json!({
            "codec": "protobuf",
            "schema": { "registry": { "subject": "orders-proto-value", "version": "latest" } },
            "messageType": "lab.orders.Order"
        }))
        .unwrap();
        assert_eq!(c.codec, CodecSelector::Codec(CodecId::Protobuf));
        assert_eq!(
            c.schema,
            Some(SchemaRef::Registry(RegistryRef::Subject {
                subject: "orders-proto-value".into(),
                version: SchemaVersion::Latest(Latest::Latest)
            }))
        );
        let s: SchemaRef = serde_json::from_value(json!({ "registry": { "id": 7 } })).unwrap();
        assert_eq!(s, SchemaRef::Registry(RegistryRef::Id { id: 7 }));
        let s: SchemaRef = serde_json::from_value(json!({ "local": "s1" })).unwrap();
        assert_eq!(s, SchemaRef::Local("s1".into()));
        let t: Target =
            serde_json::from_value(json!({ "kind": "kvBucket", "bucket": "config" })).unwrap();
        assert_eq!(
            t,
            Target::KvBucket {
                bucket: "config".into()
            }
        );
        let l: LocalSchema = serde_json::from_value(json!({
            "id": "s1", "name": "orders", "type": "protobuf",
            "files": { "descriptorSetBase64": "AA==" }
        }))
        .unwrap();
        assert!(matches!(l.files, LocalSchemaFiles::DescriptorSet { .. }));
        let n: NamingConfig = serde_json::from_value(json!({
            "default": "RecordNameStrategy",
            "topics": [{ "topic": "a", "strategy": "TopicRecordNameStrategy" }]
        }))
        .unwrap();
        assert_eq!(n.default, NamingStrategy::RecordNameStrategy);
    }
}
