//! Writes `api.ts` and `api.manifest.json` for the benchmark API (Ambidex spec §2).
//!
//! ```text
//! cargo run -p ambidex-bench --bin bench-gen            # regenerate
//! cargo run -p ambidex-bench --bin bench-gen -- --check # fail if the committed files are stale
//! ```

use std::process::ExitCode;

use ambidex_bench::{api_info, generated_dir, router};

fn main() -> ExitCode {
    ambidex::codegen::cli(&router(None), &api_info(), &generated_dir())
}
