#!/bin/sh
set -eu
spike_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$spike_dir"
# Run sequentially: these measurements must not compete with one another.
cargo run --release --manifest-path rust/Cargo.toml --offline --locked --bin bench > results/rust-bench.json
node --expose-gc ts/bench.mjs
node ts/browser-bench.mjs
node ts/transport-bench.mjs
node ts/bundle.mjs
node ts/summarize.mjs
node ts/analyze.mjs
