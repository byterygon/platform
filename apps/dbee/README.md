# DBee

DBee is Byterygon's database client: a keyboard-first PostgreSQL client for engineers in
air-gapped and self-hosted environments, built on the Byterygon platform (Ambidex RPC, Plugin
Host, the db-driver contract, Byterygon UI). Licensed under AGPL-3.0-only (see `LICENSE`), unlike
the permissively licensed libraries in `crates/` and `packages/`. Permissive code never depends on
this directory.

The product is specified in the Notion Docs page **"DBee: UX and app spec for the first usable
version"** (TSK-37), summarised below; TSK-38 (app skeleton) and TSK-39 (data grid) implement it.
The spec is the source of truth; this file only orients a reader. `core/`, `rpc-gen/`,
`server/`, `desktop/` and `ui/` exist (TSK-38); the results use the data grid (TSK-39, `packages/data-grid`).

## The first usable version

One engineer can replace `psql` plus a spreadsheet for daily PostgreSQL work:

- **Connect.** Add a personal connection. Creating it *is* the Plugin Host grant: the form (name,
  host, port, database, user, password, TLS policy, allowed addresses, cancel connection, expiry)
  is turned into a preview by the core, and an approval dialog shows exactly what will be granted
  (driver and digest, exact host and port, the addresses resolved right now, TLS policy, expiry).
  Passwords live in the OS keychain only; without a keychain DBee asks per session and stores
  nothing. TLS options are exactly the Plugin Host set; no "accept any certificate", no fallback
  to plaintext. Nothing can connect before the grant exists, so there is no "test" before approval.
- **Browse.** Schemas, tables and views, columns, loaded lazily into one tree with the connections.
- **Run SQL.** A Monaco editor per tab, one database session per tab, autocommit. `Ctrl+Enter` runs
  the selection or the statement under the cursor; `Shift+Escape` cancels and the cancel reaches
  the database. Destructive statements are confirmed first. Errors show the position and SQLSTATE.
- **See results.** A virtualized grid (`@byterygon/data-grid`, its own permissive package) reads
  the Arrow buffers decoded in a Worker directly: rows appear as batches arrive, a million rows
  scroll, credits follow what the grid has taken, `NULL` is distinct from the empty string, Int64
  never loses precision. Select, copy as TSV/CSV/JSON, open a cell value.
- **Export.** CSV, TSV or JSON Lines; the core re-runs the statement and encodes. Desktop writes to
  a file chosen through a native dialog opened by the core; web downloads.

Out of scope for now: team mode and managed connections (Ambidex M5), web login, app lock and
encrypted SQL text in audit (Ambidex M3), agents and MCP (Ambidex M4), other databases and WASM
drivers (Plugin Host M2), scripts, transactions UI, history, autocomplete, data editing, sorting
and filtering in the grid.

## Shells

Standalone desktop (Tauri 2) is the primary shell: no network listener, strict CSP, the local OS
user is the principal, no login. The self-hosted web shell (axum, TLS, `/rpc/ws`, Host and Origin
checks) builds, serves the same UI over the same Ambidex API and passes an automated end-to-end
test with a server-issued session, but has no human login until Ambidex M3 delivers OIDC, the only
login method the specs allow.

## Layout

```
apps/dbee/core      dbee-core      router + procedures, connection manager, workspace, secret store, audit sink  (done)
apps/dbee/rpc-gen   dbee-rpc-gen   writes ui/src/gen/api.ts and api.manifest.json (committed, drift-checked)   (done)
apps/dbee/desktop   dbee-desktop   Tauri 2 app (ambidex-tauri, capability, CSP, native save dialog)           (done)
apps/dbee/server    dbee-server    axum binary (ambidex-axum, static UI, TLS, Host/Origin config, audit verify) (done)
apps/dbee/ui        @byterygon/dbee React 19 + Vite; @byterygon/ambidex, Byterygon UI registry items; the grid is TSK-39 (done)
packages/data-grid  @byterygon/data-grid  the virtualized Arrow grid (MIT OR Apache-2.0, TSK-39)
```

### dbee-core

One crate, linked by both shells, so there is exactly one router, Authorizer, audit sink and
connection manager. A shell calls `Core::start(CoreConfig)` and serves `Core::router()` with
`Core::server_config()` through `ambidex-tauri` or `ambidex-axum`.

- **Workspace** (`workspace.rs`): `DBEE_WORKSPACE` or `dirs::data_dir()/dbee/workspace`;
  `connections.json` (grants as approved, driver settings, a secret *reference*, never a value),
  `settings.json`, `tabs.json` (the UI's documents, read and written whole through
  `app.getWorkspace` / `app.setWorkspace` under one revision; a write against a stale revision is
  a `Conflict`), written atomically. The audit log is `audit/log.jsonl`.
