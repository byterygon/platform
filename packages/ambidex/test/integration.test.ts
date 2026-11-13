// The runtime against the real Rust stack (spec §12): `conformance-server` runs the fixture API
// through the production engine, router, authorizer and axum WebSocket transport over rustls,
// on a loopback port. Nothing is mocked on the server side.
//
// - WebSocket: Node's WebSocket (the same WHATWG API a browser has) through `WebSocketTransport`,
//   with the session cookie and Origin a browser would send; Host is the real `localhost:<port>`.
// - Tauri: `TauriTransport` with an IPC whose three plugin commands are bridged to that server
//   (each connect opens a WebSocket, channel messages are delivered as `{message, index}` with
//   indices shuffled), so the Tauri pipe's ordering, raw bodies and end handling run against the
//   real engine. The webview itself and the Rust plugin are not in this loop: the plugin is
//   covered by the Rust conformance suite on Tauri's mock runtime (crates/ambidex-conformance).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  type Frame,
  FrameDecoder,
  Kind,
  type Pipe,
  type PipeSink,
  RpcError,
  TAURI_COMMANDS,
  type TauriIpc,
  TauriTransport,
  type Transport,
  WebSocketTransport,
  createClient,
  encodeFrame,
  isRpcError,
} from "../src/index.js";
import { decodeArrow } from "../src/arrow.js";
import * as api from "./conformance/api.js";
import { fixtureRow, rowsOf, startArrowWorker } from "./support/arrow.js";
import { settle, tick } from "./support/mock-server.js";
import { RustServer, serverUnavailable } from "./support/rust-server.js";

const skip = serverUnavailable();

let server: RustServer;

before(async () => {
  if (skip === undefined) server = await RustServer.start();
});

// The Arrow decoder in a worker thread, as a page runs it in a Web Worker.
const arrowWorker = startArrowWorker();

after(async () => {
  await arrowWorker.stop();
  await server?.stop();
});

/** Wraps a transport and counts the stream frames passing through: chunks in, credits out. */
class Counting implements Transport {
  readonly name = "counting";
  chunks = 0;
  readonly credits: unknown[] = [];
  #inner: Transport;

  constructor(inner: Transport) {
    this.#inner = inner;
  }

  async open(sink: PipeSink): Promise<Pipe> {
    const inbound = new FrameDecoder(Number.MAX_SAFE_INTEGER);
    const outbound = new FrameDecoder(Number.MAX_SAFE_INTEGER);
    const pipe = await this.#inner.open({
      data: (bytes) => {
        inbound.push(bytes);
        for (let f = inbound.next(); f !== undefined; f = inbound.next()) {
          if (f.kind === Kind.Chunk) this.chunks += 1;
        }
        sink.data(bytes);
      },
      closed: (error) => sink.closed(error),
    });
    return {
      ...(pipe.auth !== undefined ? { auth: pipe.auth } : {}),
      send: (bytes) => {
        outbound.push(bytes);
        for (let f = outbound.next(); f !== undefined; f = outbound.next()) {
          if (f.kind === Kind.Credit) {
            this.credits.push(JSON.parse(new TextDecoder().decode(f.payload)));
          }
        }
        pipe.send(bytes);
      },
      close: () => pipe.close(),
    };
  }
}

/** Waits until `condition` holds. */
async function until(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await tick(5);
  }
}

/** The credit window every stream starts with (spec §6). */
const INITIAL_CREDITS = 4;

async function webSocket(origin?: string): Promise<Transport> {
  const session = await server.session();
  return new WebSocketTransport({
    url: server.info.url,
    auth: () => ({ csrf: session.csrf }),
    createSocket: server.socketFactory(session, origin),
  });
}

/**
 * Tauri's IPC, with the plugin's commands bridged to the server over WebSocket.
 *
 * The real plugin authenticates a connection by its webview (the desktop session); the web
 * server authenticates Hello by the anti-CSRF token. The bridge stands in for the plugin there:
 * it adds the web session's token to the Hello it forwards. Every other byte passes unchanged.
 */
