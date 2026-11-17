# Mightyconsole

Byterygon's developer console: one offline web app for NATS, Kafka with Schema Registry,
Kubernetes, Temporal, Docker over SSH and LangGraph. The spec is the Notion page "Mightyconsole
web v0.1 spec" (DOC-21); the plan is DOC-20. Licence: AGPL-3.0-only (`LICENSE`).

v0.1 is for one person on their own machine: **there is no login**. Never expose the server on a
shared network; anyone who reaches its port can use every connection opened through it.

| Path | What |
| --- | --- |
| `server/` | `mightyconsole-server`: axum + `ambidex-axum` at `/rpc/ws` over TLS, the local browser session, the tool contract, the tools (`src/tools/<tool>/`), the static UI |
| `rpc-gen/` | `mightyconsole-rpc-gen`: writes `ui/src/gen/api.ts` and `api.manifest.json` (drift-checked by `cargo test -p mightyconsole-server`) |
| `ui/` | `@byterygon/mightyconsole`: the React UI (TSK-79 batch 2) |
| `lab/` | the docker compose test lab (TSK-79 batch 3) |

## Run

```sh
cargo run -p mightyconsole-server            # https://localhost:7443/
cargo run -p mightyconsole-server -- --help
```

With no flags the server listens on `127.0.0.1:7443` and, on first start, makes a self-signed
certificate for `localhost`, `127.0.0.1` and `::1` in `$MIGHTYCONSOLE_DATA/tls` (default: the OS
data directory, `mightyconsole/tls`). It prints the certificate's SHA-256 fingerprint: trust the
certificate in the browser once, after comparing the fingerprint, or give your own with
`--tls-cert` and `--tls-key` (for example from `mkcert localhost 127.0.0.1 ::1`).

The server keeps no connection settings. Profiles live in the browser (IndexedDB) and are sent
to the server when you connect; the server holds the live connection for that browser tab and
releases it when the tab closes, when you disconnect, or after 10 minutes without use.

## Develop

```sh
cargo test -p mightyconsole-server              # unit, drift and end-to-end tests
cargo run -p mightyconsole-rpc-gen              # regenerate ui/src/gen after changing procedures
```

A tool is one module in `server/src/tools/<tool>/` with one `#[rpc::router(namespace = "<tool>")]`
API; `server/src/tools/echo` is the sample every tool copies (connect and disconnect, a query, a
live stream with a `streamId` and progress, a terminal). See the module docs of
`server/src/tools/mod.rs` and `server/src/core/mod.rs`.
