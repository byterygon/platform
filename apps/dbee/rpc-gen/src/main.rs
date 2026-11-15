//! Writes `api.ts` and `api.manifest.json` for the DBee API (Ambidex spec §2, DBee spec §5).
//!
//! ```text
//! cargo run -p dbee-rpc-gen            # regenerate apps/dbee/ui/src/gen
//! cargo run -p dbee-rpc-gen -- --check # fail if the committed files are stale
//! ```
//!
//! The router is the one both shells serve ([`dbee_core::codegen_router`]), so the artifacts
//! describe exactly what the desktop and web servers run. `cargo test -p dbee-core` includes the
//! drift test (`tests/codegen.rs`), so CI fails when the committed files are stale.

use std::process::ExitCode;

fn main() -> ExitCode {
    ambidex::codegen::cli(
        &dbee_core::codegen_router(),
        &dbee_core::api_info(),
        &dbee_core::generated_dir(),
    )
}
