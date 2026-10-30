#!/bin/sh
set -eu
spike_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$spike_dir"
cargo build --manifest-path rust/Cargo.toml --workspace --offline --locked
cargo run --manifest-path rust/Cargo.toml --offline --locked --bin fingerprint > results/fingerprints.json
node ts/export.mjs
cargo fmt --manifest-path rust/Cargo.toml --all --check
cargo clippy --manifest-path rust/Cargo.toml --offline --locked --workspace --all-targets -- -D warnings
cargo test --manifest-path rust/Cargo.toml --offline --locked --workspace > results/rust-tests.txt 2>&1
(cd ts && pnpm typecheck && pnpm format:check)
node --test ts/*.test.mjs > results/js-tests.txt
node ts/fuzz.mjs
