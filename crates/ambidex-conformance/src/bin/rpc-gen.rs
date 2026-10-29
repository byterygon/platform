//! Writes `api.ts` and `api.manifest.json` for the fixture API (Ambidex spec §2).
//!
//! ```text
//! cargo run -p ambidex-conformance --bin rpc-gen            # regenerate
//! cargo run -p ambidex-conformance --bin rpc-gen -- --check # fail if the committed files are stale
//! ```
//!
//! The router is the one every harness serves, so the artifacts describe exactly what the
//! conformance servers run. Output goes to `packages/ambidex/test/conformance` unless `--out` says
//! otherwise.

use std::process::ExitCode;

use ambidex_conformance::fixture::{Fixture, api_info, generated_dir};

fn main() -> ExitCode {
    ambidex::codegen::cli(&Fixture::new().router(), &api_info(), &generated_dir())
}
