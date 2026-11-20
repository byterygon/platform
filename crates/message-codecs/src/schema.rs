//! Compiled schemas and local schemas (Mightyconsole spec §5.3).
//!
//! A [`CompiledSchema`] is what a schema codec needs: an Avro schema with its named references,
//! a Protobuf descriptor pool, or a JSON Schema validator. Local schemas come from the profile
//! (`extras.schemas`) and are compiled on connect and on change; registry schemas are compiled
//! once per id ([`crate::registry`]).

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;

use crate::codec::avro::AvroSchema;
use crate::codec::jsonschema::JsonSchemaSchema;
use crate::codec::protobuf::ProtoSchema;
use crate::error::Position;
use crate::types::{
    LocalSchema, LocalSchemaFiles, MappingTarget, Part, SchemaFile, SchemaIssue, SchemaMapping,
    SchemaType, Target,
};

/// A schema ready for a codec.
#[derive(Debug, Clone)]
pub enum CompiledSchema {
    Avro(AvroSchema),
    Protobuf(ProtoSchema),
    JsonSchema(JsonSchemaSchema),
}

impl CompiledSchema {
    pub fn schema_type(&self) -> SchemaType {
        match self {
            CompiledSchema::Avro(_) => SchemaType::Avro,
            CompiledSchema::Protobuf(_) => SchemaType::Protobuf,
            CompiledSchema::JsonSchema(_) => SchemaType::Jsonschema,
        }
    }

    /// The record's fully qualified name for the record naming strategies (Avro record,
    /// Protobuf message, JSON Schema `title`).
    pub fn record_name(&self, message_type: Option<&str>) -> Option<String> {
        match self {
            CompiledSchema::Avro(s) => s.record_name(),
            CompiledSchema::Protobuf(s) => message_type
                .map(str::to_owned)
                .or_else(|| s.message_types.first().cloned()),
            CompiledSchema::JsonSchema(s) => s.record_name(),
        }
    }

    /// Protobuf message types offered; empty for the other types.
    pub fn message_types(&self) -> Vec<String> {
        match self {
            CompiledSchema::Protobuf(s) => s.message_types.clone(),
            _ => Vec::new(),
        }
    }
}

/// Compiles a local schema, or lists what is wrong with it (file and line when known).
pub fn compile_local(schema: &LocalSchema) -> Result<CompiledSchema, Vec<SchemaIssue>> {
    let tag = |mut issues: Vec<SchemaIssue>| {
        for i in &mut issues {
            i.schema_id.get_or_insert_with(|| schema.id.clone());
        }
        issues
    };
    let result = match (&schema.schema_type, &schema.files) {
        (SchemaType::Protobuf, LocalSchemaFiles::Files(files)) => {
            ProtoSchema::compile(files, schema.message_types.as_deref())
                .map(CompiledSchema::Protobuf)
        }
        (
            SchemaType::Protobuf,
            LocalSchemaFiles::DescriptorSet {
                descriptor_set_base64,
            },
        ) => match BASE64.decode(descriptor_set_base64.trim()) {
            Ok(bytes) => ProtoSchema::from_descriptor_set(&bytes, schema.message_types.as_deref())
                .map(CompiledSchema::Protobuf),
            Err(e) => Err(vec![SchemaIssue::new(format!(
                "descriptor set: not valid base64: {e}"
            ))]),
        },
        (SchemaType::Avro, LocalSchemaFiles::Files(files)) => {
            compile_json_files(files, |main, rest| {
                let refs: Vec<String> = rest.iter().map(|f| f.text.clone()).collect();
                AvroSchema::parse(&main.text, &refs).map(CompiledSchema::Avro)
            })
        }
        (SchemaType::Jsonschema, LocalSchemaFiles::Files(files)) => {
            compile_json_files(files, |main, rest| {
                let refs: Vec<(String, String)> = rest
                    .iter()
                    .map(|f| (f.path.clone(), f.text.clone()))
                    .collect();
                JsonSchemaSchema::parse(&main.text, &refs).map(CompiledSchema::JsonSchema)
            })
        }
        (t, LocalSchemaFiles::DescriptorSet { .. }) => Err(vec![SchemaIssue::new(format!(
            "a descriptor set is a Protobuf source, not {t:?}"
        ))]),
    };
    result.map_err(tag)
}

