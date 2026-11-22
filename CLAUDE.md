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
| `crates/*` | Rust libraries: security-types, Ambidex (engine, macros, axum, tauri, conformance), plugin-host, db-driver(-postgres), message-codecs | MIT OR Apache-2.0 |
| `packages/*` | TypeScript: ambidex, design-tokens, ui, lint, mcp, data-grid, theme-studio | MIT OR Apache-2.0 |
| `apps/dbee` | DBee: core, rpc-gen, server, desktop, ui | AGPL-3.0-only |
| `apps/mightyconsole` | Mightyconsole: server, rpc-gen, ui, lab, release, acceptance | AGPL-3.0-only |

- Every `Cargo.toml` and `package.json` declares `license` explicitly. New crates/packages in
  `crates/` or `packages/` use `MIT OR Apache-2.0`; products in `apps/` use `AGPL-3.0-only` and
  carry their own `LICENSE`.
- Permissive code must **never** depend on AGPL code. `scripts/check-licenses.mjs` and
  `cargo-deny` (`deny.toml`) enforce this in CI.
- Crate names are provisional (`security-types` in particular is "name TBD" in Notion); rename in
  the task that fills the crate.
- What each path holds in detail: `docs/agents/layout.md`; package notes in `packages/*/AGENTS.md`.

## UI: Base UI only (Uy Son, 2026-11-14)

Every UI component, example and app is built on `@base-ui/react`, never Radix. Dates use
`react-day-picker` + `date-fns`, forms TanStack Form. Read `docs/agents/ui.md` before UI work.

## Commands

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
pnpm install --frozen-lockfile && pnpm typecheck && pnpm build && pnpm lint && pnpm test
node scripts/check-licenses.mjs
cargo deny check licenses bans sources
cargo run -p ambidex-conformance --bin rpc-gen -- --check   # drop --check to regenerate
```

The PostgreSQL driver tests start a throwaway server from `initdb`/`postgres` and need a
non-root user; without them they skip, unless `BYTERYGON_REQUIRE_POSTGRES=1` (set in CI).

- Pull requests run only what is affected: `node scripts/affected.mjs --pretty`. A new JS-Rust
  dependency needs a line in `scripts/affected-rules.mjs`.
- Generated files are committed and drift-checked: read `docs/agents/generated-files.md` before
  changing a router, the tokens, `packages/ui` or the DBee UI items.
- What CI runs and where (network namespace, CI image, where protocol tests go): `docs/agents/ci.md`.
- Offline builds (vendoring, pnpm store): `docs/agents/offline-builds.md`.

## Notion links

- Agent Guide: https://app.notion.com/p/4037c4201bbd814ab233fe141cb19ad5
- ADR Repository layout and licensing: https://app.notion.com/p/4037c4201bbd8165af4ec2eeeb4aca3c
- Setup guide (parallel Claude Code + Codex): https://app.notion.com/p/4037c4201bbd81df90edc4152dd001c7