async function bridgedTauri(): Promise<TauriIpc> {
  const session = await server.session();
  const socket = server.socketFactory(session);
  const callbacks = new Map<number, (m: unknown) => void>();
  const connections = new Map<string, ReturnType<typeof socket>>();
  let nextCallback = 1;
  let nextConnection = 1;
  return {
    transformCallback(cb) {
      const id = nextCallback++;
      callbacks.set(id, cb);
      return id;
    },
    unregisterCallback(id) {
      callbacks.delete(id);
    },
    async invoke(cmd, args, options) {
      if (cmd === TAURI_COMMANDS.connect) {
        const channel = Number(String((args as { onFrame: string }).onFrame).split(":")[1]);
        const ws = socket(server.info.url);
        ws.binaryType = "arraybuffer";
        await new Promise((resolve, reject) => {
          ws.addEventListener("open", resolve);
          ws.addEventListener("error", reject);
        });
        let index = 0;
        let held: { message: unknown; index: number } | undefined;
        ws.addEventListener("message", (e: { data: ArrayBuffer }) => {
          const msg = { message: e.data, index: index++ };
          // Deliver pairs swapped, like Tauri's fetch path can for large messages.
          if (held === undefined) held = msg;
          else {
            callbacks.get(channel)?.(msg);
            callbacks.get(channel)?.(held);
            held = undefined;
          }
          if (held !== undefined) {
            const h = held;
            setTimeout(() => {
              if (held === h) {
                held = undefined;
                callbacks.get(channel)?.(h);
              }
            }, 5);
          }
        });
        ws.addEventListener("close", () => {
          setTimeout(() => callbacks.get(channel)?.({ end: true, index }), 10);
        });
        const id = `conn-${session.csrf}-${nextConnection++}`;
        connections.set(id, ws);
        return id;
      }
      if (cmd === TAURI_COMMANDS.send) {
        assert.ok(args instanceof Uint8Array, "send carries a raw body");
        const id = options?.headers?.["ambidex-connection"] ?? "";
        const ws = connections.get(id);
        if (ws === undefined) throw "unknown connection";
        ws.send(withHelloAuth(id, args, session.csrf));
        return null;
      }
      if (cmd === TAURI_COMMANDS.close) {
        connections.get((args as { connection: string }).connection)?.close();
        return null;
      }
      throw new Error(`unexpected command ${cmd}`);
    },
  };
}

const helloSeen = new Set<string>();

/** Adds `auth` to the connection's first frame (Hello); later bytes pass unchanged. */
function withHelloAuth(connection: string, bytes: Uint8Array, csrf: string): Uint8Array {
  if (helloSeen.has(connection)) return bytes;
  helloSeen.add(connection);
  const decoder = new FrameDecoder();
  decoder.push(bytes);
  const hello = decoder.next();
  assert.ok(hello !== undefined && hello.kind === Kind.Hello && decoder.buffered === 0);
  assert.equal(
    JSON.parse(new TextDecoder().decode(hello.payload)).auth,
    undefined,
    "no auth from the webview",
  );
  const payload = { ...JSON.parse(new TextDecoder().decode(hello.payload)), auth: { csrf } };
  return encodeFrame({ ...hello, payload: new TextEncoder().encode(JSON.stringify(payload)) });
}