/// Avro and JSON Schema files are JSON: a parse error names its file and line; the first file
/// is the schema, the others its references.
fn compile_json_files(
    files: &[SchemaFile],
    compile: impl FnOnce(&SchemaFile, &[SchemaFile]) -> crate::Result<CompiledSchema>,
) -> Result<CompiledSchema, Vec<SchemaIssue>> {
    let Some((main, rest)) = files.split_first() else {
        return Err(vec![SchemaIssue::new("the schema has no file")]);
    };
    let mut issues = Vec::new();
    for f in files {
        if let Err(e) = serde_json::from_str::<serde::de::IgnoredAny>(&f.text) {
            issues.push(SchemaIssue {
                schema_id: None,
                file: Some(f.path.clone()),
                line: (e.line() > 0).then_some(e.line() as u32),
                column: (e.line() > 0).then_some(e.column() as u32),
                message: format!("not valid JSON: {e}"),
            });
        }
    }
    if !issues.is_empty() {
        return Err(issues);
    }
    compile(main, rest).map_err(|e| {
        vec![SchemaIssue {
            schema_id: None,
            file: Some(main.path.clone()),
            line: e.position.map(|p: Position| p.line),
            column: e.position.map(|p| p.column),
            message: e.message,
        }]
    })
}

/// The local schemas of a profile, compiled, by id.
#[derive(Debug, Clone, Default)]
pub struct LocalSchemas {
    by_id: HashMap<String, Arc<CompiledSchema>>,
    names: HashMap<String, String>,
}

impl LocalSchemas {
    /// Compiles every schema; the ones that fail are left out and reported.
    pub fn compile(schemas: &[LocalSchema]) -> (Self, Vec<SchemaIssue>) {
        let mut out = Self::default();
        let mut issues = Vec::new();
        for s in schemas {
            match compile_local(s) {
                Ok(c) => {
                    out.by_id.insert(s.id.clone(), Arc::new(c));
                    out.names.insert(s.id.clone(), s.name.clone());
                }
                Err(mut e) => issues.append(&mut e),
            }
        }
        (out, issues)
    }

    pub fn get(&self, id: &str) -> Option<Arc<CompiledSchema>> {
        self.by_id.get(id).cloned()
    }

    /// The ids of the schemas that compiled.
    pub fn ids(&self) -> impl Iterator<Item = &str> {
        self.by_id.keys().map(String::as_str)
    }

    pub fn name(&self, id: &str) -> Option<&str> {
        self.names.get(id).map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.by_id.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_id.is_empty()
    }
}

/// The first mapping for a target's key or value (spec §5.2 step 2).
pub fn find_mapping<'a>(
    mappings: &'a [SchemaMapping],
    target: &Target,
    part: Part,
) -> Option<&'a SchemaMapping> {
    mappings
        .iter()
        .find(|m| m.part == part && mapping_matches(&m.target, target))
}

/// Whether a mapping's target covers where a message lives: a subject pattern matches core NATS
/// and JetStream subjects, a stream every subject read from it.
pub fn mapping_matches(mapping: &MappingTarget, target: &Target) -> bool {
    match (mapping, target) {
        (MappingTarget::Topic { name }, Target::Topic { name: t }) => name == t,
        (MappingTarget::KvBucket { bucket }, Target::KvBucket { bucket: b }) => bucket == b,
        (MappingTarget::Subject { pattern }, Target::Subject { subject, .. }) => {
            subject_matches(pattern, subject)
        }
        (MappingTarget::Stream { name }, Target::Subject { stream, .. }) => {
            stream.as_deref() == Some(name.as_str())
        }
        _ => false,
    }
}

