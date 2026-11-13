//! The committed `api.ts` and `api.manifest.json` of the benchmark API are current (Ambidex spec
//! §2: CI fails on drift) and carry the schema hash the server announces.

use ambidex::codegen;
use ambidex_bench::{api_info, generated_dir, router, schema_hash};

#[test]
fn committed_artifacts_match_the_router() {
    let output = codegen::generate(&router(None), &api_info()).unwrap_or_else(|e| panic!("{e}"));
    let stale = codegen::check(&output, &generated_dir()).unwrap_or_else(|e| panic!("{e}"));
    assert!(
        stale.is_empty(),
        "stale generated files {stale:?}; regenerate with `cargo run -p ambidex-bench --bin bench-gen`"
    );
    let api_ts = std::fs::read_to_string(generated_dir().join(codegen::API_TS)).unwrap();
    assert!(api_ts.contains(&format!(
        "export const SCHEMA_HASH = \"{}\";",
        schema_hash()
    )));
}
