# Byterygon platform

Monorepo for Byterygon's open-source libraries and products: tools for engineers, built for
**air-gapped and self-hosted** environments. Assume nothing may reach the internet at runtime.

The source of truth is the Byterygon Notion workspace (connected through `.mcp.json`). This file
summarises what a session needs when Notion is unavailable.

## Working rules (Notion: Agent Guide, section 9)

- Take only tasks in the Notion **Tasks** database whose Owner is you (Claude Code = `Claude`,
  Codex = `ChatGPT`), whose Status is `Todo`, and whose **Blocked by** tasks are all `Done`.
  Set the task to `In progress` before writing code.
- One task = one worktree = one branch = one PR. Branch name: `tsk-<number>-<short-slug>`.
  Never commit to `main`.
- The task's **Related docs** are the spec. If a spec is silent or wrong, don't invent the
  decision: add it to the spec's Open questions, tick **Needs human**, and continue with the rest.
- Security work (auth, grants, secrets, TLS, audit) follows the spec exactly, or stops and asks.
- Rebase on `main` before opening the PR. Keep edits to shared files (`Cargo.toml`, lockfiles,
  CI) minimal and list them in the PR description.
- Put the task link in the PR, the PR link in the task, and add a **Work Log** entry when done.

## Layout (ADR "Repository layout and licensing")

| Path | What | License |
| --- | --- | --- |
| `crates/security-types` | Principal, authz request/decision, audit record | MIT OR Apache-2.0 |
| `crates/ambidex`, `crates/ambidex-macros` | Ambidex dual-transport RPC engine and macros | MIT OR Apache-2.0 |
| `crates/ambidex-axum` | Ambidex WebSocket transport (`/rpc/ws`, rustls TLS, Host/Origin checks) | MIT OR Apache-2.0 |
| `crates/ambidex-tauri` | Ambidex Tauri IPC transport and desktop session (Tauri plugin) | MIT OR Apache-2.0 |
| `crates/ambidex-conformance` | Ambidex conformance suite: each case written once, run on in-process, WebSocket and Tauri (mock runtime) harnesses | MIT OR Apache-2.0 |
| `crates/plugin-host` | Plugin Host | MIT OR Apache-2.0 |
| `crates/db-driver` | db-driver contract (Rust trait + WIT); `conformance` feature for driver tests | MIT OR Apache-2.0 |
| `crates/db-driver-postgres` | First-party native PostgreSQL driver (sans-IO `postgres-protocol`, all I/O via the broker) | MIT OR Apache-2.0 |
| `packages/ambidex` | `@byterygon/ambidex` TypeScript client | MIT OR Apache-2.0 |
| `apps/dbee` | DBee product (placeholder) | AGPL-3.0-only |

- Every `Cargo.toml` and `package.json` declares `license` explicitly. New crates/packages in
  `crates/` or `packages/` use `MIT OR Apache-2.0`; products in `apps/` use `AGPL-3.0-only` and
  carry their own `LICENSE`.
- Permissive code must **never** depend on AGPL code. `scripts/check-licenses.mjs` and
  `cargo-deny` (`deny.toml`) enforce this in CI.
- Crate names are provisional (`security-types` in particular is "name TBD" in Notion); rename in
  the task that fills the crate.

## Commands

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm install --frozen-lockfile && pnpm typecheck
node scripts/check-licenses.mjs
cargo deny check licenses bans sources
cargo run -p ambidex-conformance --bin rpc-gen -- --check   # drop --check to regenerate
```

The PostgreSQL driver tests start a throwaway server from `initdb`/`postgres` and need a
non-root user; without them they skip, unless `BYTERYGON_REQUIRE_POSTGRES=1` (set in CI).

CI (`.github/workflows/ci.yml`) runs all of the above (the `rpc-gen --check` as the drift test in
`crates/ambidex-conformance/tests/codegen.rs`) plus a gitleaks scan of the full history, and runs `cargo test -p ambidex-conformance --offline` again inside a network namespace with only
loopback (spec §12: the suite must pass network-disconnected). Protocol behaviour that must hold
on every transport goes in `crates/ambidex-conformance/src/cases.rs`, not in one transport's tests.
The Rust toolchain is pinned in `rust-toolchain.toml`; pnpm is pinned via `packageManager`.

Codegen (spec §2, TSK-7): `#[rpc::router]` attaches ts-rs and schemars types to every procedure;
`ambidex::codegen` turns a `Router` into `api.ts` and `api.manifest.json` (with the schema hash the
server puts in `ServerConfig`) and fails if ts-rs and schemars disagree. Procedure input/output
types therefore derive `TS` and `JsonSchema`. Inputs are checked as serde reads them, outputs as
it writes them: `#[serde(default)]` fields need `#[ts(optional = nullable)]` (clients may omit
them), `skip_serializing_if` fields `#[ts(optional)]` (the server may leave them out). The fixture
API's generated files live in `packages/ambidex/test/conformance/` and are committed; CI fails
when they are stale.

## Notion links

- Agent Guide: https://app.notion.com/p/4037c4201bbd814ab233fe141cb19ad5
- ADR Repository layout and licensing: https://app.notion.com/p/4037c4201bbd8165af4ec2eeeb4aca3c
- Setup guide (parallel Claude Code + Codex): https://app.notion.com/p/4037c4201bbd81df90edc4152dd001c7
