//! Codegen (Ambidex spec §2): `api.ts`, `api.manifest.json`, the schema hash, the drift check,
//! and agreement between ts-rs, schemars and serde.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use ambidex::codegen::agree::Checker;
use ambidex::codegen::{self, ApiInfo, CodegenError, ProcedureTypes, Type};
use ambidex::security_types::{Authorizer, AuthzRequest, Decision, Reason};
use ambidex::{
    Code, Ctx, DomainError, ErrorPayload, Procedure, ProcedureKind, ProcedureMeta, Risk, Router,
    RpcError, rpc,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use ts_rs::TS;

// ---- a type zoo covering the serde shapes procedures use -------------------------------------

/// Opaque connection id.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct ConnectionId(String);

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(untagged)]
pub enum Param {
    Int(i64),
    Text(String),
    Flag(bool),
}

/// Input of `zoo.execute`.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteInput {
    pub connection_id: ConnectionId,
    /// The statement.
    pub sql: String,
    pub batch_rows: Option<u32>,
    #[serde(default)]
    #[ts(optional = nullable)]
    pub dry_run: bool,
    #[serde(rename = "params")]
    pub parameters: Vec<Param>,
    pub tags: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ColumnType {
    Int,
    Text,
    TimestampTz,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct Column {
    pub name: String,
    #[serde(rename = "type")]
    pub ty: ColumnType,
    pub nullable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteSummary {
    pub rows: u64,
    pub elapsed_ms: u64,
    pub truncated: bool,
    pub columns: Vec<Column>,
    pub shape: (u32, u32),
    pub distinct: HashSet<String>,
}

/// Internally tagged, as in the spec's worked example.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "kind")]
pub enum QueryError {
    Syntax {
        message: String,
        position: Option<u32>,
    },
    Connection {
        message: String,
    },
    Cancelled,
}

impl DomainError for QueryError {
    fn code(&self) -> Code {
        match self {
            QueryError::Syntax { .. } => Code::InvalidArgument,
            QueryError::Connection { .. } => Code::Unavailable,
            QueryError::Cancelled => Code::Cancelled,
        }
    }
}

/// Adjacently tagged.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
#[serde(tag = "t", content = "c")]
pub enum Event {
    Progress(u32),
    Done { rows: u64 },
    Idle,
}

/// Externally tagged (serde's default).
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub enum Shape {
    Circle { r: f64 },
    Point,
    Pair(u8, u8),
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct Meta {
    pub created_by: String,
    pub labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct WithFlatten {
    pub id: u32,
    #[serde(flatten)]
    pub meta: Meta,
}

/// Recursive.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct Tree {
    pub label: String,
    pub children: Vec<Tree>,
    pub attrs: Option<Box<BTreeMap<String, Value>>>,
}

/// Fixed-size arrays: tuples in TypeScript.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct Fingerprint {
    pub sha256: [u8; 32],
    pub pair: [String; 2],
}

/// A flattened map: known properties plus any others of one type.
#[derive(Debug, Clone, Serialize, Deserialize, TS, JsonSchema)]
pub struct WithExtras {
    pub id: String,
    #[serde(flatten)]
    pub extra: BTreeMap<String, u32>,
}

#[derive(Default)]
pub struct ZooApi;

#[rpc::router(namespace = "zoo")]
impl ZooApi {
    #[rpc::stream(perm = "zoo.query", risk = Risk::Read, agent = Agent::Exposed,
                  timeout_default = "5m", timeout_max = "1h")]
    async fn execute(&self, _ctx: Ctx, _input: ExecuteInput) -> Result<ExecuteSummary, QueryError> {
        Err(QueryError::Cancelled)
    }

    #[rpc::subscription(perm = "zoo.watch", risk = Risk::Read)]
    async fn events(&self, _ctx: Ctx, _input: Option<String>) -> Result<Event, RpcError> {
        Err(RpcError::new(Code::Unimplemented, "declared only"))
    }

    #[rpc::query(perm = "zoo.read", risk = Risk::Read)]
    async fn shapes(&self, _ctx: Ctx, _input: ()) -> Result<Vec<Shape>, RpcError> {
        Ok(vec![Shape::Point])
    }

    #[rpc::query(perm = "zoo.read", risk = Risk::Read)]
    async fn columns(&self, _ctx: Ctx, _page: u32) -> Result<Page<Column>, RpcError<QueryError>> {
        Ok(Page {
            items: vec![],
            next: None,
        })
    }

    #[rpc::mutation(perm = "zoo.write", risk = Risk::Write, deprecated)]
    async fn flat(&self, _ctx: Ctx, _input: WithFlatten) -> Result<Tree, ErrorPayload> {
        Err(ErrorPayload::new(Code::NotFound, "no tree"))
    }

    #[rpc::query(perm = "zoo.read", risk = Risk::Read)]
    async fn fingerprint(&self, _ctx: Ctx, _input: WithExtras) -> Result<Fingerprint, RpcError> {
        Err(RpcError::new(Code::NotFound, "none"))
    }
}

