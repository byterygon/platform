//! Confluent Schema Registry client (Mightyconsole spec §5.3), written against Confluent's REST
//! API (Apicurio's and Redpanda's Confluent-compatible APIs are checked later).
//!
//! Schemas by id are cached forever (ids are immutable), compiled with their references,
//! resolved recursively: Protobuf imports, Avro named types, JSON Schema `$ref`s. A client
//! belongs to one connected profile and is dropped with it.

mod http;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use hyper::Method;
use serde::{Deserialize, Serialize};

use self::http::{Http, status_error};
pub use self::http::{RegistryAuth, RegistryConfig, Resolver};
use crate::codec::avro::AvroSchema;
use crate::codec::jsonschema::JsonSchemaSchema;
use crate::codec::protobuf::ProtoSchema;
use crate::schema::CompiledSchema;
use crate::types::{SchemaFile, SchemaType, SchemaVersion};
use crate::{CodecError, ErrorKind, Result};

/// References nest at most this deep.
const MAX_REFERENCE_DEPTH: usize = 32;

/// A cached subject version: its id, text, type and references.
type VersionEntry = (u32, String, Option<String>, Vec<SchemaReference>);

/// A reference from a schema to another subject's version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SchemaReference {
    /// The import path (Protobuf), the full name (Avro) or the `$ref` (JSON Schema).
    pub name: String,
    pub subject: String,
    pub version: u32,
}

/// A schema as the registry holds it, compiled.
#[derive(Debug, Clone)]
pub struct RegistrySchema {
    pub id: u32,
    pub schema_type: SchemaType,
    pub schema: String,
    pub references: Vec<SchemaReference>,
    pub compiled: Arc<CompiledSchema>,
}

/// A subject's version.
#[derive(Debug, Clone)]
pub struct SubjectVersion {
    pub subject: String,
    pub version: u32,
    pub id: u32,
    pub schema: Arc<RegistrySchema>,
}

/// The answer to a compatibility check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    pub is_compatible: bool,
    /// Why not, with `?verbose=true`.
    pub messages: Vec<String>,
}

