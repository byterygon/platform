# Benchmark: PostgreSQL to a TypeScript client through Ambidex (TSK-36)

Streams 1,000,000 rows x 10 mixed columns from PostgreSQL through the native driver
(`db-driver-postgres`, all I/O through the Plugin Host broker), `ArrowSink` and the Ambidex
WebSocket transport (axum, rustls) to a Node client that decodes the Arrow IPC chunks with
`decodeArrow` in a worker thread. No grid, no UI.

```sh
pnpm bench                      # from the repository root; JSON report on stdout
pnpm bench --runs 3 --out run.json
```

It needs Rust (the pinned toolchain), Node 24 and a local PostgreSQL install (`initdb` and
`postgres`; set `BYTERYGON_PG_BIN` to their directory if they are not on `PATH`). The server starts a
throwaway cluster on 127.0.0.1 in the temp directory and deletes it on exit. `initdb` refuses to run
as root: as root, start your own server and pass `--pg-port` (below). Everything stays on loopback;
nothing is fetched at run time. The same command runs on Linux, macOS and Windows.

## What it does

`bench/run.ts` builds `bench-server` in release mode (`crates/ambidex-bench`), starts it, and
calls `bench.rows` once untimed on a small result (the worker loads `apache-arrow` on its first
message), then `--runs` times for real. `bench-server` creates the table `bench_rows` with
`generate_series`, so each value follows from its row number `n` and the run is reproducible:

| column | type | values |
| --- | --- | --- |
| `id` | int8 | `n` |
| `qty` | int4, nullable | `n % 100000`, null for 10% of rows |
| `level` | int2 | `n % 32000` |
| `score` | float8 | `n * 0.37` |
| `ratio` | float4 | `(n % 1000) / 8` |
| `name` | text | `user-<n % 5000>` |
| `note` | text, nullable | two concatenated md5 hashes (64 characters), null for 20% of rows |
| `created` | timestamptz | `2020-01-01 + n * 37 s` |
| `day` | date | `2000-01-01 + n % 10000 days` |
| `flag` | bool, nullable | `n % 3 = 0`, null for 5% of rows |

The client checks that it received exactly the requested rows with ids `0 .. rows-1`.

## Report

JSON with the platform, the configuration and one entry per run:

- `client.time_to_first_rows_ms`: from sending the call until the first record batch is decoded
  and readable (`time_to_schema_ms` is until the schema); `total_ms`: until the last batch was
  read and the final result arrived; `rows_per_second`, `mib_per_second` (Arrow IPC bytes).
- `client.peak_rss_mib`: the Node process, main thread and decoder worker together
  (`process.resourceUsage().maxRSS`, the process's lifetime peak, so it includes start-up, the
  warm-up and earlier runs); `rss_before_mib` is the resident set just before the call.
- `server.*`: what `bench-server` saw: `connect_ms` (driver connection through the broker),
  `time_to_first_chunk_ms`, `query_ms` (the driver's own time), `total_ms`, `chunks`, `ipc_mib`,
  and `peak_rss_mib` of the `bench-server` process (not of PostgreSQL), also a lifetime peak.
  `rss_method` says how it was read: `VmHWM` on Linux (the kernel's high-water mark),
  `PeakWorkingSet64` on Windows, and on macOS, which has none, `sampled ps` (every 20 ms, so a
  lower bound).

## Options

`--rows N` (default 1000000), `--runs N`, `--batch-rows N` (record batch size; the driver's default
is 4096 rows), `--out FILE`, `--quiet`, `--no-warmup`, `--no-build`, `--server PATH` (a prebuilt
`bench-server`), and for `bench-server`: `--pg-port P [--pg-user U] [--pg-database D]` (use the
server already running on 127.0.0.1:P; password in `BENCH_PG_PASSWORD`; the user must be allowed to
create a table and `ALTER DATABASE`), `--frame-bytes N`, `--initial-credits N`, `--max-credits N`
(engine limits, spec §6). `AMBIDEX_CARGO_OFFLINE=1` adds `--offline` to the cargo build.

## Decisions (TSK-36)

- The server is a new crate, `crates/ambidex-bench`, not part of `ambidex-conformance`: the
  conformance suite must stay free of PostgreSQL and Plugin Host dependencies. Its API
  (`bench.rows`) is code-generated like the fixture API; `packages/ambidex/bench/generated` is
  committed and `crates/ambidex-bench/tests/codegen.rs` fails when it is stale
  (`cargo run -p ambidex-bench --bin bench-gen` regenerates it).
- The server memory is read from outside the process by the Node driver, so the Rust side needs no
  platform-specific code (the workspace forbids `unsafe`) and no extra dependency.
- The benchmark is run by hand. CI only checks the generated files and, where `initdb` and a
  non-root user exist, runs a 20,000-row smoke test (`test/bench.test.ts`).
- Scans must start at the first page, so the load sets `synchronize_seqscans = off` on the
  benchmark database. The benchmark router keeps no audit trail (entries are dropped) and allows
  only `bench.read`; the sessions are placeholder web sessions. None of this is a product
  configuration.
