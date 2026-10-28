//! Codegen: `api.ts` and `api.manifest.json` from a [`Router`] (Ambidex spec §2).
//!
//! The router a server serves is the only source. `#[rpc::router]` attaches a [`ProcedureTypes`]
//! to every procedure it registers; [`generate`] walks [`Router::entries`], collects the TypeScript
//! declarations through ts-rs and the JSON Schemas through schemars, checks that the two agree
//! (see [`agree`]), and renders both artifacts. A product's `rpc-gen` binary builds its router the
//! way its server does and calls [`cli`].
//!
//! Generation is a plain function of the registry: no network, no Node, no clock, no paths. The
//! same registry always gives byte-identical output, and the schema hash (see [`manifest`]) is
//! the one the server puts in [`ServerConfig::schema_hash`](crate::ServerConfig).
//!
//! # Declaration shapes
//!
//! | Kind | Signature | `output` is |
//! | --- | --- | --- |
//! | query, mutation | `async fn name(&self, ctx: Ctx, input: I) -> Result<O, E>` | the result |
//! | subscription | `async fn name(&self, ctx: Ctx, input: I, ..) -> Result<O, E>` | one event |
//! | stream | `async fn name(&self, ctx: Ctx, input: I, ..) -> Result<O, E>` | the final result |
//!
//! `I` and `O` implement [`ts_rs::TS`] and [`schemars::JsonSchema`]. `E` is any handler error
//! ([`RpcError<D>`](crate::RpcError), a [`DomainError`](crate::DomainError), [`Rejected`] or a raw
//! [`ErrorPayload`]); its [`ErrorType::Details`] is what TypeScript sees in `details`.

pub mod agree;
pub mod manifest;
mod render;
pub mod ts;

use std::any::TypeId;
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::fmt;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use schemars::{JsonSchema, Schema, SchemaGenerator, generate::SchemaSettings};
use serde_json::Value;
use ts_rs::{Config, TS, TypeVisitor};

use crate::error::{DomainError, NoDetails, RpcError};
use crate::message::ErrorPayload;
use crate::router::{Rejected, Router};

/// File names [`write`] and [`check`] use inside the output directory.
pub const API_TS: &str = "api.ts";
pub const MANIFEST_JSON: &str = "api.manifest.json";

/// A type codegen can export: TypeScript through ts-rs, JSON Schema through schemars.
pub trait Type: TS + JsonSchema + 'static {}

impl<T: TS + JsonSchema + 'static> Type for T {}

/// Type-erased handle on one [`Type`].
#[derive(Clone, Copy)]
pub struct TypeRef {
    rust_name: fn() -> &'static str,
    ts_name: fn(&Config) -> String,
    collect: fn(&mut Collector),
    schema: fn(&mut SchemaGenerator) -> Schema,
}

impl TypeRef {
    pub fn of<T: Type>() -> TypeRef {
        TypeRef {
            rust_name: std::any::type_name::<T>,
            ts_name: <T as TS>::name,
            collect: |c| c.visit::<T>(),
            schema: |g| g.subschema_for::<T>(),
        }
    }

    /// The Rust type, for error messages.
    pub fn rust_name(&self) -> &'static str {
        (self.rust_name)()
    }
}

impl fmt::Debug for TypeRef {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.rust_name())
    }
}

/// Input, output and error-details types of one procedure.
#[derive(Debug, Clone, Copy)]
pub struct ProcedureTypes {
    pub input: TypeRef,
    pub output: TypeRef,
    /// The type of `details` in the procedure's errors (`never` when there are none).
    pub error: TypeRef,
}

impl ProcedureTypes {
    /// `R` is the handler's return type as written, `Result<O, E>`.
    pub fn of<I: Type, R: ProcedureResult>() -> ProcedureTypes
    where
        R::Output: Type,
        <R::Error as ErrorType>::Details: Type,
    {
        ProcedureTypes {
            input: TypeRef::of::<I>(),
            output: TypeRef::of::<R::Output>(),
            error: TypeRef::of::<<R::Error as ErrorType>::Details>(),
        }
    }
}

/// A handler's return type, split into its parts. Implemented for `Result<O, E>`, so a type alias
/// for `Result` works as a return type too.
pub trait ProcedureResult {
    type Output;
    type Error: ErrorType;
}

