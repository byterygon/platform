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
| `release/` | the release (TSK-87): `release.mts`, the shipped `README.md`, the tools' release notes, the image's `Dockerfile` |

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

## Release

Each tool ships when it is done (Uy Son, 2026-11-17). A finished tool adds
`release/notes/<N>-<tool>.md` (the next N, from its task's "Release after this tool" notes); the
version follows: `0.1.0-alpha.N`, and `0.1.0` once all six are in. Then run the workflow
(Actions > Mightyconsole release > Run workflow): it builds one file per platform with the UI
built in (Linux x64 and arm64 static, macOS Apple silicon and Intel, Windows x64), a container
image per Linux architecture, the licence, the third-party notices, the README, the release notes
and `SHA256SUMS`, and checks the binaries and images with no network. Its artifacts are the
release. It never tags or publishes; a tag `mightyconsole-v<version>` pushed by a person makes a
draft release for that person to publish.

The same steps by hand:

```sh
node apps/mightyconsole/release/release.mts check            # the notes are valid; prints the version
pnpm --filter @byterygon/mightyconsole build
MIGHTYCONSOLE_VERSION=$(node apps/mightyconsole/release/release.mts version) \
  cargo build -p mightyconsole-server --release --features embed-ui
node apps/mightyconsole/release/release.mts smoke --binary target/release/mightyconsole-server
node scripts/third-party-notices.mjs --app mightyconsole --out target/THIRD-PARTY-NOTICES.txt
node apps/mightyconsole/release/release.mts package --name linux-x64 \
  --binary target/release/mightyconsole-server --notices target/THIRD-PARTY-NOTICES.txt
```

`release.mts image --arch amd64 --binary <static musl binary> --notices …` builds and saves the
image; `release/image-check.sh` checks a saved one.
