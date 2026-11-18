//! Protobuf (Mightyconsole spec §5.2, decision 11): dynamic messages from descriptors
//! (`prost-reflect`), `.proto` text compiled at run time by `protox` (no `protoc`). Decoded to
//! proto3 canonical JSON; encoded from canonical JSON with a message type.
//!
//! The Confluent wire format names the message by indexes into the schema's main file
//! ([`crate::wire`]); [`ProtoSchema::message_by_indexes`] and [`ProtoSchema::indexes_of`] map
//! between the two.

use std::collections::HashMap;

use prost::Message as _;
use prost_reflect::{DescriptorPool, DynamicMessage, MessageDescriptor};
use protox::file::{ChainFileResolver, File, FileResolver, GoogleFileResolver};

use crate::error::Position;
use crate::types::{SchemaFile, SchemaIssue};
use crate::{CodecError, Result};

/// A compiled set of Protobuf files.
#[derive(Debug, Clone)]
pub struct ProtoSchema {
    pub pool: DescriptorPool,
    /// The file the schema is about (the registry schema, or the first local file); `None` for
    /// a descriptor set.
    pub main_file: Option<String>,
    /// The message types offered, fully qualified.
    pub message_types: Vec<String>,
}

struct MemoryResolver {
    files: HashMap<String, String>,
}

impl FileResolver for MemoryResolver {
    fn open_file(&self, name: &str) -> std::result::Result<File, protox::Error> {
        match self.files.get(name) {
            Some(text) => File::from_source(name, text),
            None => Err(protox::Error::file_not_found(name)),
        }
    }
}

impl ProtoSchema {
    /// Compiles `.proto` files held in memory. The first file is the main one; every file is
    /// compiled so its messages can be chosen. Imports resolve among the files and Google's
    /// well-known types.
    pub fn compile(
        files: &[SchemaFile],
        message_types: Option<&[String]>,
    ) -> std::result::Result<Self, Vec<SchemaIssue>> {
        let Some(main) = files.first() else {
            return Err(vec![SchemaIssue::new(
                "a Protobuf schema needs at least one .proto file",
            )]);
        };
        let sources: HashMap<String, String> = files
            .iter()
            .map(|f| (f.path.clone(), f.text.clone()))
            .collect();
        let mut chain = ChainFileResolver::new();
        chain.add(MemoryResolver {
            files: sources.clone(),
        });
        chain.add(GoogleFileResolver::new());
        let mut compiler = protox::Compiler::with_file_resolver(chain);
        compiler.include_imports(true);
        let names: Vec<&str> = files.iter().map(|f| f.path.as_str()).collect();
        if let Err(e) = compiler.open_files(&names) {
            return Err(vec![proto_issue(&e, &sources)]);
        }
        let pool = compiler.descriptor_pool();
        Self::finish(pool, Some(main.path.clone()), message_types)
    }

    /// Reads a compiled `FileDescriptorSet` (`protoc --include_imports -o`).
    pub fn from_descriptor_set(
        bytes: &[u8],
        message_types: Option<&[String]>,
    ) -> std::result::Result<Self, Vec<SchemaIssue>> {
        let pool = DescriptorPool::decode(bytes).map_err(|e| {
            vec![SchemaIssue::new(format!(
                "not a valid FileDescriptorSet: {e}"
            ))]
        })?;
        Self::finish(pool, None, message_types)
    }

    fn finish(
        pool: DescriptorPool,
        main_file: Option<String>,
        message_types: Option<&[String]>,
    ) -> std::result::Result<Self, Vec<SchemaIssue>> {
        let message_types = match message_types {
            Some(types) if !types.is_empty() => {
                let missing: Vec<SchemaIssue> = types
                    .iter()
                    .filter(|t| pool.get_message_by_name(t).is_none())
                    .map(|t| SchemaIssue::new(format!("message type {t} is not defined")))
                    .collect();
                if !missing.is_empty() {
                    return Err(missing);
                }
                types.to_vec()
            }
            _ => {
                let files: Vec<_> = match &main_file {
                    Some(name) => pool.get_file_by_name(name).into_iter().collect(),
                    None => pool
                        .files()
                        .filter(|f| !f.name().starts_with("google/protobuf/"))
                        .collect(),
                };
                files
                    .iter()
                    .flat_map(|f| {
                        f.messages()
                            .map(|m| m.full_name().to_owned())
                            .collect::<Vec<_>>()
                    })
                    .collect()
            }
        };
        if message_types.is_empty() {
            return Err(vec![SchemaIssue::new("the schema defines no message type")]);
        }
        Ok(Self {
            pool,
            main_file,
            message_types,
        })
    }

