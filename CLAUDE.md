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
| `crates/security-types` | Principal, authz request/decision, audit record, async audit sink and failure reporter, clock (`SystemClock` behind feature `tokio`), correlation ids | MIT OR Apache-2.0 |
| `crates/ambidex`, `crates/ambidex-macros` | Ambidex dual-transport RPC engine and macros | MIT OR Apache-2.0 |
| `crates/ambidex-axum` | Ambidex WebSocket transport (`/rpc/ws`, rustls TLS, Host/Origin checks) | MIT OR Apache-2.0 |
| `crates/ambidex-tauri` | Ambidex Tauri IPC transport and desktop session (Tauri plugin) | MIT OR Apache-2.0 |
| `crates/ambidex-conformance` | Ambidex conformance suite: each case written once, run on in-process, WebSocket and Tauri (mock runtime) harnesses | MIT OR Apache-2.0 |
| `crates/plugin-host` | Plugin Host | MIT OR Apache-2.0 |
| `crates/db-driver` | db-driver contract (Rust trait + WIT); `conformance` feature for driver tests | MIT OR Apache-2.0 |
| `crates/db-driver-postgres` | First-party native PostgreSQL driver (sans-IO `postgres-protocol`, all I/O via the broker) | MIT OR Apache-2.0 |
| `packages/ambidex` | `@byterygon/ambidex` TypeScript runtime: `createClient`, WebSocket and Tauri transports, `autoTransport`, stream calls with credits, Worker Arrow decoding (`./arrow`, optional peer `apache-arrow`) | MIT OR Apache-2.0 |
| `packages/design-tokens` | `@byterygon/design-tokens`: seeds plus overrides to DTCG tokens (OKLCH ramps, the full catalogue of type, space, size, elevation, motion and domain tokens (text roles on Fluent 2's type ramp, Fluent 2 durations and curves, older names kept as aliases), Light/Dark and Comfortable/Compact modes, contrast checks, the layered (Fluent) roles: backdrop gradient, translucent layers, control strokes, double focus ring, depth shadows), seven presets in `themes/` (`aurora` is the Fluent look), `font.sans` the system's Segoe UI Variable (never shipped) then vendored Selawik, `font.mono` the system's Cascadia Mono then vendored JetBrains Mono, Inter kept (`fonts/`, all OFL), Style Dictionary outputs (`generated/<theme>/`), `by-tokens` CLI; see its `AGENTS.md` | MIT OR Apache-2.0 |
| `packages/ui` | `@byterygon/ui`: Base UI components styled with token roles only (`src/components/<name>/`, four files each, manifest validated), a static shadcn registry (`registry/`: components, `cn` and `theme-scope`, a theme item per preset, `llms.txt`), `pnpm ui:new`, gallery; see its `AGENTS.md` | MIT OR Apache-2.0 |
| `packages/theme-studio` | `@byterygon/theme-studio`: the Theme Studio, a static React app on Byterygon UI (`@/` = `packages/ui/src`) and the token engine in the browser: seeds panel, token editor with OKLCH values and contrast pairs, live preview of the components' examples, swatch board; state in the versioned URL hash and browser storage; builds to one classic script that runs from `file://`; see its `AGENTS.md` | MIT OR Apache-2.0 |
| `apps/dbee` | DBee product: `core/` (dbee-core: Ambidex router and the 19 procedures of the DBee spec §5, static Authorizer, workspace store (`settings.json`/`tabs.json` behind `app.getWorkspace`/`app.setWorkspace`), keychain or session-only secrets, hash-chained JSON Lines audit sink, SQL classifier, connection manager on the PostgreSQL driver through the Plugin Host broker, export encoders), `rpc-gen/` (writes `ui/src/gen/api.ts` and `api.manifest.json`, committed and drift-checked by `cargo test -p dbee-core`), `server/` (dbee-server: axum + ambidex-axum at `/rpc/ws` over rustls TLS, Host allowlist and public origin, static UI with CSP, `audit verify`; no login before Ambidex M3, its e2e test runs in CI's network namespace), `desktop/` (dbee-desktop: Tauri 2 app on `ambidex-tauri`, capability for the `main` window only, `ambidex_tauri::CSP`, no listener, native save dialog behind `files.chooseSavePath`, cold start printed on stderr and measured in CI under Xvfb; `frontendDist` is a placeholder page until the UI batch), `ui/` (`@byterygon/dbee`: React 19 + Vite + Tailwind v4 on the Byterygon UI items copied from `packages/ui/registry` by `scripts/sync-ui.ts` (drift-checked), one `createClient(autoTransport())`, Arrow decoded in a Worker, the screens of the spec with the §8 states and §9 shortcuts, tabs and settings in the workspace (`src/app/workspace.ts`, one-time migration from the old localStorage key), a minimal table until TSK-39; `pnpm --filter @byterygon/dbee build` writes `dist/`, which the desktop embeds and the server serves) | AGPL-3.0-only |

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
pnpm install --frozen-lockfile && pnpm typecheck && pnpm build && pnpm test
node scripts/check-licenses.mjs
cargo deny check licenses bans sources
cargo run -p ambidex-conformance --bin rpc-gen -- --check   # drop --check to regenerate
```

The PostgreSQL driver tests start a throwaway server from `initdb`/`postgres` and need a
non-root user; without them they skip, unless `BYTERYGON_REQUIRE_POSTGRES=1` (set in CI).

CI (`.github/workflows/ci.yml`) runs all of the above (the `rpc-gen --check` as the drift test in
`crates/ambidex-conformance/tests/codegen.rs`) plus a gitleaks scan of the full history, and runs
`cargo test -p ambidex-conformance --offline` again inside a network namespace with only
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

Design tokens (TSK-40, TSK-41): `packages/design-tokens/generated/<theme>/` is generated from
`themes/<theme>.theme.json` and committed (all eight files for `default`, the three CSS files for the other
presets); its drift test fails when any is stale. Regenerate with
`pnpm --filter @byterygon/design-tokens build && pnpm --filter @byterygon/design-tokens tokens build --theme <name>`
(`default` when omitted). `scripts/check-licenses.mjs` also checks the vendored fonts' licences and checksums.

Byterygon UI (TSK-42): `packages/ui/registry/` is generated from the components and the token
presets and committed; its drift test fails when stale (`pnpm --filter @byterygon/ui registry`
rewrites it, so rerun it after changing tokens too). `pnpm ui:new <name>` scaffolds a component;
`pnpm --filter @byterygon/ui verify:install` installs the registry with the real shadcn CLI into a
blank Vite app, offline (CI runs it in the network namespace).

DBee UI (TSK-38): `apps/dbee/ui` is a nested pnpm workspace package (`pnpm-workspace.yaml` lists it).
Its Byterygon UI items are copies of registry items (`src/components/ui`, `src/lib`), rewritten by
`pnpm --filter @byterygon/dbee sync:ui` and checked by its tests; rerun it after changing
`packages/ui`. The Rust CI job builds the UI first so `dbee-desktop` embeds it; a Rust-only build
without `apps/dbee/ui/dist` falls back to the placeholder page (build.rs warns).

Editors (TSK-46): SqlEditor is Monaco through `packages/ui/src/lib/monaco.ts` (lazy ESM, the
worker via Vite `?worker`, never a CDN or the AMD loader; theme built from the tokens at the
editor); CodeInput is CodeMirror 6 themed by the token CSS variables (its DOM sits in a
`data-foreign-dom` element the conventions suite skips). jsdom tests use `test/fakes/monaco.ts`; `pnpm --filter @byterygon/ui check:browser` runs
the real editor in Chromium over CDP and reports bundle size and time to first keystroke (CI: the
runner's Chrome, network namespace, `BYTERYGON_REQUIRE_BROWSER=1`; locally it skips without a
browser, `BYTERYGON_BROWSER` names one).

**Base UI only (Uy Son, 2026-11-14).** Every Byterygon UI component, example, fixture and app
(`packages/ui`, `packages/theme-studio`, DBee screens) is built on Base UI (`@base-ui/react`).
Never Radix (`radix-ui`, `@radix-ui/*`) or another primitive library. When a stock shadcn/ui item
is needed as a reference or a test fixture, take it from a Base UI style
(`https://ui.shadcn.com/r/styles/base-nova/<name>.json`), never `new-york` (Radix). Two libraries
fill the gaps, also Uy Son's decision: dates and times (Calendar, DatePicker, TimePicker) use
`react-day-picker` with `date-fns`, as shadcn's Calendar does, styled with token roles; form state,
fields and validation (Field/Form and the inputs wired to it) use TanStack Form
(`@tanstack/react-form`), with Base UI's Field parts for labels, descriptions and errors. Anything
else Base UI lacks is built on `useRender` and its parts; record the choice in the spec's Open
questions.

## Offline builds

On a connected machine, run `cargo vendor --locked vendor` and copy its printed source
replacement into `.cargo/config.toml`; transfer the vendor directory and configuration to the
offline environment, then build with `cargo build --workspace --locked --offline`. An internal
crates mirror is another option. Keep the pinned Rust toolchain available locally as well.

For Node dependencies, run `pnpm fetch --frozen-lockfile` while connected, transfer the pnpm
store, then run `pnpm install --frozen-lockfile --offline` with that store configured. An internal
registry mirror can supply the store instead. Provision the pinned Node and pnpm versions too.
These are deployment steps; no vendor directory or source replacement is committed here.

## Notion links

- Agent Guide: https://app.notion.com/p/4037c4201bbd814ab233fe141cb19ad5
- ADR Repository layout and licensing: https://app.notion.com/p/4037c4201bbd8165af4ec2eeeb4aca3c
- Setup guide (parallel Claude Code + Codex): https://app.notion.com/p/4037c4201bbd81df90edc4152dd001c7