#[derive(Default)]
pub struct AdminApi;

#[rpc::router(namespace = "zoo.admin")]
impl AdminApi {
    #[rpc::mutation(perm = "zoo.admin", risk = Risk::Destructive, log_input, redact = ["token"])]
    async fn reset(&self, _ctx: Ctx, _input: Value) -> Result<(), RpcError> {
        Ok(())
    }
}

struct DenyAll;

impl Authorizer for DenyAll {
    async fn check(&self, req: &AuthzRequest<'_>) -> Decision {
        Decision::Deny {
            reason: Reason::UnknownPermission {
                perm: req.action.perm.clone(),
            },
        }
    }
}

fn zoo_router(admin_first: bool) -> Router {
    let router = Router::new(DenyAll);
    if admin_first {
        router.mount(AdminApi).unwrap();
        router.mount(ZooApi).unwrap();
    } else {
        router.mount(ZooApi).unwrap();
        router.mount(AdminApi).unwrap();
    }
    router
}

fn api() -> ApiInfo {
    ApiInfo::new("zoo", "1.2.3")
}

fn generate(router: &Router) -> codegen::Output {
    codegen::generate(router, &api()).unwrap_or_else(|e| panic!("{e}"))
}

fn manifest(output: &codegen::Output) -> Value {
    serde_json::from_str(&output.manifest_json).unwrap()
}

// ---- generation ------------------------------------------------------------------------------

#[test]
fn api_ts_exports_types_and_a_typed_procedure_table() {
    let out = generate(&zoo_router(false));
    let ts = &out.api_ts;
    for expected in [
        "export const API = \"zoo\";",
        "export const API_VERSION = \"1.2.3\";",
        &format!("export const SCHEMA_HASH = \"{}\";", out.schema_hash),
        "export type ExecuteInput = {",
        "connectionId: ConnectionId",
        "params: Array<Param>",
        "note?: string",
        "dryRun?: boolean",
        "batchRows: number | null",
        "export type ApprovalRequiredDetails = {",
        "details?: ApprovalRequiredDetails | D;",
        "export type ColumnType = \"int\" | \"text\" | \"timestamp_tz\";",
        "export type Page<T> = {",
        "export type Code = ",
        "export type RpcError<D = never> =",
        "readonly \"zoo.execute\": ProcedureDef<\"stream\", ExecuteInput, ExecuteSummary, QueryError>;",
        "readonly \"zoo.events\": ProcedureDef<\"subscription\", string | null, Event, never>;",
        "readonly \"zoo.columns\": ProcedureDef<\"query\", number, Page<Column>, QueryError>;",
        "readonly \"zoo.flat\": ProcedureDef<\"mutation\", WithFlatten, Tree, JsonValue>;",
        "readonly reset: Procedures[\"zoo.admin.reset\"];",
        "export const procedures: Api = {",
    ] {
        assert!(ts.contains(expected), "api.ts lacks {expected:?}:\n{ts}");
    }
    // 64-bit integers are numbers, as serde_json writes them, and the header says where that ends.
    assert!(!ts.contains("bigint"), "{ts}");
    assert!(ts.contains("exact only up to 2^53"), "{ts}");
    // Doc comments carry over.
    assert!(ts.contains("Input of `zoo.execute`."), "{ts}");
}