    /// A message type by name; the first offered one when `name` is `None`.
    pub fn message(&self, name: Option<&str>) -> Result<MessageDescriptor> {
        let name = name.unwrap_or(&self.message_types[0]);
        self.pool.get_message_by_name(name).ok_or_else(|| {
            CodecError::invalid(format!("message type {name} is not defined in the schema"))
        })
    }

    /// The message the Confluent message indexes name, in the main file.
    pub fn message_by_indexes(&self, indexes: &[i32]) -> Result<MessageDescriptor> {
        let file = self
            .main_file
            .as_deref()
            .and_then(|n| self.pool.get_file_by_name(n))
            .ok_or_else(|| {
                CodecError::invalid("the schema has no main file for message indexes")
            })?;
        let bad = || {
            CodecError::invalid(format!(
                "message indexes {indexes:?} name no message of {}",
                file.name()
            ))
        };
        let (&first, rest) = indexes.split_first().ok_or_else(bad)?;
        let mut msg = file
            .messages()
            .nth(usize::try_from(first).map_err(|_| bad())?)
            .ok_or_else(bad)?;
        for &i in rest {
            let next = msg
                .child_messages()
                .nth(usize::try_from(i).map_err(|_| bad())?);
            msg = next.ok_or_else(bad)?;
        }
        Ok(msg)
    }

    /// The Confluent message indexes of a message of the main file.
    pub fn indexes_of(&self, msg: &MessageDescriptor) -> Result<Vec<i32>> {
        let mut chain = vec![msg.clone()];
        while let Some(parent) = chain.last().and_then(MessageDescriptor::parent_message) {
            chain.push(parent);
        }
        chain.reverse();
        let top = &chain[0];
        if self.main_file.as_deref() != Some(top.parent_file().name()) {
            return Err(CodecError::invalid(format!(
                "{} is not defined in the schema's main file, so the wire format cannot name it",
                msg.full_name()
            )));
        }
        let mut out = Vec::with_capacity(chain.len());
        let pos = top
            .parent_file()
            .messages()
            .position(|m| m == *top)
            .expect("a file's own message");
        out.push(pos as i32);
        for pair in chain.windows(2) {
            let pos = pair[0]
                .child_messages()
                .position(|m| m == pair[1])
                .expect("a message's own child");
            out.push(pos as i32);
        }
        Ok(out)
    }

    /// Decodes a message to canonical JSON: the text (field order kept) and the value.
    pub fn decode(
        &self,
        msg: &MessageDescriptor,
        bytes: &[u8],
    ) -> Result<(String, serde_json::Value)> {
        let m = DynamicMessage::decode(msg.clone(), bytes).map_err(|e| {
            CodecError::invalid(format!("not a valid {} message: {e}", msg.full_name()))
        })?;
        let text = serde_json::to_string(&m)
            .map_err(|e| CodecError::invalid(format!("Protobuf to JSON: {e}")))?;
        let value = serde_json::from_str(&text)
            .map_err(|e| CodecError::invalid(format!("Protobuf to JSON: {e}")))?;
        Ok((text, value))
    }

    /// Encodes canonical JSON text as a message.
    pub fn encode(&self, msg: &MessageDescriptor, text: &str) -> Result<Vec<u8>> {
        let mut de = serde_json::Deserializer::from_str(text);
        let m = DynamicMessage::deserialize(msg.clone(), &mut de).map_err(|e| {
            let mut err =
                CodecError::invalid(format!("not a valid {} in JSON: {e}", msg.full_name()));
            if e.line() > 0 {
                err.position = Some(Position {
                    line: e.line() as u32,
                    column: e.column() as u32,
                });
            }
            err
        })?;
        de.end().map_err(|e| CodecError::json(&e))?;
        Ok(m.encode_to_vec())
    }
}