for (const [name, makeTransport] of [
  ["WebSocket", () => webSocket()],
  ["Tauri (bridged)", async () => new TauriTransport({ ipc: await bridgedTauri() })],
] as const) {
  describe(`against the Rust engine over ${name}`, { skip }, () => {
    it("handshakes and calls with typed results", async () => {
      const client = createClient(api, await makeTransport());
      const ack = await client.$connect();
      assert.equal(ack.server_version, "0.0.0-conformance");
      assert.equal(ack.limits.max_frame_bytes, 4096);
      assert.deepEqual(await client.fixture.echo({ any: ["json", 1, null] }), {
        any: ["json", 1, null],
      });
      assert.equal(await client.fixture.big(10), "xxxxxxxxxx");
      const who = (await client.fixture.whoami(null)) as { principal: string };
      assert.equal(who.principal.startsWith("human:"), true);
      assert.ok((await client.$ping()) >= 0);
      client.$close();
    });

    it("answers concurrent calls by call id", async () => {
      const client = createClient(api, await makeTransport());
      const values = await Promise.all([1, 2, 3, 4].map((n) => client.fixture.echo(n)));
      assert.deepEqual(values, [1, 2, 3, 4]);
      client.$close();
    });

    it("maps typed domain errors, PermissionDenied, ApprovalRequired and scrubbed Internal", async () => {
      const client = createClient(api, await makeTransport());
      const fail = await settle(client.fixture.fail({ code: "NotFound", retryable: true }));
      assert.equal(fail.ok, false);
      assert.ok(isRpcError(fail.error, api.procedures.fixture.fail));
      assert.equal(fail.error.code, "NotFound");
      assert.equal(fail.error.retryable, true);
      assert.deepEqual(fail.error.details, {
        kind: "Requested",
        code: "NotFound",
        retryable: true,
      });
      assert.notEqual(fail.error.correlation_id, "");

      const denied = await settle(client.fixture.protected({ code: "NotFound" }));
      assert.equal(denied.ok, false);
      assert.equal(denied.error.code, "PermissionDenied");
      assert.equal(denied.error.details, undefined);

      for (const call of [
        () => client.fixture.approval(null),
        () => client.fixture.escalate(null),
      ]) {
        const r = await settle(call());
        assert.equal(r.ok, false);
        assert.equal(r.error.code, "ApprovalRequired");
        assert.deepEqual(r.error.details, { approval_id: "approval-1" });
      }

      const leak = await settle(client.fixture.leak(null));
      assert.equal(leak.ok, false);
      assert.equal(leak.error.code, "Internal");
      assert.equal(leak.error.message, "internal error");
      assert.equal(leak.error.details, undefined);
      client.$close();
    });

    it("gets ResourceExhausted for a result over the frame limit and keeps the connection", async () => {
      const client = createClient(api, await makeTransport());
      const r = await settle(client.fixture.big(5000));
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "ResourceExhausted");
      assert.equal(await client.fixture.echo("still open"), "still open");
      client.$close();
    });

    it("abort sends Cancel: the handler sees it, the call rejects at once", async () => {
      const client = createClient(api, await makeTransport());
      await client.$connect();
      await server.events();
      const controller = new AbortController();
      const waiting = settle(client.fixture.wait(null, { signal: controller.signal }));
      await server.waitForEvent("Started:wait");
      controller.abort();
      const r = await waiting;
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "Cancelled");
      await server.waitForEvent("Cancelled:wait");
      // The connection keeps working; the late Cancelled reply for that id reaches nobody.
      assert.equal(await client.fixture.echo(1), 1);
      client.$close();
    });

    it("timeoutMs reaches the server, which answers DeadlineExceeded (capped by timeoutMaxMs)", async () => {
      const client = createClient(api, await makeTransport());
      const waited = await settle(client.fixture.wait(null, { timeoutMs: 100 }));
      assert.equal(waited.ok, false);
      assert.equal(waited.error.code, "DeadlineExceeded");
      assert.equal(waited.error.local, false, "the server's deadline, not the client's");
      const capped = await settle(client.fixture.capped(null, { timeoutMs: 60_000 }));
      assert.equal(capped.ok, false);
      assert.equal(capped.error.code, "DeadlineExceeded");
      assert.equal(capped.error.local, false);
      client.$close();
    });

    it("closing the client cancels calls on the server", async () => {
      const client = createClient(api, await makeTransport());
      await client.$connect();
      await server.events();
      const waiting = settle(client.fixture.wait(null));
      await server.waitForEvent("Started:wait");
      client.$close();
      const r = await waiting;
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "Cancelled");
      await server.waitForEvent("Cancelled:wait");
    });

    it("subscriptions yield the server's events in order and end with its Result", async () => {
      const client = createClient(api, await makeTransport());
      const seen: number[] = [];
      for await (const n of client.fixture.counter({ count: 5 })) seen.push(n);
      assert.deepEqual(seen, [0, 1, 2, 3, 4]);
      // The connection keeps working, and the ended subscription left nothing registered.
      assert.equal(await client.fixture.echo("alive"), "alive");
      client.$close();
    });

    it("a server-side Error ends the iteration after the events, with typed details", async () => {
      const client = createClient(api, await makeTransport());
      const seen: number[] = [];
      const ended = await settle(
        (async () => {
          for await (const n of client.fixture.counter({ count: 2, then: "fail" })) seen.push(n);
        })(),
      );
      assert.deepEqual(seen, [0, 1]);
      assert.equal(ended.ok, false);
      assert.ok(isRpcError(ended.error, api.procedures.fixture.counter));
      assert.equal(ended.error.code, "FailedPrecondition");
      assert.equal(ended.error.local, false);
      assert.deepEqual(ended.error.details, {
        kind: "Requested",
        code: "FailedPrecondition",
        retryable: false,
      });
      client.$close();
    });

    it("unsubscribe() cancels the handler; the connection keeps working", async () => {
      const client = createClient(api, await makeTransport());
      await client.$connect();
      await server.events();
      const sub = client.fixture.counter({ count: 3, then: "wait" });
      for await (const n of sub) {
        assert.equal(n, 0);
        break; // leaving the loop unsubscribes
      }
      await server.waitForEvent("Cancelled:counter");
      assert.equal(await client.fixture.echo(1), 1);
      client.$close();
    });

    it("abort ends the subscription with Cancelled and reaches the handler", async () => {
      const client = createClient(api, await makeTransport());
      await client.$connect();
      await server.events();
      const controller = new AbortController();
      const sub = client.fixture.counter({ count: 1, then: "wait" }, { signal: controller.signal });
      const it = sub[Symbol.asyncIterator]();
      assert.deepEqual(await it.next(), { value: 0, done: false });
      controller.abort();
      const r = await settle(it.next());
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "Cancelled");
      assert.equal(r.error.local, true);
      await server.waitForEvent("Cancelled:counter");
      assert.equal(await client.fixture.echo(2), 2);
      client.$close();
    });

    it("timeoutMs ends a subscription with the server's DeadlineExceeded", async () => {
      const client = createClient(api, await makeTransport());
      const sub = client.fixture.counter({ count: 0, then: "wait" }, { timeoutMs: 100 });
      const r = await settle(sub[Symbol.asyncIterator]().next());
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "DeadlineExceeded");
      assert.equal(r.error.local, false, "the server's deadline, not the client's");
      client.$close();
    });

    it("an unauthorized subscription is refused with PermissionDenied", async () => {
      const client = createClient(api, await makeTransport());
      const r = await settle(client.fixture.secret(null)[Symbol.asyncIterator]().next());
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "PermissionDenied");
      assert.equal(r.error.message, "permission denied");
      assert.equal(await client.fixture.echo("alive"), "alive");
      client.$close();
    });

    it("streams chunks in order, then the typed summary", async () => {
      const client = createClient(api, await makeTransport());
      const stream = client.fixture.bytes({ chunks: 10, size: 8 });
      const seen: number[][] = [];
      for await (const chunk of stream.chunks()) seen.push([...chunk]);
      assert.deepEqual(
        seen,
        Array.from({ length: 10 }, (_, n) => new Array(8).fill(n)),
      );
      assert.deepEqual(await stream.result, { chunks: 10, bytes: 80 });
      // A stream without chunks still ends with its summary.
      const empty = client.fixture.bytes({ chunks: 0, size: 0 });
      for await (const chunk of empty.chunks()) assert.fail(`unexpected chunk ${chunk.length}`);
      assert.deepEqual(await empty.result, { chunks: 0, bytes: 0 });
      assert.equal(await client.fixture.echo("alive"), "alive");
      client.$close();
    });

    it("a slow consumer holds the server at its credit window", async () => {
      const counting = new Counting(await makeTransport());
      const client = createClient(api, counting);
      const stream = client.fixture.bytes({ chunks: 12, size: 16 });
      const it = stream.chunks()[Symbol.asyncIterator]();
      assert.deepEqual([...((await it.next()).value as Uint8Array)], new Array(16).fill(0));
      // The consumer holds the first chunk: the server sends its window and waits.
      await until(() => counting.chunks === INITIAL_CREDITS);
      await tick(150);
      assert.equal(counting.chunks, INITIAL_CREDITS);
      assert.deepEqual(counting.credits, []);
      // Back for the second chunk: one credit, one more chunk from the server.
      assert.deepEqual([...((await it.next()).value as Uint8Array)], new Array(16).fill(1));
      await until(() => counting.chunks === INITIAL_CREDITS + 1);
      await tick(150);
      assert.equal(counting.chunks, INITIAL_CREDITS + 1);
      assert.deepEqual(counting.credits, [{ chunks: 1 }]);
      // The rest, in order, never more than the window ahead of the consumer.
      let next = 2;
      for (let r = await it.next(); r.done !== true; r = await it.next()) {
        assert.deepEqual([...r.value], new Array(16).fill(next));
        next += 1;
        assert.ok(counting.chunks <= next + INITIAL_CREDITS);
      }
      assert.equal(next, 12);
      assert.equal(counting.chunks, 12);
      assert.deepEqual(await stream.result, { chunks: 12, bytes: 192 });
      // One per chunk the consumer came back from; the one for the last chunk may race with the
      // stream's end, and the server ignores it then.
      assert.ok(counting.credits.length >= 12 - INITIAL_CREDITS && counting.credits.length <= 12);
      assert.ok(counting.credits.every((c) => (c as { chunks: number }).chunks === 1));
      client.$close();
    });

    it("leaving chunks() early cancels the stream on the server", async () => {
      const counting = new Counting(await makeTransport());
      const client = createClient(api, counting);
      await client.$connect();
      await server.events();
      const stream = client.fixture.bytes({ chunks: 100, size: 8 });
      for await (const chunk of stream.chunks()) {
        assert.deepEqual([...chunk], new Array(8).fill(0));
        break; // leaving the loop cancels
      }
      const r = await settle(stream.result);
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "Cancelled");
      assert.equal(r.error.local, true);
      // The handler was waiting for a credit; Cancel reached it there.
      await server.waitForEvent("Cancelled:bytes");
      assert.ok(counting.chunks <= INITIAL_CREDITS + 1);
      assert.equal(await client.fixture.echo(1), 1);
      client.$close();
    });

    it("cancel() and abort end a stream with Cancelled and reach the handler", async () => {
      const client = createClient(api, await makeTransport());
      await client.$connect();
      await server.events();
      const cancelled = client.fixture.bytes({ chunks: 100, size: 8 });
      const it = cancelled.chunks()[Symbol.asyncIterator]();
      await it.next();
      cancelled.cancel();
      const viaCancel = await settle(it.next());
      assert.equal(viaCancel.ok, false);
      assert.equal(viaCancel.error.code, "Cancelled");
      await server.waitForEvent("Cancelled:bytes");

      const controller = new AbortController();
      const aborted = client.fixture.bytes(
        { chunks: 100, size: 8 },
        { signal: controller.signal },
      );
      const chunks = aborted.chunks()[Symbol.asyncIterator]();
      await chunks.next();
      controller.abort();
      const viaAbort = await settle(aborted.result);
      assert.equal(viaAbort.ok, false);
      assert.equal(viaAbort.error.code, "Cancelled");
      assert.equal(viaAbort.error.local, true);
      await server.waitForEvent("Cancelled:bytes");
      assert.equal(await client.fixture.echo(2), 2);
      client.$close();
    });

    it("timeoutMs ends a stream nobody reads with the server's DeadlineExceeded", async () => {
      const client = createClient(api, await makeTransport());
      const stream = client.fixture.bytes({ chunks: 100, size: 8 }, { timeoutMs: 150 });
      const r = await settle(stream.result);
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "DeadlineExceeded");
      assert.equal(r.error.local, false, "the server's deadline, not the client's");
      // The chunks sent before the deadline are still delivered, then the error.
      const it = stream.chunks()[Symbol.asyncIterator]();
      for (let n = 0; n < INITIAL_CREDITS; n++) assert.equal((await it.next()).done, false);
      const end = await settle(it.next());
      assert.equal(end.ok, false);
      assert.equal(end.error.code, "DeadlineExceeded");
      client.$close();
    });

    it("a stream's typed error arrives after its chunks", async () => {
      const client = createClient(api, await makeTransport());
      const stream = client.fixture.bytes({ chunks: 2, size: 4, then: "fail" });
      const seen: number[] = [];
      const ended = await settle(
        (async () => {
          for await (const chunk of stream.chunks()) seen.push(chunk[0] as number);
        })(),
      );
      assert.deepEqual(seen, [0, 1]);
      assert.equal(ended.ok, false);
      assert.ok(isRpcError(ended.error, api.procedures.fixture.bytes));
      assert.equal(ended.error.code, "FailedPrecondition");
      assert.equal(ended.error.local, false);
      assert.deepEqual(ended.error.details, {
        kind: "Requested",
        code: "FailedPrecondition",
        retryable: false,
      });
      await assert.rejects(stream.result, (e: RpcError) => e.code === "FailedPrecondition");
      client.$close();
    });

    it("an unauthorized stream is refused before any chunk", async () => {
      const counting = new Counting(await makeTransport());
      const client = createClient(api, counting);
      const stream = client.fixture.secret_bytes(null);
      const r = await settle(stream.chunks()[Symbol.asyncIterator]().next());
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "PermissionDenied");
      await assert.rejects(stream.result, (e: RpcError) => e.code === "PermissionDenied");
      assert.equal(counting.chunks, 0);
      assert.equal(await client.fixture.echo("alive"), "alive");
      client.$close();
    });

    it("a declared-only stream answers Unimplemented", async () => {
      const client = createClient(api, await makeTransport());
      const stream = client.fixture.rows(null);
      await assert.rejects(stream.result, (e: RpcError) => e.code === "Unimplemented");
      assert.equal(await client.fixture.echo("alive"), "alive");
      client.$close();
    });

    it("decodes the Arrow stream of ArrowSink in a Worker: schema, nulls, every row", async () => {
      const client = createClient(api, await makeTransport());
      // 1000-row batches do not fit the 4096-byte frames: the sink splits them by rows.
      const arrow = decodeArrow(
        client.fixture.arrow_rows({ rows: 2500, batch_rows: 1000 }),
        arrowWorker.port,
      );
      assert.deepEqual(
        (await arrow.schema).map((f) => [f.name, f.type, f.nullable]),
        [
          ["id", "Int64", false],
          ["n", "Int32", true],
          ["f", "Float64", false],
          ["s", "Utf8", false],
          ["b", "Binary", true],
        ],
      );
      let id = 0;
      let batches = 0;
      for await (const batch of arrow.batches()) {
        batches += 1;
        for (const row of rowsOf(batch)) assert.deepEqual(row, fixtureRow(id++));
      }
      assert.equal(id, 2500);
      assert.ok(batches > 3, "split into frame-sized batches");
      assert.deepEqual(await arrow.result, { rows: 2500 });
      client.$close();
    });

    it("grants an Arrow chunk's credit only after it was decoded and the consumer came back", async () => {
      const counting = new Counting(await makeTransport());
      const client = createClient(api, counting);
      // A driver-like source: schema, ten batches, end-of-stream; one chunk each.
      const arrow = decodeArrow(
        client.fixture.arrow_rows({ rows: 500, batch_rows: 50, pre_encoded: true }),
        arrowWorker.port,
      );
      await arrow.schema;
      // Only the schema chunk was taken: nobody asked for a batch, so no credit went out.
      await until(() => counting.chunks === INITIAL_CREDITS);
      await tick(150);
      assert.equal(counting.chunks, INITIAL_CREDITS);
      assert.deepEqual(counting.credits, []);
      // Asking for a batch takes the next chunk, which pays for the decoded schema chunk.
      const it = arrow.batches()[Symbol.asyncIterator]();
      const first = await it.next();
      assert.equal(first.value?.numRows, 50);
      await until(() => counting.chunks === INITIAL_CREDITS + 1);
      await tick(150);
      assert.equal(counting.chunks, INITIAL_CREDITS + 1, "holding a batch takes nothing more");
      assert.deepEqual(counting.credits, [{ chunks: 1 }]);
      let id = 50;
      for (let r = await it.next(); r.done !== true; r = await it.next()) {
        for (const row of rowsOf(r.value)) assert.deepEqual(row, fixtureRow(id++));
      }
      assert.equal(id, 500);
      assert.equal(counting.chunks, 12);
      assert.deepEqual(await arrow.result, { rows: 500 });
      client.$close();
    });

    it("leaving batches() early cancels the Arrow stream on the server", async () => {
      const client = createClient(api, await makeTransport());
      await client.$connect();
      await server.events();
      const arrow = decodeArrow(
        client.fixture.arrow_rows({ rows: 100_000, batch_rows: 50 }),
        arrowWorker.port,
      );
      for await (const batch of arrow.batches()) {
        assert.ok(batch.numRows > 0);
        break;
      }
      await assert.rejects(arrow.result, (e: RpcError) => e.code === "Cancelled" && e.local);
      await server.waitForEvent("Cancelled:arrow_rows");
      assert.equal(await client.fixture.echo(3), 3);
      client.$close();
    });
  });
}

