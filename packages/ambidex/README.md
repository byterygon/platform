# @byterygon/ambidex

TypeScript runtime for Ambidex, the dual-transport RPC protocol (Notion: Ambidex spec §1–§7,
§10). It speaks the same binary frame protocol as the Rust engine (`crates/ambidex`) over the
Tauri IPC transport on desktop and a binary WebSocket on web. No runtime dependencies, no CDN:
the package is plain ES modules in `dist/`.

## Usage

`rpc-gen` (TSK-7) writes `api.ts` from the Rust procedure registry. Pass the generated module:

```ts
import * as api from "./api.js";
import { autoTransport, createClient, isRpcError } from "@byterygon/ambidex";

const client = createClient(api, autoTransport());

const controller = new AbortController();
try {
  const result = await client.query.execute(
    { connectionId, sql },
    { signal: controller.signal, timeoutMs: 5_000 },
  );
} catch (e) {
  if (isRpcError(e, api.procedures.query.execute)) {
    if (e.code === "ApprovalRequired") {
      // e.details: ApprovalRequiredDetails | QueryError | undefined, as generated
    }
    console.error(e.code, e.message, e.correlation_id);
  }
}

const events = client.jobs.progress({ jobId });
for await (const event of events) {
  if (event.done) break; // leaving the loop unsubscribes
}

client.$close();
```

`createClient(api.procedures, transport, { api: api.API, schemaHash: api.SCHEMA_HASH })` does the
same with a bare table. Procedure names are the wire names (spec Open question 22a), so
`items.list_items` is `client.items.list_items`.

| Kind         | Returns                                         | Notes                                                       |
| ------------ | ----------------------------------------------- | ----------------------------------------------------------- |
| query        | `Promise<Output>`                               | Rejects with `RpcError`                                     |
| mutation     | `Promise<Output>`                               | Never resent by the runtime                                 |
| subscription | `AsyncIterable<Event>` with `unsubscribe()`     | Server support pending (see below)                          |
| stream       | `{ chunks(): AsyncIterable<Uint8Array>, result }` | M1 shape only: no credits, no Arrow decoding (M2)         |

Control methods start with `$`, which no procedure name can: `$connect()` (open now, returns the
`HelloAck`), `$ping()` (round trip in ms) and `$close()`.

## Behaviour

- **Connection.** Opened on the first call, then `Hello {protocol, api, schema_hash,
  client_version, auth?}`; usable after `HelloAck`. A stale `api.ts` gets `VersionMismatch`. After
  the connection closes, the next call opens a new one. Calls in flight fail with `Unavailable`
  (`retryable` only for queries) and are never replayed.
- **Call ids** start at 1 and strictly increase per connection; an id is never reused, even after
  cancel or completion (spec Open question 15). When the u32 space runs out the connection takes
  no new calls, closes once idle, and the next call opens a fresh one.
- **Cancellation.** Aborting the `signal` sends one `Cancel` and rejects at once with a local
  `Cancelled` (spec Open question 21b); aborting before the call was sent sends nothing. A late
  answer for that id is dropped.
- **Deadlines.** `timeoutMs` (a non-negative integer) travels as `timeout_ms`; the server enforces
  `min(timeoutMs, timeoutMaxMs)` and answers `DeadlineExceeded`. The runtime only keeps a safety
  timer at that deadline plus `timeoutSlackMs` (default 5 s) for a server that never answers.
- **Errors** are `RpcError` instances with the wire fields `code`, `message`, `details`,
  `retryable`, `correlation_id`, plus `procedure` and `local` (true when the runtime produced it).
  `isRpcError(e, procedure)` narrows to that procedure's generated error union, and only matches
  errors of that procedure. Local messages are fixed strings: no input values, no transport
  details.
- **Limits.** Payloads are bounded by the server's `HelloAck.limits.max_frame_bytes` both ways; a
  too-large call fails locally with `ResourceExhausted` before anything is sent. Malformed or
  unexpected server frames close the connection with `Goaway {InvalidArgument}`.
- **Goaway** from the server (e.g. `Unauthenticated` "session revoked") fails every call and
  subscription with that code and message.

## Transports

A transport is a byte pipe (`Transport.open(sink) → Pipe`); every protocol rule above lives in
the shared runtime.

- **`WebSocketTransport`**: one binary WebSocket per connection at `wss://<page host>/rpc/ws` by
  default. Binary messages only (a text message closes it, as on the server). The browser sends
  the session cookie and `Origin`; pass `auth: () => ({ csrf })` for `Hello.auth`. Only `wss:` is
  accepted unless `allowInsecure` is set for a loopback dev server.
- **`TauriTransport`**: the webview side of `crates/ambidex-tauri`. `plugin:ambidex|connect` with a
  channel, raw-body `plugin:ambidex|send` invokes with the `ambidex-connection` header, and
  `plugin:ambidex|close`. Sends are serialized (one invoke in flight, queued bytes coalesced) to
  keep the byte stream in order; channel messages are reordered by Tauri's `index`, and the
  channel's end closes the pipe. No listener, no URI scheme, no credentials from the page.
- **`autoTransport()`** picks Tauri when `__TAURI_INTERNALS__` provides `invoke` and
  `transformCallback`, otherwise WebSocket. `force` overrides detection.

## Not in this package yet

- **Subscriptions on the server**: the engine answers `Subscribe` with `Unimplemented`, which the
  runtime surfaces through the iterator. The client side follows the Call shape for `Subscribe`
  (`{procedure, input, timeout_ms?}`), `Event` per event, `Unsubscribe` with an empty payload;
  how the server ends a subscription is spec Open question 23.
- **Streams (M2)**: credit-based flow control, Worker-side Arrow decoding, the chunk API.

## Development

```sh
pnpm --filter @byterygon/ambidex typecheck   # sources (no Node types) and tests
pnpm --filter @byterygon/ambidex build       # dist/
pnpm --filter @byterygon/ambidex test        # unit + integration tests
```

The integration tests build and start `conformance-server` (`crates/ambidex-conformance`), the
fixture API on the real engine and axum WebSocket transport over TLS on a loopback port. Without
`cargo` they skip unless `AMBIDEX_REQUIRE_RUST_SERVER=1` (set in CI); `AMBIDEX_CARGO_OFFLINE=1`
builds it with `--offline`. The Tauri pipe runs against the same server through a bridged IPC;
the real webview (raw `invoke`, Tauri's fetch path for large channel messages) is not covered
here and belongs to WebDriver tests against a built app.
