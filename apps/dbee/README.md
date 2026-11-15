# DBee

DBee is Byterygon's database client: a keyboard-first PostgreSQL client for engineers in
air-gapped and self-hosted environments, built on the Byterygon platform (Ambidex RPC, Plugin
Host, the db-driver contract, Byterygon UI). Licensed under AGPL-3.0-only (see `LICENSE`), unlike
the permissively licensed libraries in `crates/` and `packages/`. Permissive code never depends on
this directory.

The product is specified in the Notion Docs page **"DBee: UX and app spec for the first usable
version"** (TSK-37), summarised below; TSK-38 (app skeleton) and TSK-39 (data grid) implement it.
The spec is the source of truth; this file only orients a reader. `core/` and `rpc-gen/` exist
(TSK-38, first batch); the shells and the UI follow in the next batches.

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
apps/dbee/desktop   dbee-desktop   Tauri 2 app (ambidex-tauri, capability, CSP, native dialogs)               (next)
apps/dbee/server    dbee-server    axum binary (ambidex-axum, static UI, TLS, Host/Origin config)              (next)
apps/dbee/ui        @byterygon/dbee React + Vite; @byterygon/ambidex, Byterygon UI registry items, @byterygon/data-grid (next)
packages/data-grid  @byterygon/data-grid  the virtualized Arrow grid (MIT OR Apache-2.0, TSK-39)
```

### dbee-core

One crate, linked by both shells, so there is exactly one router, Authorizer, audit sink and
connection manager. A shell calls `Core::start(CoreConfig)` and serves `Core::router()` with
`Core::server_config()` through `ambidex-tauri` or `ambidex-axum`.

- **Workspace** (`workspace.rs`): `DBEE_WORKSPACE` or `dirs::data_dir()/dbee/workspace`;
  `connections.json` (grants as approved, driver settings, a secret *reference*, never a value),
  `settings.json`, `tabs.json`, written atomically. The audit log is `audit/log.jsonl`.
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

## Ambidex procedures the skeleton builds

`app.info`, `app.events` (subscription); `connections.list`, `connections.prepare`,
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
