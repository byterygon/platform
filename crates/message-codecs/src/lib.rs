//! Message model, codecs and schema sources shared by message tools (Mightyconsole spec §5): the
//! messaging core that NATS and Kafka use without either knowing the other.
//!
//! - [`message`]: one record for a Kafka record, a NATS message, a JetStream message or a KV
//!   entry, raw bytes always kept.
//! - [`codec`]: the codec registry: UTF-8, JSON, hex, base64, MessagePack, Avro, Protobuf
//!   (dynamic, from descriptors or `.proto` text compiled at run time) and JSON Schema; the
//!   auto-detect order; [`Codecs`], the codecs of one connected profile.
//! - [`schema`]: compiled schemas, local schemas from a profile, mappings to subjects, topics
//!   and buckets.
//! - [`registry`]: a Confluent Schema Registry client (wire format, references, caches).
//! - [`wire`]: the Confluent wire format; [`naming`]: subject naming strategies.
//!
//! The crate holds no tool code and opens no connection except to a registry the caller
//! configures. Licence: MIT OR Apache-2.0.

pub mod codec;
pub mod error;
pub mod message;
pub mod naming;
mod ojson;
pub mod registry;
pub mod schema;
pub mod types;
pub mod wire;

pub use codec::{CodecInfo, Codecs, CodecsConfig, Decoded, Encoded, ResolvedSchema, codec_list};
pub use error::{CodecError, ErrorKind, Position, Result};
pub use message::{Header, Message, Operation, TimestampKind};
pub use registry::{RegistryAuth, RegistryClient, RegistryConfig};
pub use schema::{CompiledSchema, LocalSchemas, subject_matches};
pub use types::*;
