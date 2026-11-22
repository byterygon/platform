# Offline builds

Moved from the repository's CLAUDE.md (TSK-126), unchanged. CLAUDE.md points here.

On a connected machine, run `cargo vendor --locked vendor` and copy its printed source
replacement into `.cargo/config.toml`; transfer the vendor directory and configuration to the
offline environment, then build with `cargo build --workspace --locked --offline`. An internal
crates mirror is another option. Keep the pinned Rust toolchain available locally as well.

For Node dependencies, run `pnpm fetch --frozen-lockfile` while connected, transfer the pnpm
store, then run `pnpm install --frozen-lockfile --offline` with that store configured. An internal
registry mirror can supply the store instead. Provision the pinned Node and pnpm versions too.
These are deployment steps; no vendor directory or source replacement is committed here.
