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
    // Test binaries link the same WebView2/Win32 stack as the app but get no manifest from
    // tauri-build (it embeds one for the bin only). Without common controls v6 they fail to start
    // with STATUS_ENTRYPOINT_NOT_FOUND, so the tests embed a manifest that asks for it.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("windows-test.manifest");
        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}", manifest.display());
    }
    tauri_build::build()
}