/// A subject and version that use a schema id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(ts_rs::TS, schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SubjectVersionRef {
    pub subject: String,
    pub version: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaBody {
    schema: String,
    #[serde(default)]
    schema_type: Option<String>,
    #[serde(default)]
    references: Vec<SchemaReference>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionBody {
    subject: String,
    version: u32,
    id: u32,
    schema: String,
    #[serde(default)]
    schema_type: Option<String>,
    #[serde(default)]
    references: Vec<SchemaReference>,
}

/// A Schema Registry client with its caches.
#[derive(Debug, Clone)]
pub struct RegistryClient {
    inner: Arc<Inner>,
}

#[derive(Debug)]
struct Inner {
    http: Http,
    by_id: Mutex<HashMap<u32, Arc<RegistrySchema>>>,
    /// Subject versions by number (never "latest"): immutable once registered, unless the
    /// subject is deleted, which the Kafka tool handles by dropping the client's cache.
    versions: Mutex<HashMap<(String, u32), VersionEntry>>,
}

fn encode_path(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn version_text(v: SchemaVersion) -> String {
    match v {
        SchemaVersion::Number(n) => n.to_string(),
        SchemaVersion::Latest(_) => "latest".into(),
    }
}

fn schema_type(name: Option<&str>) -> Result<SchemaType> {
    SchemaType::from_registry_name(name).ok_or_else(|| {
        CodecError::invalid(format!(
            "unknown registry schema type {}",
            name.unwrap_or_default()
        ))
    })
}

impl RegistryClient {
    pub fn new(config: &RegistryConfig) -> Result<Self> {
        Ok(Self {
            inner: Arc::new(Inner {
                http: Http::new(config)?,
                by_id: Mutex::new(HashMap::new()),
                versions: Mutex::new(HashMap::new()),
            }),
        })
    }

    /// The registry's base URL, for messages.
    pub fn url(&self) -> String {
        self.inner.http.url("")
    }

    /// Forgets cached subject versions (after a subject or version was deleted).
    pub fn clear_cache(&self) {
        self.inner.versions.lock().expect("lock").clear();
    }

    async fn get<T: for<'de> Deserialize<'de>>(&self, path: &str) -> Result<T> {
        self.json(Method::GET, path, None).await
    }

    async fn json<T: for<'de> Deserialize<'de>>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T> {
        let body = body.map(|b| serde_json::to_vec(&b).expect("JSON body"));
        let resp = self.inner.http.send(method, path, body).await?;
        if !(200..300).contains(&resp.status) {
            return Err(status_error(resp.status, &resp.body));
        }
        serde_json::from_slice(&resp.body).map_err(|e| {
            CodecError::new(
                ErrorKind::Remote,
                format!("unexpected answer from the registry for {path}: {e}"),
            )
        })
    }

    /// `GET /schemas/ids/{id}`, compiled with its references; cached forever.
    pub async fn schema_by_id(&self, id: u32) -> Result<Arc<RegistrySchema>> {
        if let Some(s) = self.inner.by_id.lock().expect("lock").get(&id) {
            return Ok(s.clone());
        }
        let body: SchemaBody = self.get(&format!("/schemas/ids/{id}")).await?;
        let schema_type = schema_type(body.schema_type.as_deref())?;
        let compiled = self
            .compile(
                schema_type,
                &body.schema,
                &body.references,
                &format!("schema {id}"),
            )
            .await?;
        let schema = Arc::new(RegistrySchema {
            id,
            schema_type,
            schema: body.schema,
            references: body.references,
            compiled: Arc::new(compiled),
        });
        self.inner
            .by_id
            .lock()
            .expect("lock")
            .insert(id, schema.clone());
        Ok(schema)
    }

    /// `GET /subjects/{s}/versions/{v}`, compiled through the id cache.
    pub async fn subject_version(
        &self,
        subject: &str,
        version: SchemaVersion,
    ) -> Result<SubjectVersion> {
        let (version, id) = self.version_meta(subject, version).await?;
        Ok(SubjectVersion {
            subject: subject.to_owned(),
            version,
            id,
            schema: self.schema_by_id(id).await?,
        })
    }

    async fn version_meta(&self, subject: &str, version: SchemaVersion) -> Result<(u32, u32)> {
        if let SchemaVersion::Number(n) = version
            && let Some((id, ..)) = self
                .inner
                .versions
                .lock()
                .expect("lock")
                .get(&(subject.to_owned(), n))
        {
            return Ok((n, *id));
        }
        let body: VersionBody = self
            .get(&format!(
                "/subjects/{}/versions/{}",
                encode_path(subject),
                version_text(version)
            ))
            .await?;
        self.inner.versions.lock().expect("lock").insert(
            (body.subject.clone(), body.version),
            (body.id, body.schema, body.schema_type, body.references),
        );
        Ok((body.version, body.id))
    }

    /// A version's text, type and references (cached by number).
    async fn version_body(
        &self,
        subject: &str,
        version: u32,
    ) -> Result<(String, Option<String>, Vec<SchemaReference>)> {
        if let Some((_, s, t, r)) = self
            .inner
            .versions
            .lock()
            .expect("lock")
            .get(&(subject.to_owned(), version))
        {
            return Ok((s.clone(), t.clone(), r.clone()));
        }
        self.version_meta(subject, SchemaVersion::Number(version))
            .await?;
        let cache = self.inner.versions.lock().expect("lock");
        let (_, s, t, r) = cache
            .get(&(subject.to_owned(), version))
            .expect("just cached");
        Ok((s.clone(), t.clone(), r.clone()))
    }

    /// Every schema a schema references, transitively, dependencies first: `(name, text)`.
    async fn resolve_references(
        &self,
        references: &[SchemaReference],
    ) -> Result<Vec<(String, String)>> {
        let mut out: Vec<(String, String)> = Vec::new();
        let mut seen: HashSet<(String, u32)> = HashSet::new();
        // An explicit stack instead of async recursion: (reference, depth, children pushed?).
        let mut stack: Vec<(SchemaReference, usize, bool)> = references
            .iter()
            .rev()
            .map(|r| (r.clone(), 1, false))
            .collect();
        let mut texts: HashMap<(String, u32), String> = HashMap::new();
        while let Some((r, depth, expanded)) = stack.pop() {
            let key = (r.subject.clone(), r.version);
            if expanded {
                if seen.insert(key.clone()) {
                    out.push((r.name.clone(), texts.remove(&key).unwrap_or_default()));
                }
                continue;
            }
            if seen.contains(&key) {
                continue;
            }
            if depth > MAX_REFERENCE_DEPTH {
                return Err(CodecError::invalid(format!(
                    "schema references nest deeper than {MAX_REFERENCE_DEPTH}"
                )));
            }
            let (text, _, children) = self.version_body(&r.subject, r.version).await?;
            texts.insert(key, text);
            stack.push((r, depth, true));
            for c in children.into_iter().rev() {
                if !seen.contains(&(c.subject.clone(), c.version)) {
                    stack.push((c, depth + 1, false));
                }
            }
        }
        Ok(out)
    }

    async fn compile(
        &self,
        schema_type: SchemaType,
        text: &str,
        references: &[SchemaReference],
        what: &str,
    ) -> Result<CompiledSchema> {
        let refs = self.resolve_references(references).await?;
        let fail = |e: String| {
            CodecError::invalid(format!("{what} in the registry does not compile: {e}"))
        };
        match schema_type {
            SchemaType::Avro => {
                let texts: Vec<String> = refs.into_iter().map(|(_, t)| t).collect();
                AvroSchema::parse(text, &texts)
                    .map(CompiledSchema::Avro)
                    .map_err(|e| fail(e.message))
            }
            SchemaType::Jsonschema => JsonSchemaSchema::parse(text, &refs)
                .map(CompiledSchema::JsonSchema)
                .map_err(|e| fail(e.message)),
            SchemaType::Protobuf => {
                // The schema itself has no file name; references are named by import path.
                let mut main = "registry-schema.proto".to_owned();
                while refs.iter().any(|(n, _)| *n == main) {
                    main.insert(0, '_');
                }
                let mut files = vec![SchemaFile {
                    path: main,
                    text: text.to_owned(),
                }];
                files.extend(
                    refs.into_iter()
                        .map(|(path, text)| SchemaFile { path, text }),
                );
                ProtoSchema::compile(&files, None)
                    .map(CompiledSchema::Protobuf)
                    .map_err(|issues| {
                        fail(
                            issues
                                .into_iter()
                                .map(|i| match (i.file, i.line) {
                                    (Some(f), Some(l)) => format!("{f}:{l}: {}", i.message),
                                    _ => i.message,
                                })
                                .collect::<Vec<_>>()
                                .join("; "),
                        )
                    })
            }
        }
    }

    /// `GET /subjects`.
    pub async fn subjects(&self) -> Result<Vec<String>> {
        self.get("/subjects").await
    }

    /// `GET /subjects/{s}/versions`.
    pub async fn versions(&self, subject: &str) -> Result<Vec<u32>> {
        self.get(&format!("/subjects/{}/versions", encode_path(subject)))
            .await
    }

    /// `GET /schemas/ids/{id}/versions`: the subjects and versions using an id.
    pub async fn id_versions(&self, id: u32) -> Result<Vec<SubjectVersionRef>> {
        self.get(&format!("/schemas/ids/{id}/versions")).await
    }

    fn schema_body(
        schema_type: SchemaType,
        schema: &str,
        references: &[SchemaReference],
    ) -> serde_json::Value {
        let mut body = serde_json::json!({ "schema": schema });
        if schema_type != SchemaType::Avro {
            body["schemaType"] = schema_type.registry_name().into();
        }
        if !references.is_empty() {
            body["references"] = serde_json::to_value(references).expect("references");
        }
        body
    }

    /// `POST /subjects/{s}/versions`: registers a schema (or finds it); returns its id.
    pub async fn register(
        &self,
        subject: &str,
        schema_type: SchemaType,
        schema: &str,
        references: &[SchemaReference],
    ) -> Result<u32> {
        #[derive(Deserialize)]
        struct Id {
            id: u32,
        }
        let body = Self::schema_body(schema_type, schema, references);
        let r: Id = self
            .json(
                Method::POST,
                &format!("/subjects/{}/versions", encode_path(subject)),
                Some(body),
            )
            .await?;
        Ok(r.id)
    }

    /// `POST /compatibility/subjects/{s}/versions/{v}?verbose=true`.
    pub async fn check_compatibility(
        &self,
        subject: &str,
        version: SchemaVersion,
        schema_type: SchemaType,
        schema: &str,
        references: &[SchemaReference],
    ) -> Result<Compatibility> {
        #[derive(Deserialize)]
        struct Body {
            is_compatible: bool,
            #[serde(default)]
            messages: Vec<String>,
        }
        let body = Self::schema_body(schema_type, schema, references);
        let path = format!(
            "/compatibility/subjects/{}/versions/{}?verbose=true",
            encode_path(subject),
            version_text(version)
        );
        let r: Body = self.json(Method::POST, &path, Some(body)).await?;
        Ok(Compatibility {
            is_compatible: r.is_compatible,
            messages: r.messages,
        })
    }

    /// `GET /config` or `/config/{s}`: the compatibility level; `None` when a subject has no
    /// level of its own.
    pub async fn compatibility_level(&self, subject: Option<&str>) -> Result<Option<String>> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Body {
            compatibility_level: Option<String>,
            compatibility: Option<String>,
        }
        let path = match subject {
            Some(s) => format!("/config/{}?defaultToGlobal=false", encode_path(s)),
            None => "/config".to_owned(),
        };
        match self.get::<Body>(&path).await {
            Ok(b) => Ok(b.compatibility_level.or(b.compatibility)),
            Err(e) if e.kind == ErrorKind::NotFound && subject.is_some() => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// `PUT /config` or `/config/{s}`.
    pub async fn set_compatibility_level(&self, subject: Option<&str>, level: &str) -> Result<()> {
        let path = match subject {
            Some(s) => format!("/config/{}", encode_path(s)),
            None => "/config".to_owned(),
        };
        let _: serde_json::Value = self
            .json(
                Method::PUT,
                &path,
                Some(serde_json::json!({ "compatibility": level })),
            )
            .await?;
        Ok(())
    }

    /// `GET /mode`.
    pub async fn mode(&self) -> Result<String> {
        #[derive(Deserialize)]
        struct Body {
            mode: String,
        }
        Ok(self.get::<Body>("/mode").await?.mode)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_are_encoded() {
        assert_eq!(
            encode_path("lab/common/money.proto"),
            "lab%2Fcommon%2Fmoney.proto"
        );
        assert_eq!(encode_path("orders-value"), "orders-value");
    }
}