/**
 * Wraps a transport and withholds the server's terminal frames (Result, Error, StreamEnd), like a
 * server that never answers. `withheld` resolves with the first one it held back.
 */
class Unanswered implements Transport {
  readonly name = "unanswered";
  readonly withheld: Promise<Frame>;
  #inner: Transport;
  #resolve!: (frame: Frame) => void;

  constructor(inner: Transport) {
    this.#inner = inner;
    this.withheld = new Promise((resolve) => {
      this.#resolve = resolve;
    });
  }

  open(sink: PipeSink): Promise<Pipe> {
    const decoder = new FrameDecoder(Number.MAX_SAFE_INTEGER);
    return this.#inner.open({
      data: (bytes) => {
        decoder.push(bytes);
        for (let f = decoder.next(); f !== undefined; f = decoder.next()) {
          const terminal =
            f.kind === Kind.Result || f.kind === Kind.Error || f.kind === Kind.StreamEnd;
          if (terminal && f.callId !== 0) {
            this.#resolve(f);
            continue;
          }
          sink.data(encodeFrame(f, Number.MAX_SAFE_INTEGER));
        }
      },
      closed: (error) => sink.closed(error),
    });
  }
}

/** Lets pending promise callbacks and I/O run (setImmediate is not mocked). */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("safety timer against the Rust engine", { skip }, () => {
  it("uses the advertised cancel_grace_ms plus networkMarginMs, not timeoutSlackMs", async (t) => {
    const transport = new Unanswered(await webSocket());
    const client = createClient(api, transport, { networkMarginMs: 50, timeoutSlackMs: 60_000 });
    const ack = await client.$connect();
    // The fixture server's cancel_grace (crates/ambidex-conformance, CANCEL_GRACE).
    assert.equal(ack.limits.cancel_grace_ms, 100);

    t.mock.timers.enable({ apis: ["setTimeout"] });
    // An already-expired deadline: the server answers DeadlineExceeded at once, which the
    // wrapper withholds, so only the client's safety timer can end the call.
    const call: { outcome?: Awaited<ReturnType<typeof settle>> } = {};
    void settle(client.fixture.wait(null, { timeoutMs: 0 })).then((r) => {
      call.outcome = r;
    });
    // Read through a function: an assertion on `call.outcome` would narrow it for good.
    const current = () => call.outcome;
    const withheld = await transport.withheld;
    assert.equal(withheld.kind, Kind.Error);
    await drain();
    // deadline 0 + cancel_grace_ms 100 + networkMarginMs 50.
    t.mock.timers.tick(149);
    await drain();
    assert.equal(current(), undefined, "still waiting for the server inside the slack");
    t.mock.timers.tick(1);
    await drain();
    const outcome = current();
    assert.ok(outcome !== undefined && !outcome.ok);
    assert.equal(outcome.error.code, "DeadlineExceeded");
    assert.equal(outcome.error.local, true, "the client's safety timer");
    t.mock.timers.reset();
    client.$close();
  });

  it("ends a stream the server never ends, at its deadline plus the slack", async (t) => {
    const transport = new Unanswered(await webSocket());
    const client = createClient(api, transport, { networkMarginMs: 50, timeoutSlackMs: 60_000 });
    await client.$connect();
    await server.events();

    t.mock.timers.enable({ apis: ["setTimeout"] });
    // An already-expired deadline: the server's DeadlineExceeded is withheld.
    const stream = client.fixture.bytes({ chunks: 100, size: 8 }, { timeoutMs: 0 });
    const call: { outcome?: Awaited<ReturnType<typeof settle>> } = {};
    void settle(stream.result).then((r) => {
      call.outcome = r;
    });
    const current = () => call.outcome;
    assert.equal((await transport.withheld).kind, Kind.Error);
    await drain();
    t.mock.timers.tick(149);
    await drain();
    assert.equal(current(), undefined, "still waiting for the server inside the slack");
    t.mock.timers.tick(1);
    await drain();
    const outcome = current();
    assert.ok(outcome !== undefined && !outcome.ok);
    assert.equal(outcome.error.code, "DeadlineExceeded");
    assert.equal(outcome.error.local, true, "the client's safety timer");
    t.mock.timers.reset();
    client.$close();
  });
});

describe("handshake against the Rust engine", { skip }, () => {
  it("a stale schema hash gets VersionMismatch", async () => {
    const client = createClient(api.procedures, await webSocket(), {
      api: api.API,
      schemaHash: "sha256:0000",
    });
    const r = await settle(client.fixture.echo(1));
    assert.equal(r.ok, false);
    assert.ok(r.error instanceof RpcError);
    assert.equal(r.error.code, "VersionMismatch");
  });

  it("the committed api.ts matches the server's schema hash", () => {
    assert.equal(api.SCHEMA_HASH, server.info.schema_hash);
  });

  it("a foreign Origin is refused at the upgrade", async () => {
    const client = createClient(api, await webSocket("https://evil.test"));
    const r = await settle(client.fixture.echo(1));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "Unavailable");
  });
});