impl<O, E: ErrorType> ProcedureResult for Result<O, E> {
    type Output = O;
    type Error = E;
}

/// The typed `details` a handler error carries to the client.
pub trait ErrorType {
    type Details;
}

impl<D> ErrorType for RpcError<D> {
    type Details = D;
}

impl<E: DomainError> ErrorType for E {
    type Details = E;
}

/// A raw payload's details are arbitrary JSON.
impl ErrorType for ErrorPayload {
    type Details = Value;
}

/// The router sends `ApprovalRequired` details itself; every client error type has that slot.
impl ErrorType for Rejected {
    type Details = NoDetails;
}

impl TS for NoDetails {
    type WithoutGenerics = NoDetails;
    type OptionInnerType = NoDetails;

    fn name(_: &Config) -> String {
        "never".into()
    }

    fn inline(_: &Config) -> String {
        "never".into()
    }
}

impl JsonSchema for NoDetails {
    fn schema_name() -> std::borrow::Cow<'static, str> {
        "NoDetails".into()
    }

    fn inline_schema() -> bool {
        true
    }

    fn json_schema(_: &mut SchemaGenerator) -> Schema {
        Schema::from(false)
    }
}

/// Identity of the API, written into both artifacts.
#[derive(Debug, Clone)]
pub struct ApiInfo {
    /// The `api` the server announces in Hello, e.g. `"dbee"`.
    pub name: String,
    /// The product's API version. Recorded, not hashed: a release that does not change the
    /// contract keeps its schema hash.
    pub version: String,
}

impl ApiInfo {
    pub fn new(name: impl Into<String>, version: impl Into<String>) -> ApiInfo {
        ApiInfo {
            name: name.into(),
            version: version.into(),
        }
    }
}

/// The generated artifacts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
    pub api_ts: String,
    pub manifest_json: String,
    pub schema_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CodegenError {
    /// A procedure was registered without types (built by hand or a dynamic plugin procedure).
    MissingTypes(String),
    /// Two Rust types export the same TypeScript name with different declarations.
    NameCollision {
        name: String,
        first: String,
        second: String,
    },
    /// A Rust type exports a TypeScript name that `api.ts` defines itself (`RpcError`, `Api`, ...).
    ReservedName { name: String, rust: String },
    /// A procedure name is also a namespace (`a.b` and `a.b.c`), so the client tree cannot hold
    /// both.
    NamespaceConflict(String),
    /// ts-rs and schemars disagree about a type.
    Disagreement(agree::Mismatch),
}

impl fmt::Display for CodegenError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CodegenError::MissingTypes(name) => write!(
                f,
                "procedure {name} has no type information; declare it with #[rpc::router] or \
                 attach ProcedureTypes with Procedure::with_types"
            ),
            CodegenError::NameCollision {
                name,
                first,
                second,
            } => write!(
                f,
                "TypeScript name {name} is exported by two different types ({first} and \
                 {second}); rename one with #[ts(rename)] and #[schemars(rename)]"
            ),
            CodegenError::ReservedName { name, rust } => write!(
                f,
                "TypeScript name {name} of {rust} is reserved by the generated api.ts; rename \
                 the type with #[ts(rename)] and #[schemars(rename)]"
            ),
            CodegenError::NamespaceConflict(name) => write!(
                f,
                "procedure {name} is also a namespace of another procedure; the generated client \
                 cannot hold both"
            ),
            CodegenError::Disagreement(m) => write!(f, "ts-rs and schemars disagree: {m}"),
        }
    }
}

impl std::error::Error for CodegenError {}

/// One collected TypeScript declaration.
#[derive(Debug, Clone)]
pub(crate) struct Decl {
    pub(crate) rust: &'static str,
    /// `type Name<T> = ...;` as ts-rs writes it.
    pub(crate) decl: String,
    pub(crate) docs: Option<String>,
}

/// Collects the ts-rs declarations of a type and everything it depends on.
pub struct Collector {
    cfg: Config,
    seen: HashSet<TypeId>,
    decls: BTreeMap<String, Decl>,
    error: Option<CodegenError>,
}

impl Collector {
    fn new() -> Collector {
        Collector {
            cfg: ts_config(),
            seen: HashSet::new(),
            decls: BTreeMap::new(),
            error: None,
        }
    }
}

