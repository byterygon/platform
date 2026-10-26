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
| `crates/plugin-host` | Plugin Host | MIT OR Apache-2.0 |
| `crates/db-driver` | db-driver contract (Rust trait + WIT) | MIT OR Apache-2.0 |
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
```

CI (`.github/workflows/ci.yml`) runs all of the above plus a gitleaks scan of the full history.
The Rust toolchain is pinned in `rust-toolchain.toml`; pnpm is pinned via `packageManager`.

## Notion links

- Agent Guide: https://app.notion.com/p/4037c4201bbd814ab233fe141cb19ad5
- ADR Repository layout and licensing: https://app.notion.com/p/4037c4201bbd8165af4ec2eeeb4aca3c
- Setup guide (parallel Claude Code + Codex): https://app.notion.com/p/4037c4201bbd81df90edc4152dd001c7
