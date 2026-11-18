//! With the `embed-ui` feature (the release build, TSK-87), every file of the built UI is
//! compiled into the binary, so one file is the whole app: `include_bytes!` per file, listed in
//! `$OUT_DIR/embedded_ui.rs` and sorted by path. The UI is `apps/mightyconsole/ui/dist`, or the
//! directory named by `MIGHTYCONSOLE_UI_DIST`; build it first with
//! `pnpm --filter @byterygon/mightyconsole build`. Without the feature the list is empty and the
//! server serves `--ui DIR` or its placeholder page, as before.

//! The Temporal client (TSK-83): the vendored `temporalio/api` protos in `proto/temporal/` are
//! compiled by `protox` (pure Rust, no `protoc`, works offline) and `tonic-prost-build` writes the
//! `WorkflowService` client and the messages into `$OUT_DIR`. See `proto/temporal/README.md`.

use std::env;
use std::fs;
use std::path::{Path, PathBuf};

fn main() {
    compile_temporal_protos();
    println!("cargo::rerun-if-env-changed=MIGHTYCONSOLE_UI_DIST");
    println!("cargo::rerun-if-env-changed=MIGHTYCONSOLE_VERSION");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    let target = out.join("embedded_ui.rs");
    if env::var_os("CARGO_FEATURE_EMBED_UI").is_none() {
        fs::write(
            &target,
            "/// No UI embedded: built without the `embed-ui` feature.\n\
             pub static FILES: &[(&str, &[u8])] = &[];\n",
        )
        .expect("write embedded_ui.rs");
        return;
    }

    let manifest = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("cargo sets it"));
    let dist = env::var_os("MIGHTYCONSOLE_UI_DIST")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| manifest.join("../ui/dist"));
    println!("cargo::rerun-if-changed={}", dist.display());
    let dist = fs::canonicalize(&dist).unwrap_or_else(|e| {
        panic!(
            "embed-ui: the built UI is missing at {} ({e}); run \
             `pnpm --filter @byterygon/mightyconsole build` first or set MIGHTYCONSOLE_UI_DIST",
            dist.display()
        )
    });
    assert!(
        dist.join("index.html").is_file(),
        "embed-ui: {} has no index.html; build the UI first",
        dist.display()
    );

    let mut files = Vec::new();
    collect(&dist, &dist, &mut files);
    files.sort();
    let mut code = String::from(
        "/// The built UI, `(path relative to dist with '/', bytes)`, sorted by path.\n\
         pub static FILES: &[(&str, &[u8])] = &[\n",
    );
    for (relative, absolute) in &files {
        println!("cargo::rerun-if-changed={}", absolute.display());
        code.push_str(&format!(
            "    ({relative:?}, include_bytes!({:?})),\n",
            absolute.display().to_string()
        ));
    }
    code.push_str("];\n");
    fs::write(&target, code).expect("write embedded_ui.rs");
}

/// Every regular file under `dir`, with its path relative to `root` joined by '/'.
fn collect(root: &Path, dir: &Path, files: &mut Vec<(String, PathBuf)>) {
    let mut entries: Vec<_> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("embed-ui: read {}: {e}", dir.display()))
        .map(|e| e.expect("a directory entry"))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let kind = entry.file_type().expect("a file type");
        if kind.is_dir() {
            collect(root, &path, files);
        } else if kind.is_file() {
            let relative = path
                .strip_prefix(root)
                .expect("under the root")
                .components()
                .map(|c| c.as_os_str().to_str().expect("UTF-8 file names in dist"))
                .collect::<Vec<_>>()
                .join("/");
            files.push((relative, path));
        }
    }
}

/// Compiles the vendored Temporal API (the `WorkflowService` and `OperatorService` clients) with `protox`, so that building needs neither
/// `protoc` nor the network. The descriptor set is also written to `$OUT_DIR`, so that the server
/// can turn any message of the API into JSON at run time (history events, payloads).
fn compile_temporal_protos() {
    let root = PathBuf::from("proto/temporal");
    println!("cargo::rerun-if-changed={}", root.display());
    let mut compiler = protox::Compiler::new([&root]).expect("open the vendored Temporal protos");
    compiler
        .include_imports(true)
        .open_files([
            "temporal/api/workflowservice/v1/service.proto",
            // `ListSearchAttributes` per namespace, for the query editor's completion (TSK-93).
            "temporal/api/operatorservice/v1/service.proto",
        ])
        .expect("compile the vendored Temporal protos");
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("cargo sets OUT_DIR"));
    fs::write(
        out.join("temporal_descriptor.bin"),
        compiler.encode_file_descriptor_set(),
    )
    .expect("write temporal_descriptor.bin");
    tonic_prost_build::configure()
        .build_server(false)
        .build_client(true)
        .compile_fds(compiler.file_descriptor_set())
        .expect("generate the Temporal client");
}
