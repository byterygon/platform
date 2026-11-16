// Tauri's build step: generates the capability schemas and embeds `frontendDist`.
//
// `frontendDist` is the built UI (`apps/dbee/ui/dist`, `pnpm --filter @byterygon/dbee build`).
// A Rust-only build without it (a contributor who has no Node, `cargo test --workspace` on its
// own) still compiles: the placeholder page stands in, through Tauri's `TAURI_CONFIG` override,
// and the build prints why. CI builds the UI first, so the app it measures and ships is the real one.
use std::path::Path;

fn main() {
    let dist = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui/dist/index.html");
    println!("cargo:rerun-if-changed={}", dist.display());
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    if !dist.is_file() && std::env::var_os("TAURI_CONFIG").is_none() {
        println!(
            "cargo:warning=apps/dbee/ui/dist is missing: embedding the placeholder page (run `pnpm --filter @byterygon/dbee build` for the real UI)"
        );
        println!(r#"cargo:rustc-env=TAURI_CONFIG={{"build":{{"frontendDist":"ui-placeholder"}}}}"#);
    }
    tauri_build::build()
}
