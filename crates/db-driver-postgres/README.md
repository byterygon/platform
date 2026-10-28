# db-driver-postgres

First-party native PostgreSQL driver behind the `db-driver` v0.1 contract (TSK-15). It is
compiled into the core (ADR "Plugin trust and driver execution model") and, like every driver,
reaches the database only through the host broker.

## Client choice (spike)

| Option | Brokered I/O and in-protocol TLS | Backpressure | `max_rows`, transactions | Verdict |
| --- | --- | --- | --- | --- |
| `postgres-protocol` (sans-IO) + own state machine | Native: messages go over `Transport::send/recv`; `SSLRequest` then the broker's `start_tls` on the same transport | Rows are read only when the stream is polled | Exact: `Execute` row limit, explicit `BEGIN … READ ONLY`/`ROLLBACK` | **Chosen** |
| `tokio-postgres` | Needs an `AsyncRead/AsyncWrite` shim over the broker and a fake `TlsConnect` that calls `start_tls`; `CancelToken::cancel_query_raw` exists | A spawned connection task reads ahead into channels | Portals only inside its `Transaction`; dropping a `RowStream` does not stop the server | Rejected |
| `sqlx` | Owns sockets and TLS; no raw-stream entry point | Internal | Pool-oriented | Rejected |

`postgres-protocol` is the message/SCRAM layer of `tokio-postgres` (MIT OR Apache-2.0, no I/O,
no runtime). The same code can later serve the WASM driver (M2), whose broker is also
send/recv/start-tls. Cost: the driver owns the protocol state machine (startup, auth, extended
query, cancel), which is about 1,000 lines and covered by the tests below.

## Behaviour

- **Connect:** `open(target, "data")`; with `PgTls::InProtocolUpgrade`, `SSLRequest`, exactly
  one byte of answer (no buffered bytes taken over, CVE-2021-23222), then `start_tls`; `N` is
  `TlsFailed`, never a plaintext fallback. Authentication: trust, cleartext, MD5, SCRAM-SHA-256
  (server signature required before `AuthenticationOk`). Channel binding is not available
  because the broker terminates TLS. GSS/SSPI are `Unsupported`.
- **Execute:** one statement per call (extended protocol rejects several; `$n` parameters are
  `42P02`). Round trip 1 `Parse`/`Describe` picks per-column formats; round trip 2
  `Bind`/`Execute`/`Sync` streams rows. Chunks: the schema message first (also for statements
  without rows, as an empty schema), then one record batch per chunk (rows ≥ `batch_size_hint`,
  default 4096, or ≥ 8 MiB of values), the last chunk ending with the end-of-stream marker.
  Concatenated, the chunks are one Arrow IPC stream.
- **Types:** binary and exact for bool, int2/4/8, oid, float4/8, text/varchar/bpchar/name,
  bytea (`Binary`), uuid (`FixedSizeBinary(16)`, `arrow.uuid`), date (`Date32`), time
  (`Time64(µs)`), timestamp (`Timestamp(µs)`), timestamptz (`Timestamp(µs, "UTC")`). Every other
  type (numeric, json(b), interval, arrays, enums, …) is text → `Utf8`, so nothing is rounded.
  Fields carry `byterygon.pg.type_oid`. Date/timestamp `±infinity` saturate to the Arrow type's
  min/max.
- **`max_rows`:** `Execute` limit `max_rows + 1`; the extra row sets `truncated` and is
  discarded, and the server stops there.
- **Errors:** SQLSTATE, primary message and the server's one-based character position (= the
  contract's Unicode scalar offset). Detail/hint/context are dropped (they can quote row data).
  `57014` → `Cancelled`, class `08`/`57P0x` → `ConnectionLost`, class `28` →
  `AuthenticationFailed` (without the server message), class `42` except `42501` →
  `InvalidQuery`, the rest → `DatabaseError`.
- **Cancel:** a new `open(target, "cancel")` under the same grant, the same TLS upgrade, then
  `CancelRequest`; returns after the server closed it. `Requested` only once that succeeded;
  broker refusals are errors. A cancel is sent only while its operation is on the wire, and a
  new statement waits until earlier cancels were delivered, so a late cancel cannot stop the next
  statement. Cancellation is checked before each protocol phase and retried once per second
  until the operation ends (for at most 30 s, and not after a broker refusal), including when the first request arrived while the backend was idle.
  Deadlines trigger cancellation independently of result-stream polling; results still use
  pull-based backpressure. Polling or dropping an expired stream drains the session (re-sending
  every second, giving the session up after 30 s), as does dropping an unfinished stream.
- **One operation at a time** per connection: a second `execute` or introspection call while a
  stream is live is `Unsupported("connection is busy …")`. Operation IDs are never reused.
- **`AccessMode::ReadOnly`** (agent Read calls): session starts with
  `default_transaction_read_only = on`, and each statement and introspection query runs in
  `BEGIN TRANSACTION READ ONLY` and is rolled back. Session `SET`s and `COMMIT` tricks therefore
  do not carry over. This is defence in depth: database role privileges remain the real limit
  (for example `dblink` or `pg_terminate_backend` are not writes to this database).
- **Introspection:** `pg_catalog` with bound parameters. `schema = None` follows `search_path`
  (`pg_table_is_visible`), minus `pg_catalog`/`information_schema` in table listings. A missing
  table is `42P01`; a table without columns is an empty list.
- **Secrets:** the password lives in `Password` (zeroed on drop, `Debug` redacted); MD5 hashes
  and password/SASL message buffers are zeroed after sending. The SCRAM state inside
  `postgres-protocol` keeps a normalized copy that cannot be zeroed. Nothing is logged.

## Tests

`tests/postgres.rs` runs against a real server started by `tests/support` (TLS with a test CA,
SCRAM/MD5/cleartext/trust and TLS-only logins) through the real `NativeBroker` and grants. It
needs `initdb`/`postgres` (found via `BYTERYGON_PG_BIN`, `PATH` or `/usr/lib/postgresql/*/bin`)
and a non-root user; otherwise it is skipped, unless `BYTERYGON_REQUIRE_POSTGRES` is set (CI).
`tests/no_ambient_network.rs` fails if the driver gains socket, TLS, DNS, file or process access.