- **Secrets** (`secrets.rs`): the OS keychain through `keyring` (service `dbee`, account = the
  secret reference), probed at startup. Without a keychain nothing is persisted: creating a
  connection with a password fails with `SecretStoreUnavailable`, and a password given later
  through `connections.setSecret` lives in memory for this process only (spec Open question 2).
- **Audit** (`audit.rs`): append-only, hash-chained JSON Lines, fsync per entry, verified on open;
  Plugin Host grant and broker entries carry the `parent_correlation_id` of the DBee call. A log
  that cannot be opened fails closed: every recorded call answers `Unavailable`. `audit::verify` is
  the checker behind `dbee-server audit verify`.
- **Authorizer** (`authz.rs`): static; the local human holds every DBee permission, any chain with
  an agent or plugin is denied, unknown permissions are denied.
- **Connections** (`manager.rs`): `connections.prepare` resolves the host and builds the
  `GrantPreview` with its digest; `connections.create` rebuilds it from the draft, refuses a stale
  preview, stores the password, then creates the grant with the caller as approver (a chain with
  `on_behalf_of` is refused) and only then writes the record. Grants are rebuilt at startup from
  the records (audit detail `origin = workspace_restore`). Sessions open through a broker scope
  bound to the calling principal; a connection's browser session is reused.
- **Queries** (`api.rs`, `classify.rs`): `query.execute` classifies the SQL fail-closed,
  re-authorizes with the connection target at the escalated risk, forwards the driver's Arrow IPC
  chunks only when the client has a credit, and on Cancel calls the driver's
  `ResultStream::cancel`. `export.run` decodes the chunks and encodes CSV, TSV or JSON Lines.

```sh
cargo test -p dbee-core                      # unit, router and engine tests (fake driver)
BYTERYGON_REQUIRE_POSTGRES=1 cargo test -p dbee-core --test postgres   # throwaway cluster, non-root
cargo run -p dbee-rpc-gen -- --check         # the committed ui/src/gen is current
```

### dbee-server

The self-hosted web shell: the same core behind `ambidex-axum`. One binary WebSocket per tab at
`/rpc/ws` over rustls TLS (PEM certificate and key from `--tls-cert`/`--tls-key`), every request
behind the `--allowed-host` list (DNS rebinding), the upgrade behind the exact `--public-origin`
(cross-site WebSocket hijacking) and a server-side session whose anti-CSRF token the Hello must
carry. The built UI (`--ui DIR`, batch 4) is served next to it with a strict
Content-Security-Policy (`'self'`, the WebSocket to the public origin, `worker-src 'self'` for the
Arrow Worker, no frames), resolved only inside that directory. Plain HTTP is never served.

```sh
cargo run -p dbee-server -- serve --tls-cert cert.pem --tls-key key.pem \
  --allowed-host dbee.example.com --public-origin https://dbee.example.com \
  --bind 0.0.0.0:443 --workspace /var/lib/dbee --ui apps/dbee/ui/dist
cargo run -p dbee-server -- audit verify /var/lib/dbee/audit/log.jsonl   # exit 0 when the chain verifies
```