impl TypeVisitor for Collector {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if !self.seen.insert(TypeId::of::<T>()) {
            return;
        }
        // Types with an output path are the declared ones (derives); primitives and std
        // containers are inlined by name and only contribute their dependencies.
        if T::output_path().is_some() {
            let name = T::ident(&self.cfg);
            let decl = Decl {
                rust: std::any::type_name::<T>(),
                decl: T::decl(&self.cfg),
                docs: T::docs(),
            };
            match self.decls.get(&name) {
                // Another instance of the same generic type declares the same thing.
                Some(prev) if prev.decl == decl.decl => {}
                Some(prev) => {
                    self.error.get_or_insert(CodegenError::NameCollision {
                        name,
                        first: prev.rust.to_owned(),
                        second: decl.rust.to_owned(),
                    });
                }
                None => {
                    self.decls.insert(name, decl);
                }
            }
        }
        T::visit_dependencies(self);
        T::visit_generics(self);
    }
}

/// ts-rs settings for every export. 64-bit integers are `number`: serde_json writes them as JSON
/// numbers, and that is what `JSON.parse` returns. A value above 2^53 loses precision in a
/// JavaScript client; a contract that needs the full range sends such values as strings (e.g.
/// `#[serde(with = ...)]` plus `#[ts(type = "string")]` and `#[schemars(with = "String")]`). The
/// manifest keeps the exact range (`format: "uint64"`), and `api.ts` states the limit in its header.
pub(crate) fn ts_config() -> Config {
    Config::new().with_large_int("number")
}

/// JSON Schema settings for every export: draft 2020-12, definitions under `$defs`.
pub(crate) fn schema_generator() -> SchemaGenerator {
    SchemaGenerator::new(SchemaSettings::draft2020_12())
}

/// One procedure with everything resolved.
pub(crate) struct Resolved {
    pub(crate) meta: std::sync::Arc<crate::ProcedureMeta>,
    pub(crate) input_ts: String,
    pub(crate) output_ts: String,
    pub(crate) error_ts: String,
    pub(crate) input_schema: Value,
    pub(crate) output_schema: Value,
    pub(crate) error_schema: Value,
}

/// Everything the renderers need.
pub(crate) struct Model {
    pub(crate) api: ApiInfo,
    pub(crate) procedures: Vec<Resolved>,
    pub(crate) decls: BTreeMap<String, Decl>,
    pub(crate) defs: BTreeMap<String, Value>,
}

fn resolve(router: &Router, api: &ApiInfo) -> Result<Model, CodegenError> {
    let mut collector = Collector::new();
    // The protocol's own types, referenced by the RpcError union in api.ts.
    collector.visit::<crate::Code>();
    collector.visit::<crate::ApprovalRequired>();
    let mut generator = schema_generator();
    generator.subschema_for::<crate::Code>();
    generator.subschema_for::<crate::ApprovalRequired>();
    let mut procedures = Vec::new();
    for entry in router.entries() {
        let meta = std::sync::Arc::clone(entry.meta());
        let types = *entry
            .types()
            .ok_or_else(|| CodegenError::MissingTypes(meta.name.clone()))?;
        let mut one = |t: TypeRef| {
            (t.collect)(&mut collector);
            let ts = (t.ts_name)(&collector.cfg);
            let schema = (t.schema)(&mut generator).to_value();
            (ts, schema)
        };
        let (input_ts, input_schema) = one(types.input);
        let (output_ts, output_schema) = one(types.output);
        let (error_ts, error_schema) = one(types.error);
        procedures.push(Resolved {
            meta,
            input_ts,
            output_ts,
            error_ts,
            input_schema,
            output_schema,
            error_schema,
        });
    }
    if let Some(err) = collector.error {
        return Err(err);
    }
    if let Some((name, decl)) = collector
        .decls
        .iter()
        .find(|(name, _)| render::RESERVED.contains(&name.as_str()))
    {
        return Err(CodegenError::ReservedName {
            name: name.clone(),
            rust: decl.rust.to_owned(),
        });
    }
    check_namespaces(&procedures)?;
    let defs = generator.take_definitions(true).into_iter().collect();
    Ok(Model {
        api: api.clone(),
        procedures,
        decls: collector.decls,
        defs,
    })
}