#[test]
fn manifest_reflects_the_registry() {
    let router = zoo_router(false);
    let out = generate(&router);
    let m = manifest(&out);
    assert_eq!(m["format"], "ambidex.manifest.v1");
    assert_eq!(m["protocol"], 1);
    assert_eq!(m["api"], json!({"name": "zoo", "version": "1.2.3"}));
    assert_eq!(m["schema_hash"], out.schema_hash);

    let procs = m["procedures"].as_array().unwrap();
    let metas = router.procedures();
    assert_eq!(procs.len(), metas.len());
    for (p, meta) in procs.iter().zip(&metas) {
        assert_eq!(p["name"], meta.name);
        assert_eq!(p["kind"], json!(meta.kind));
        assert_eq!(p["perm"], meta.perm.as_str());
        assert_eq!(p["risk"], json!(meta.risk));
        assert_eq!(p["agent"], json!(meta.agent));
        assert_eq!(p["deprecated"], meta.deprecated);
        assert_eq!(p["log_input"], meta.log_input);
        assert_eq!(p["redact"], json!(meta.redact));
        assert_eq!(
            p["timeout_max_ms"],
            u64::try_from(meta.timeout_max.as_millis()).unwrap()
        );
    }
    let execute = &procs[metas.iter().position(|m| m.name == "zoo.execute").unwrap()];
    assert_eq!(execute["kind"], "stream");
    assert_eq!(execute["agent"], "exposed");
    assert_eq!(execute["timeout_default_ms"], 300_000);
    assert_eq!(execute["input"], json!({"$ref": "#/$defs/ExecuteInput"}));
    assert_eq!(execute["error"], json!({"$ref": "#/$defs/QueryError"}));
    // A procedure without typed details: `details` never present.
    let events = &procs[metas.iter().position(|m| m.name == "zoo.events").unwrap()];
    assert_eq!(events["error"], json!(false));
    // Named schemas live at the root, so `#/$defs/...` resolves against the manifest itself.
    let defs = m["$defs"].as_object().unwrap();
    for name in [
        "ExecuteInput",
        "ExecuteSummary",
        "QueryError",
        "Code",
        "ApprovalRequiredDetails",
        "Tree",
    ] {
        assert!(defs.contains_key(name), "missing $defs/{name}");
    }
    // Any procedure's ApprovalRequired error may carry the router's approval id instead.
    assert_eq!(
        m["approval_required_details"],
        json!({"$ref": "#/$defs/ApprovalRequiredDetails"})
    );
    assert_eq!(
        defs["ApprovalRequiredDetails"]["required"],
        json!(["approval_id"])
    );
    assert_eq!(
        defs["ExecuteInput"]["properties"]["params"]["items"],
        json!({"$ref": "#/$defs/Param"})
    );
}

#[test]
fn generation_is_deterministic_and_independent_of_mount_order() {
    let a = generate(&zoo_router(false));
    let b = generate(&zoo_router(false));
    let c = generate(&zoo_router(true));
    assert_eq!(a, b);
    assert_eq!(a, c);
    assert_eq!(
        codegen::schema_hash(&zoo_router(true), &api()).unwrap(),
        a.schema_hash
    );
    assert!(a.schema_hash.starts_with("sha256:") && a.schema_hash.len() == 7 + 64);
    // The API version is recorded but not hashed.
    let other = codegen::generate(&zoo_router(false), &ApiInfo::new("zoo", "9.9.9")).unwrap();
    assert_eq!(other.schema_hash, a.schema_hash);
    assert_ne!(other.manifest_json, a.manifest_json);
}

// ---- schema hash -----------------------------------------------------------------------------

