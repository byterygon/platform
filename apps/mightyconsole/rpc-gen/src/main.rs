//! Writes `api.ts` and `api.manifest.json` for the Mightyconsole API (Ambidex spec §2,
//! Mightyconsole spec §2.1).
//!
//! ```text
//! cargo run -p mightyconsole-rpc-gen            # regenerate apps/mightyconsole/ui/src/gen
//! cargo run -p mightyconsole-rpc-gen -- --check # fail if the committed files are stale
//! ```
//!
//! The router is the one the server serves ([`mightyconsole_server::codegen_router`]).
//! `cargo test -p mightyconsole-server` includes the drift test (`tests/codegen.rs`), so CI fails
//! when the committed files are stale.

use std::process::ExitCode;

fn main() -> ExitCode {
    ambidex::codegen::cli(
        &mightyconsole_server::codegen_router(),
        &mightyconsole_server::api_info(),
        &mightyconsole_server::generated_dir(),
    )
}
