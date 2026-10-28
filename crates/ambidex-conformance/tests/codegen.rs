//! The committed `api.ts` and `api.manifest.json` of the fixture API are current (Ambidex spec
//! §2: CI fails on drift), and describe the servers the harnesses start.

use ambidex::codegen;
use ambidex_conformance::fixture::{Fixture, SCHEMA_HASH, api_info, generated_dir};

#[test]
fn committed_artifacts_match_the_fixture_router() {
    let output =
        codegen::generate(&Fixture::new().router(), &api_info()).unwrap_or_else(|e| panic!("{e}"));
    let stale = codegen::check(&output, &generated_dir());
    assert!(
        stale.is_empty(),
        "stale generated files {stale:?}; regenerate with \
         `cargo run -p ambidex-conformance --bin rpc-gen`"
    );
}

#[test]
fn servers_announce_the_generated_schema_hash() {
    let manifest = std::fs::read_to_string(generated_dir().join(codegen::MANIFEST_JSON)).unwrap();
    let manifest: serde_json::Value = serde_json::from_str(&manifest).unwrap();
    assert_eq!(manifest["schema_hash"], SCHEMA_HASH.as_str());
    let api_ts = std::fs::read_to_string(generated_dir().join(codegen::API_TS)).unwrap();
    assert!(api_ts.contains(&format!("export const SCHEMA_HASH = \"{}\";", *SCHEMA_HASH)));
}