**No human can log in before Ambidex M3** (spec Open question 1, Decision 2): the specs allow no
login method but OIDC, so the server starts with an empty session table and refuses every
`/rpc/ws` upgrade. `tests/e2e.rs` issues a session server-side and runs the whole flow (add a
connection, approve it, run a query, receive Arrow chunks over the WebSocket) against a throwaway
PostgreSQL; CI runs it in a network namespace with only loopback. The server runs the core in
`server` mode with the session-only secret store (spec §11: no per-user secret storage before a
logged-in user exists; a headless host's keychain is never touched) and the audit log on its own
workspace path, the same hash-chained sink as the desktop until M3.

### dbee-desktop

The Tauri 2 app: the same core behind the `ambidex-tauri` plugin (`plugin:ambidex|connect`,
`send`, `close`; one Tauri `Channel` per connection carrying raw frames). `capabilities/main.json`
grants the plugin to the bundled `main` window only (`local: true`, no `remote` section) and the
hub refuses other webviews; `tauri.conf.json` carries `ambidex_tauri::CSP` verbatim (`'self'`, the
IPC origins, `worker-src 'self'` for the Arrow Worker, nothing remote) and no `devUrl`, so the app
opens no network listener and loads only bundled content. The principal is
`human:local:<os-user>` from the process environment, tenant `local`, through the same Authorizer
and audit sink as the web shell. `files.chooseSavePath` opens the native save dialog
(`tauri-plugin-dialog`) from the core and hands the webview a one-time handle, never a path.

```sh
cargo run -p dbee-desktop                      # DBEE_WORKSPACE overrides the workspace directory
DBEE_COLD_START_EXIT=1 cargo run -p dbee-desktop   # print the cold-start times and exit (CI runs this under Xvfb)
cargo test -p dbee-desktop                     # the app on Tauri's mock runtime; config and capability pinned
```

`build.frontendDist` is `../ui/dist`, the built UI; without it `build.rs` embeds `ui-placeholder/`
and warns, so a Rust-only build still compiles. Secrets go to the OS keychain where one exists;
otherwise the core asks per session and persists nothing (the note is printed at start and shown
by `app.info`).

### dbee/ui

`@byterygon/dbee`: React 19 + Vite + Tailwind v4, one bundle for both shells. The Byterygon UI
items it uses are copied from `packages/ui/registry` into `src/components/ui` and `src/lib` by
`scripts/sync-ui.ts` (byte for byte, as the shadcn CLI installs them; `--check` fails when the
registry moved on). The app builds one client, `createClient(api, autoTransport())`, from the
generated `src/gen/api.ts`; `autoTransport` picks Tauri IPC in the desktop webview and the
WebSocket to the page's origin in a browser, and nothing else in the code branches on the shell
except the shortcut table (browser-owned keys use Alt+Shift on web) and the export destination.
Arrow chunks are decoded in a Worker (`src/app/arrow-worker.ts`). A run keeps the decoded stream
(`Run.stream`) and the results panel hands it to `DataGrid` (`@byterygon/data-grid`, spec §6),
which pulls the batches once under its 256 MiB memory budget (its pull rate is the credit
backpressure), reads the buffers directly and shows "Loaded n rows, scroll for more" when the
budget paused the stream. `runStatement` follows the same `ResultSource` for the row count and the
outcome. Resized column widths are kept per tab by column name in `tabs.json`. Copy (Ctrl+C, and
Ctrl+Shift+C opening the TSV/CSV/JSON menu) and the value viewer (Enter, F2) go through the grid's
handle. A benchmark harness (TSK-36) sets `globalThis.__DBEE_BENCH__ = {}` before the app loads to
receive the grid's handle and frame samples (`src/app/bench.ts`); without it nothing is exposed.
Screens: the shell (sidebar tree, query tabs, status bar, command palette, toasts), the connection
form (TanStack Form) and the approval dialog built from the core's preview, the schema browser,
query tabs on SqlEditor with the destructive-statement confirmation, results with the cell viewer,
export, settings, about and the shortcuts dialog. Tabs, sizes and settings live in the workspace
(`src/app/workspace.ts`): read once with `app.getWorkspace` before the first render, written with
`app.setWorkspace` after a short pause, and moved once from the webview storage an earlier build
used. Errors follow spec §8 with the correlation id behind a Details disclosure.

The shell follows Fluent 2's layering (TSK-64, mockup approved 2026-11-17): the window paints the
theme's backdrop, a title area holds the sidebar toggle, the query tabs (TabList), the command
search, Settings and Help, and the sidebar, the editor (with its command bar: Run or Cancel, the
connection, the row limit, Export) and the results are translucent layers with gaps, the resize
handles in the gaps. Comfortable is the default density; a settings document before version 2 that
says compact moves to comfortable once (`src/app/persistence.ts`).

```sh
pnpm --filter @byterygon/dbee build        # dist/ (the desktop's frontendDist, the server's --ui)
pnpm --filter @byterygon/dbee dev          # then /preview.html?scene=main|empty&scheme=dark&density=compact: the app on the tests' fake core (development only, never built)
pnpm --filter @byterygon/dbee test         # sync-ui --check, then vitest: units, screen flows, axe
pnpm --filter @byterygon/dbee sync:ui      # refresh the registry items after a packages/ui change
pnpm --filter @byterygon/dbee dev          # Vite dev server on 127.0.0.1 (development only)
```

## Ambidex procedures the skeleton builds

`app.info`, `app.events` (subscription), `app.getWorkspace`, `app.setWorkspace` (the UI's
settings and tabs); `connections.list`, `connections.prepare`,
`connections.create`, `connections.update`, `connections.setSecret`, `connections.delete`;
`sessions.open`, `sessions.close`; `schema.schemas`, `schema.tables`, `schema.columns`;
`query.classify`, `query.execute` (stream of Arrow IPC chunks, 5 min default and 1 h maximum);
`export.run` (stream of file bytes); `files.chooseSavePath` (desktop only). Every call is
authorized by one static Authorizer (the local human holds every permission, agents are denied)
and audited to a hash-chained JSON Lines log; SQL text is never stored before M3.

## Decisions and open questions

The spec's "Decisions" section lists the 28 product choices made for the first version (PostgreSQL
only, desktop first, personal connections only, grant approval as connection creation, keychain
or nothing, one statement per run, no default row limit, DOM virtualization with a measured gate,
the grid as its own package, compact density, Alt+Shift as the web substitute for browser-reserved
shortcuts, and so on). Its "Open questions" section carries the recommended defaults Uy Son can
overrule, chiefly how the web shell is used before OIDC exists and the Linux secret-store fallback.