fn check_namespaces(procedures: &[Resolved]) -> Result<(), CodegenError> {
    let names: HashSet<&str> = procedures.iter().map(|p| p.meta.name.as_str()).collect();
    for p in procedures {
        let mut prefix = String::new();
        for segment in p.meta.name.split('.') {
            if !prefix.is_empty() {
                if names.contains(prefix.as_str()) {
                    return Err(CodegenError::NamespaceConflict(prefix));
                }
                prefix.push('.');
            }
            prefix.push_str(segment);
        }
    }
    Ok(())
}

/// Generates both artifacts from `router`. Fails if a procedure has no types, two types share a
/// TypeScript name, or ts-rs and schemars disagree about any exported type.
pub fn generate(router: &Router, api: &ApiInfo) -> Result<Output, CodegenError> {
    let model = resolve(router, api)?;
    agree::check_model(&model).map_err(CodegenError::Disagreement)?;
    let (manifest_json, schema_hash) = manifest::render(&model);
    let api_ts = render::api_ts(&model, &schema_hash);
    Ok(Output {
        api_ts,
        manifest_json,
        schema_hash,
    })
}

/// The schema hash of `router`'s contract, for [`ServerConfig::schema_hash`](crate::ServerConfig).
/// Runs all of [`generate`], so a server never announces a hash for a contract rpc-gen would
/// refuse; compute it once at startup.
pub fn schema_hash(router: &Router, api: &ApiInfo) -> Result<String, CodegenError> {
    generate(router, api).map(|output| output.schema_hash)
}

/// Writes `api.ts` and `api.manifest.json` into `dir`, creating it if needed.
pub fn write(output: &Output, dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    std::fs::write(dir.join(API_TS), &output.api_ts)?;
    std::fs::write(dir.join(MANIFEST_JSON), &output.manifest_json)
}

/// Compares `output` with the files in `dir` without touching them. Returns the stale or
/// missing files; empty means up to date.
pub fn check(output: &Output, dir: &Path) -> Vec<PathBuf> {
    [
        (API_TS, &output.api_ts),
        (MANIFEST_JSON, &output.manifest_json),
    ]
    .into_iter()
    .filter_map(|(file, expected)| {
        let path = dir.join(file);
        match std::fs::read_to_string(&path) {
            Ok(actual) if actual == *expected => None,
            _ => Some(path),
        }
    })
    .collect()
}

/// `main` of a product's `rpc-gen` binary.
///
/// ```text
/// rpc-gen [--out <dir>] [--check]
/// ```
///
/// Writes the artifacts into `--out` (default `default_out`), or with `--check` only compares
/// them and exits with 1 when they are stale. Relative paths resolve against the current
/// directory.
pub fn cli(router: &Router, api: &ApiInfo, default_out: &Path) -> ExitCode {
    let mut out = default_out.to_path_buf();
    let mut check_only = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--check" => check_only = true,
            "--out" => match args.next() {
                Some(dir) => out = PathBuf::from(dir),
                None => return usage("--out needs a directory"),
            },
            "-h" | "--help" => {
                println!("usage: rpc-gen [--out <dir>] [--check]");
                return ExitCode::SUCCESS;
            }
            other => return usage(&format!("unknown argument {other}")),
        }
    }
    let output = match generate(router, api) {
        Ok(output) => output,
        Err(err) => {
            eprintln!("rpc-gen: {err}");
            return ExitCode::FAILURE;
        }
    };
    if check_only {
        let stale = check(&output, &out);
        if stale.is_empty() {
            println!(
                "rpc-gen: {} is up to date ({})",
                out.display(),
                output.schema_hash
            );
            return ExitCode::SUCCESS;
        }
        for path in stale {
            eprintln!("rpc-gen: {} is stale or missing", path.display());
        }
        eprintln!("rpc-gen: regenerate by running rpc-gen without --check");
        return ExitCode::FAILURE;
    }
    match write(&output, &out) {
        Ok(()) => {
            println!("rpc-gen: wrote {} ({})", out.display(), output.schema_hash);
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("rpc-gen: cannot write {}: {err}", out.display());
            ExitCode::FAILURE
        }
    }
}

fn usage(msg: &str) -> ExitCode {
    eprintln!("rpc-gen: {msg}\nusage: rpc-gen [--out <dir>] [--check]");
    ExitCode::from(2)
}