/// The same one-procedure API in several versions, to see which changes move the hash.
macro_rules! item_api {
    ($module:ident, $perm:literal, { $($field:tt)* }) => {
        mod $module {
            use super::*;

            #[derive(Serialize, Deserialize, TS, JsonSchema)]
            pub struct Item { $($field)* }

            pub struct ItemsApi;

            #[rpc::router(namespace = "items")]
            impl ItemsApi {
                #[rpc::query(perm = $perm, risk = Risk::Read)]
                async fn get(&self, _ctx: Ctx, _id: u32) -> Result<Item, RpcError> {
                    Err(RpcError::new(Code::NotFound, "none"))
                }
            }

            pub fn hash() -> String {
                let router = Router::new(DenyAll);
                router.mount(ItemsApi).unwrap();
                codegen::schema_hash(&router, &ApiInfo::new("items", "0")).unwrap()
            }
        }
    };
}

item_api!(base, "items.read", { pub id: u32, pub name: String });
item_api!(reordered, "items.read", {
    /// Docs are not part of the contract.
    pub name: String,
    pub id: u32,
});
item_api!(titled, "items.read", {
    /// # Identifier
    ///
    /// A doc heading becomes a schema `title`, which is not part of the contract either.
    pub id: u32,
    pub name: String,
});
// Fields named like JSON Schema keywords are schemas too: their docs are not hashed.
item_api!(keywords, "items.read", { pub default: u32, pub r#enum: Vec<u8>, pub title: String });
item_api!(keywords_documented, "items.read", {
    /// Docs.
    pub title: String,
    /// # Heading
    pub r#enum: Vec<u8>,
    /// More docs.
    pub default: u32,
});
item_api!(renamed_field, "items.read", { #[serde(rename = "ident")] pub id: u32, pub name: String });
item_api!(optional_field, "items.read", { pub id: u32, pub name: Option<String> });
item_api!(retyped_field, "items.read", { pub id: String, pub name: String });
item_api!(added_field, "items.read", { pub id: u32, pub name: String, pub extra: bool });
item_api!(other_perm, "items.list", { pub id: u32, pub name: String });

#[test]
fn hash_ignores_declaration_order_and_docs() {
    assert_eq!(base::hash(), reordered::hash());
    assert_eq!(base::hash(), titled::hash());
    assert_eq!(keywords::hash(), keywords_documented::hash());
}

#[test]
fn hash_changes_with_the_contract() {
    let base = base::hash();
    let changed = [
        renamed_field::hash(),
        optional_field::hash(),
        retyped_field::hash(),
        added_field::hash(),
        other_perm::hash(),
    ];
    for (i, h) in changed.iter().enumerate() {
        assert_ne!(*h, base, "change {i} kept the hash");
    }
    let unique: HashSet<_> = changed.iter().collect();
    assert_eq!(unique.len(), changed.len());
}

// ---- drift check -----------------------------------------------------------------------------

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ambidex-codegen-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    dir
}

#[test]
fn check_detects_stale_and_missing_artifacts_without_writing() {
    let dir = temp_dir("drift");
    let out = generate(&zoo_router(false));
    let expected = [dir.join(codegen::API_TS), dir.join(codegen::MANIFEST_JSON)];

    assert_eq!(
        codegen::check(&out, &dir),
        expected,
        "missing files are stale"
    );
    assert!(!dir.exists(), "check must not create anything");

    codegen::write(&out, &dir).unwrap();
    assert!(codegen::check(&out, &dir).is_empty());

    // A contract change in Rust: the committed files no longer match.
    let changed = Router::new(DenyAll);
    changed.mount(ZooApi).unwrap();
    let changed = generate(&changed);
    assert_eq!(codegen::check(&changed, &dir), expected);

    // A hand edit of one file.
    let ts = std::fs::read_to_string(&expected[0]).unwrap();
    std::fs::write(&expected[0], ts.replace("readonly", "readonly ")).unwrap();
    assert_eq!(codegen::check(&out, &dir), [expected[0].clone()]);
    let before = std::fs::read_to_string(&expected[0]).unwrap();
    let _ = codegen::check(&out, &dir);
    assert_eq!(std::fs::read_to_string(&expected[0]).unwrap(), before);

    std::fs::remove_dir_all(&dir).unwrap();
}

// ---- registry errors -------------------------------------------------------------------------

fn declared(name: &str) -> Procedure {
    Procedure::declared(ProcedureMeta::new(
        name,
        ProcedureKind::Query,
        "x.read",
        Risk::Read,
    ))
}

fn unit_types() -> ProcedureTypes {
    ProcedureTypes::of::<(), Result<(), RpcError>>()
}

#[test]
fn procedures_without_types_are_refused() {
    let router = Router::new(DenyAll);
    router.insert(declared("plugin.x.op")).unwrap();
    assert_eq!(
        codegen::generate(&router, &api()).unwrap_err(),
        CodegenError::MissingTypes("plugin.x.op".into())
    );
}

#[test]
fn a_procedure_cannot_also_be_a_namespace() {
    let router = Router::new(DenyAll);
    router
        .insert(declared("a.b").with_types(unit_types()))
        .unwrap();
    router
        .insert(declared("a.b.c").with_types(unit_types()))
        .unwrap();
    assert_eq!(
        codegen::generate(&router, &api()).unwrap_err(),
        CodegenError::NamespaceConflict("a.b".into())
    );
}

mod one {
    use super::*;
    #[derive(Serialize, Deserialize, TS, JsonSchema)]
    pub struct Item {
        pub id: u32,
    }
}

mod two {
    use super::*;
    #[derive(Serialize, Deserialize, TS, JsonSchema)]
    pub struct Item {
        pub name: String,
    }
}

#[test]
fn two_types_with_one_typescript_name_are_refused() {
    let router = Router::new(DenyAll);
    router
        .insert(
            declared("a.one").with_types(ProcedureTypes::of::<one::Item, Result<(), RpcError>>()),
        )
        .unwrap();
    router
        .insert(
            declared("a.two").with_types(ProcedureTypes::of::<two::Item, Result<(), RpcError>>()),
        )
        .unwrap();
    let err = codegen::generate(&router, &api()).unwrap_err();
    assert!(
        matches!(&err, CodegenError::NameCollision { name, .. } if name == "Item"),
        "{err}"
    );
}

mod clash {
    use super::*;
    /// Same name as the generated `Api` interface.
    #[derive(Serialize, Deserialize, TS, JsonSchema)]
    pub struct Api {
        pub id: u32,
    }
}

#[test]
fn types_named_like_generated_declarations_are_refused() {
    let router = Router::new(DenyAll);
    router
        .insert(
            declared("a.get").with_types(ProcedureTypes::of::<clash::Api, Result<(), RpcError>>()),
        )
        .unwrap();
    let err = codegen::generate(&router, &api()).unwrap_err();
    assert!(
        matches!(&err, CodegenError::ReservedName { name, .. } if name == "Api"),
        "{err}"
    );
}

// ---- ts-rs / schemars / serde agreement ------------------------------------------------------

fn checker<T: Type>() -> Checker {
    Checker::of::<T>().unwrap_or_else(|e| panic!("{e}"))
}

/// serde's JSON for `value` fits both the TypeScript type and the JSON Schema.
fn fits<T: Type + Serialize>(value: &T) {
    let json = serde_json::to_value(value).unwrap();
    let c = checker::<T>();
    assert_eq!(c.ts_accepts(&json), Ok(true), "TypeScript rejects {json}");
    assert_eq!(
        c.schema_accepts(&json),
        Ok(true),
        "JSON Schema rejects {json}"
    );
}

/// `json` fits neither description of `T`.
fn misfits<T: Type>(json: Value) {
    let c = checker::<T>();
    assert_eq!(c.ts_accepts(&json), Ok(false), "TypeScript accepts {json}");
    assert_eq!(
        c.schema_accepts(&json),
        Ok(false),
        "JSON Schema accepts {json}"
    );
}

#[test]
fn every_zoo_type_agrees() {
    fn agree<T: Type>() {
        let c = checker::<T>();
        c.agree()
            .unwrap_or_else(|e| panic!("{}: {e}", std::any::type_name::<T>()));
    }
    agree::<ConnectionId>();
    agree::<Param>();
    agree::<ExecuteInput>();
    agree::<ColumnType>();
    agree::<Column>();
    agree::<ExecuteSummary>();
    agree::<QueryError>();
    agree::<Event>();
    agree::<Shape>();
    agree::<Page<Column>>();
    agree::<WithFlatten>();
    agree::<Tree>();
    agree::<Fingerprint>();
    agree::<WithExtras>();
    agree::<Code>();
    agree::<Option<Vec<Shape>>>();
    agree::<BTreeMap<String, Page<u64>>>();
    agree::<Value>();
    agree::<()>();
}

#[test]
fn serde_output_fits_both_descriptions() {
    let input = ExecuteInput {
        connection_id: ConnectionId("c-1".into()),
        sql: "select 1".into(),
        batch_rows: None,
        dry_run: true,
        parameters: vec![Param::Int(1), Param::Text("a".into()), Param::Flag(false)],
        tags: BTreeMap::from([("team".into(), "db".into())]),
        note: None,
    };
    fits(&input);
    // serde fills in a `#[serde(default)]` field, so both descriptions let a client omit it.
    let mut omitted = serde_json::to_value(&input).unwrap();
    omitted.as_object_mut().unwrap().remove("dryRun");
    serde_json::from_value::<ExecuteInput>(omitted.clone()).unwrap();
    let c = checker::<ExecuteInput>();
    assert_eq!(c.ts_accepts(&omitted), Ok(true));
    assert_eq!(c.schema_accepts(&omitted), Ok(true));
    fits(&ExecuteInput {
        batch_rows: Some(10),
        note: Some("n".into()),
        ..input.clone()
    });
    fits(&ExecuteSummary {
        rows: u64::from(u32::MAX) + 1,
        elapsed_ms: 3,
        truncated: false,
        columns: vec![Column {
            name: "id".into(),
            ty: ColumnType::TimestampTz,
            nullable: true,
        }],
        shape: (1, 2),
        distinct: HashSet::from(["x".into()]),
    });
    for e in [
        QueryError::Syntax {
            message: "near select".into(),
            position: Some(7),
        },
        QueryError::Connection {
            message: "refused".into(),
        },
        QueryError::Cancelled,
    ] {
        fits(&e);
    }
    for e in [Event::Progress(3), Event::Done { rows: 9 }, Event::Idle] {
        fits(&e);
    }
    for s in [Shape::Circle { r: 1.5 }, Shape::Point, Shape::Pair(1, 2)] {
        fits(&s);
    }
    fits(&Page {
        items: vec![Column {
            name: "a".into(),
            ty: ColumnType::Int,
            nullable: false,
        }],
        next: Some("cursor".into()),
    });
    fits(&WithFlatten {
        id: 1,
        meta: Meta {
            created_by: "u".into(),
            labels: vec!["l".into()],
        },
    });
    fits(&Tree {
        label: "root".into(),
        children: vec![Tree {
            label: "leaf".into(),
            children: vec![],
            attrs: Some(Box::new(BTreeMap::from([("k".into(), json!([1, "x"]))]))),
        }],
        attrs: None,
    });
    fits(&Code::ApprovalRequired);
    fits(&Fingerprint {
        sha256: [7; 32],
        pair: ["a".into(), "b".into()],
    });
    fits(&WithExtras {
        id: "x".into(),
        extra: BTreeMap::from([("rows".into(), 3), ("cols".into(), 4)]),
    });
}

#[test]
fn json_serde_would_not_produce_fits_neither_description() {
    // The Rust field name instead of the camelCase rename.
    misfits::<ExecuteSummary>(json!({
        "rows": 1, "elapsed_ms": 1, "truncated": false, "columns": [], "shape": [1, 2],
        "distinct": [],
    }));
    // The Rust name of a renamed field.
    misfits::<Column>(json!({"name": "a", "ty": "int", "nullable": false}));
    // A variant spelled as in Rust instead of `rename_all = "snake_case"`.
    misfits::<ColumnType>(json!("TimestampTz"));
    // Externally tagged enum written as if internally tagged.
    misfits::<Shape>(json!({"kind": "Point"}));
    // Unknown tag of an internally tagged enum.
    misfits::<QueryError>(json!({"kind": "Timeout"}));
    // Adjacent tagging without the content key.
    misfits::<Event>(json!({"t": "Progress"}));
    // A required field missing; a wrong tuple length; a non-string map value.
    misfits::<Column>(json!({"name": "a", "type": "int"}));
    misfits::<ExecuteSummary>(json!({
        "rows": 1, "elapsedMs": 1, "truncated": false, "columns": [], "shape": [1],
        "distinct": [],
    }));
    misfits::<BTreeMap<String, String>>(json!({"a": 1}));
    // A fixed-size array of the wrong length; a flattened map value of the wrong type.
    misfits::<Fingerprint>(json!({"sha256": vec![0; 31], "pair": ["a", "b"]}));
    misfits::<WithExtras>(json!({"id": "x", "rows": "three"}));
}

// Types where ts-rs is told something serde does not do: the checker must notice.

#[derive(Serialize, Deserialize, TS, JsonSchema)]
pub struct WrongType {
    #[ts(type = "string")]
    pub id: u32,
}

#[derive(Serialize, Deserialize, TS, JsonSchema)]
pub struct WrongName {
    #[ts(rename = "identifier")]
    pub id: u32,
}

#[derive(Serialize, Deserialize, TS, JsonSchema)]
pub struct WrongNullable {
    #[ts(type = "number | null")]
    pub id: u32,
}

/// TypeScript lets a client omit a field the server requires.
#[derive(Serialize, Deserialize, TS, JsonSchema)]
pub struct WrongOptional {
    #[ts(optional)]
    #[schemars(required)]
    pub id: Option<u32>,
}

/// Allowed: `Option` with `skip_serializing_if` is never sent as null.
#[derive(Serialize, Deserialize, TS, JsonSchema)]
pub struct SkippedOption {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub id: Option<u32>,
}

/// `#[serde(default)]`: a client may omit the field, so TypeScript must not require it.
#[derive(Serialize, Deserialize, TS, JsonSchema)]
pub struct DefaultRequired {
    #[serde(default)]
    pub n: u32,
}

#[derive(Serialize, Deserialize, TS, JsonSchema)]
pub enum WrongVariant {
    A,
    #[ts(rename = "C")]
    B,
}

#[test]
fn disagreements_are_detected() {
    for (name, result) in [
        ("type override", checker::<WrongType>().agree()),
        ("field rename", checker::<WrongName>().agree()),
        ("nullability", checker::<WrongNullable>().agree()),
        ("optionality", checker::<WrongOptional>().agree()),
        ("variant rename", checker::<WrongVariant>().agree()),
        ("required default", checker::<DefaultRequired>().agree()),
    ] {
        result.expect_err(name);
    }
    checker::<SkippedOption>().agree().unwrap();
}

#[test]
fn generation_fails_on_disagreement() {
    let router = Router::new(DenyAll);
    router
        .insert(
            declared("bad.get").with_types(ProcedureTypes::of::<WrongName, Result<(), RpcError>>()),
        )
        .unwrap();
    let err = codegen::generate(&router, &api()).unwrap_err();
    // A server cannot announce a hash for a contract rpc-gen refuses.
    assert_eq!(codegen::schema_hash(&router, &api()).unwrap_err(), err);
    let CodegenError::Disagreement(m) = &err else {
        panic!("{err}");
    };
    assert_eq!(m.path, "bad.get input");
    assert!(
        m.reason.contains("identifier") || m.reason.contains("id"),
        "{m}"
    );
}