/// A protox error as an issue with its file, line and column.
fn proto_issue(e: &protox::Error, sources: &HashMap<String, String>) -> SchemaIssue {
    use miette::Diagnostic as _;
    let mut issue = SchemaIssue::new(e.to_string());
    issue.file = e.file().map(str::to_owned);
    let offset = e.labels().and_then(|mut l| l.next()).map(|l| l.offset());
    if let (Some(offset), Some(text)) = (offset, issue.file.as_ref().and_then(|f| sources.get(f))) {
        let p = Position::of_offset(text, offset);
        issue.line = Some(p.line);
        issue.column = Some(p.column);
    }
    issue
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn lab_files() -> Vec<SchemaFile> {
        vec![
            SchemaFile {
                path: "lab/orders/order.proto".into(),
                text: include_str!("../../tests/fixtures/order.proto").into(),
            },
            SchemaFile {
                path: "lab/common/money.proto".into(),
                text: include_str!("../../tests/fixtures/money.proto").into(),
            },
        ]
    }

    #[test]
    fn canonical_json_round_trip_with_imports() {
        let s = ProtoSchema::compile(&lab_files(), None).unwrap();
        assert_eq!(s.message_types, vec!["lab.orders.Order"]);
        let msg = s.message(None).unwrap();
        let text = r#"{"id":"o-1","customer":"c","total":{"currency":"EUR","units":"9007199254740993","nanos":5},"items":["a","b"],"status":"PAID"}"#;
        let bytes = s.encode(&msg, text).unwrap();
        let (out, value) = s.decode(&msg, &bytes).unwrap();
        // int64 is a string in canonical JSON; enums are names.
        assert_eq!(out, text);
        assert_eq!(value["status"], "PAID");
        assert_eq!(s.indexes_of(&msg).unwrap(), vec![0]);
        assert_eq!(
            s.message_by_indexes(&[0]).unwrap().full_name(),
            "lab.orders.Order"
        );
    }

    #[test]
    fn nested_indexes() {
        let files = vec![SchemaFile {
            path: "n.proto".into(),
            text: "syntax = \"proto3\"; package n; message A { message B {} message C { message D { int32 x = 1; } } } message E {}".into(),
        }];
        let s = ProtoSchema::compile(&files, None).unwrap();
        assert_eq!(s.message_types, vec!["n.A", "n.E"]);
        let d = s.pool.get_message_by_name("n.A.C.D").unwrap();
        assert_eq!(s.indexes_of(&d).unwrap(), vec![0, 1, 0]);
        assert_eq!(
            s.message_by_indexes(&[0, 1, 0]).unwrap().full_name(),
            "n.A.C.D"
        );
        assert_eq!(s.message_by_indexes(&[1]).unwrap().full_name(), "n.E");
        assert!(s.message_by_indexes(&[2]).is_err());
        assert_eq!(
            s.decode(&d, &s.encode(&d, r#"{"x":-3}"#).unwrap())
                .unwrap()
                .0,
            r#"{"x":-3}"#
        );
    }

    #[test]
    fn errors_name_file_and_line() {
        let files = vec![
            SchemaFile {
                path: "a.proto".into(),
                text: "syntax = \"proto3\";\nimport \"b.proto\";\nmessage A { B b = 1; }\n".into(),
            },
            SchemaFile {
                path: "b.proto".into(),
                text: "syntax = \"proto3\";\n\nmessage B {\n  int32 x = 1\n}\n".into(),
            },
        ];
        let issues = ProtoSchema::compile(&files, None).unwrap_err();
        assert_eq!(issues[0].file.as_deref(), Some("b.proto"));
        assert_eq!(issues[0].line, Some(5), "{issues:?}");

        let missing = vec![SchemaFile {
            path: "a.proto".into(),
            text: "syntax = \"proto3\";\nimport \"nope.proto\";\n".into(),
        }];
        let issues = ProtoSchema::compile(&missing, None).unwrap_err();
        assert!(issues[0].message.contains("nope.proto"), "{issues:?}");
        assert_eq!(issues[0].line, Some(2));

        let s = ProtoSchema::compile(&lab_files(), None).unwrap();
        let msg = s.message(None).unwrap();
        let e = s.encode(&msg, "{\n \"nope\": 1}").unwrap_err();
        assert_eq!(e.position.map(|p| p.line), Some(2), "{e}");
        assert!(ProtoSchema::compile(&lab_files(), Some(&["lab.Missing".into()])).is_err());
    }

    #[test]
    fn descriptor_set() {
        let s = ProtoSchema::compile(&lab_files(), None).unwrap();
        let fds = prost_reflect::prost_types::FileDescriptorSet {
            file: s.pool.file_descriptor_protos().cloned().collect(),
        };
        let bytes = fds.encode_to_vec();
        let d = ProtoSchema::from_descriptor_set(&bytes, None).unwrap();
        assert!(d.message_types.contains(&"lab.orders.Order".to_owned()));
        assert!(d.message_types.contains(&"lab.common.Money".to_owned()));
        assert!(ProtoSchema::from_descriptor_set(b"\xff\xff", None).is_err());
    }
}