/// NATS subject matching: tokens split on `.`, `*` matches one token, `>` (last) one or more.
pub fn subject_matches(pattern: &str, subject: &str) -> bool {
    let mut p = pattern.split('.');
    let mut s = subject.split('.');
    loop {
        match (p.next(), s.next()) {
            (Some(">"), Some(_)) => return p.next().is_none(),
            (Some("*"), Some(_)) => {}
            (Some(a), Some(b)) if a == b => {}
            (None, None) => return true,
            _ => return false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subjects() {
        assert!(subject_matches("orders.*.created", "orders.eu.created"));
        assert!(!subject_matches("orders.*.created", "orders.eu.x.created"));
        assert!(subject_matches("orders.>", "orders.eu.created"));
        assert!(!subject_matches("orders.>", "orders"));
        assert!(subject_matches("orders", "orders"));
        assert!(!subject_matches("orders.*", "orders"));
        assert!(!subject_matches("a.>.b", "a.x.b"));
    }

    #[test]
    fn mappings_pick_by_target_and_part() {
        let m = |id: &str, target: MappingTarget, part| SchemaMapping {
            id: id.into(),
            target,
            part,
            schema_id: Some(id.into()),
            registry: None,
            message_type: None,
            codec: None,
            wire_format: None,
        };
        let maps = vec![
            m(
                "a",
                MappingTarget::Subject {
                    pattern: "orders.proto.>".into(),
                },
                Part::Value,
            ),
            m(
                "b",
                MappingTarget::Topic {
                    name: "orders".into(),
                },
                Part::Key,
            ),
            m(
                "c",
                MappingTarget::KvBucket {
                    bucket: "config".into(),
                },
                Part::Value,
            ),
            m(
                "d",
                MappingTarget::Stream {
                    name: "PAYMENTS".into(),
                },
                Part::Value,
            ),
        ];
        let find = |t: Target, p| find_mapping(&maps, &t, p).map(|m| m.id.as_str());
        assert_eq!(
            find(Target::subject("orders.proto.eu"), Part::Value),
            Some("a")
        );
        // A subject pattern covers JetStream too; the stream mapping comes after it.
        assert_eq!(
            find(
                Target::stream_subject("PAYMENTS", "orders.proto.eu"),
                Part::Value
            ),
            Some("a")
        );
        assert_eq!(
            find(Target::stream_subject("PAYMENTS", "pay.eu"), Part::Value),
            Some("d")
        );
        assert_eq!(find(Target::subject("pay.eu"), Part::Value), None);
        assert_eq!(
            find(
                Target::Topic {
                    name: "orders".into()
                },
                Part::Key
            ),
            Some("b")
        );
        assert_eq!(
            find(
                Target::Topic {
                    name: "orders".into()
                },
                Part::Value
            ),
            None
        );
        assert_eq!(
            find(
                Target::KvBucket {
                    bucket: "config".into()
                },
                Part::Value
            ),
            Some("c")
        );
    }

    #[test]
    fn local_schema_errors_name_the_file() {
        let s = LocalSchema {
            id: "s1".into(),
            name: "orders".into(),
            schema_type: SchemaType::Avro,
            files: LocalSchemaFiles::Files(vec![
                SchemaFile { path: "order.avsc".into(), text: "{\"type\":\"record\",\"name\":\"O\",\"fields\":[{\"name\":\"m\",\"type\":\"Money\"}]}".into() },
                SchemaFile { path: "money.avsc".into(), text: "{\n  \"type\": \"record\",\n  \"name\": \"Money\",\n  \"fields\": [}\n".into() },
            ]),
            message_types: None,
        };
        let issues = compile_local(&s).unwrap_err();
        assert_eq!(issues[0].file.as_deref(), Some("money.avsc"));
        assert_eq!(issues[0].line, Some(4));
        assert_eq!(issues[0].schema_id.as_deref(), Some("s1"));

        let (compiled, issues) = LocalSchemas::compile(&[s]);
        assert!(compiled.is_empty());
        assert_eq!(issues.len(), 1);
    }
}
