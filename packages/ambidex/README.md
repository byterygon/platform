# @byterygon/ambidex

TypeScript runtime for Ambidex, the dual-transport RPC protocol (Notion: Ambidex spec §1–§7,
§10). It speaks the same binary frame protocol as the Rust engine (`crates/ambidex`) over the
Tauri IPC transport on desktop and a binary WebSocket on web. No runtime dependencies, no CDN:
the package is plain ES modules in `dist/`. Only the optional Arrow decoder needs `apache-arrow`
(an optional peer dependency).

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
| subscription | `AsyncIterable<Event>` with `unsubscribe()`     | Ends with the server's `Result` or `Error` (see below)      |
| stream       | `{ chunks(): AsyncIterable<Uint8Array>, result, cancel() }` | Paced by credits; Arrow decoding in a Worker (see below) |

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
  it, capped by the procedure's `timeoutMaxMs`, and answers `DeadlineExceeded`. Without
  `timeoutMs`, a call (query, mutation, stream) gets its `timeoutDefaultMs` (30 s unless the
  procedure declares another; the cap defaults to 5 min). A **subscription has no default
  deadline** (spec Open question 24f; `timeoutDefaultMs` is `null`): it runs until the server ends
  it, `unsubscribe()`, the `signal`, session revocation or disconnect, unless `timeoutMs` is given
  or the procedure declares a maximum (`timeoutMaxMs`, otherwise `null`), which also bounds a
  subscription that sends no `timeoutMs`. The runtime only keeps a safety timer, for a server that
  never answers, at that deadline plus a slack: when the server's `HelloAck.limits.cancel_grace_ms`
  is present (how long it lets a cancelled call run before dropping it), the slack is that grace
  plus `networkMarginMs` (default 1 s); otherwise it is `timeoutSlackMs` (default 5 s), spec Open
  question 23b. A subscription without a deadline gets no safety timer. When the timer fires, the
  call fails locally with `DeadlineExceeded` (`local: true`) and the runtime sends `Cancel`
  (`Unsubscribe` for a subscription). Authorization is checked once, at `Subscribe`: a role change
  does not end a running subscription; revoking the session does.
- **Subscriptions** (spec Open question 23a). `Subscribe` carries the call payload
  `{procedure, input, timeout_ms?}`; each `Event` frame is one event, in order. The server ends a
  subscription with `Result` (the iteration ends normally; the payload is not an event) or `Error`
  (the iteration rejects with that `RpcError`). Leaving a `for await` loop, `unsubscribe()` or
  aborting the `signal` sends one `Unsubscribe`: the server never answers it and sends nothing
  more for that id, and frames already in flight are dropped here. Abort rejects with a local
  `Cancelled`. Events the consumer has not read yet are buffered up to `maxBufferedEvents`
  (default 1024), then the subscription ends with `ResourceExhausted`; the server bounds its own
  buffer the same way. Subscriptions count toward the server's `max_concurrent_calls`.
- **Streams** (spec §5, §6, Open question 27). A stream is started with `Call`; `chunks()` yields
  the binary `Chunk` payloads in order and `result` settles from `StreamEnd` (the typed summary)
  or `Error` (after the chunks sent before it). The server starts every stream with a window of 4
  credits and spends one per chunk. The runtime gives one back, `Credit {"chunks": 1}`, when the
  consumer comes back for the next chunk, so the window measures real consumption: a consumer
  that awaits between chunks slows the server's handler down, and at most the window is buffered
  here. Nothing is granted for chunks nobody read: a caller that never iterates `chunks()` stalls
  the stream at its window until the deadline. Leaving the loop early, `cancel()` or aborting the
  `signal` sends `Cancel`, and `result` rejects with a local `Cancelled`. Deadlines and the safety
  timer work as for calls (`timeoutDefaultMs` applies). Each chunk owns its `ArrayBuffer`.
- **Errors** are `RpcError` instances with the wire fields `code`, `message`, `details`,
  `retryable`, `correlation_id`, plus `procedure` and `local` (true when the runtime produced it).
  `isRpcError(e, procedure)` narrows to that procedure's generated error union, and only matches
  errors of that procedure. Local messages are fixed strings: no input values, no transport
  details.
- **Limits.** Payloads are bounded by the server's `HelloAck.limits.max_frame_bytes` both ways; a
  too-large call fails locally with `ResourceExhausted` before anything is sent. Malformed or
  unexpected server frames close the connection with `Goaway {InvalidArgument}`.
- **Goaway** from the server (e.g. `Unauthenticated` "session revoked") fails every call and
  subscription with that code and message. Revoking a session ends its subscriptions this way,
  with no per-subscription `Error`.

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

## Arrow streams

A stream procedure that sends Arrow IPC (the Rust `ArrowSink`) can be decoded off the UI thread
(spec §4, §6). `apache-arrow` (`^21`) must be installed by the application; it is imported only
by the Worker script, which ships in this package and is bundled with the application (no CDN,
no runtime fetch).

```ts
import { decodeArrow } from "@byterygon/ambidex/arrow";

const worker = new Worker(new URL("@byterygon/ambidex/arrow-worker", import.meta.url), {
  type: "module",
});
const rows = decodeArrow(client.query.execute({ sql }), worker);
const fields = await rows.schema; // name, type, nullable; also for a result without rows
for await (const batch of rows.batches()) grid.append(batch);
const summary = await rows.result;
```

- A batch is `{ numRows, columns }`; each column is an `ArrowData`: the Arrow buffers of the
  array (`validity`, `offsets`, `values`, `children`, `dictionary`) as typed arrays, all views of
  one `ArrayBuffer` per batch. The UI thread parses nothing and does not load apache-arrow.
  `arrowIsValid(column, row)` reads the validity bitmap; `arrowTransferables(batch)` lists the
  buffers to transfer a batch on.
- Chunks are transferred to the Worker and batches transferred back. On Tauri the frames arrive
  on the main thread and are transferred from there. On the web the whole client may live in the
  application's own Worker: `inThreadArrowDecoder()` from `@byterygon/ambidex/arrow-decoder`
  decodes there without a second Worker. One Worker serves any number of streams.
- **Credits**: the next chunk is taken, which grants its credit, only after the Worker decoded
  the previous one and the consumer came back for more batches.
- The schema resolves before `batches()` is read. Chunks that are not an Arrow IPC stream, or a
  Worker that fails (script not loaded), fail the call with a local `Internal` and cancel it.
  Leaving `batches()` early or `cancel()` cancels the stream.

## Not in this package yet

- **Backpressure for subscriptions (M2)**: no credits; a consumer that falls behind ends the
  subscription with `ResourceExhausted` (client or server side) instead of slowing the producer.

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
