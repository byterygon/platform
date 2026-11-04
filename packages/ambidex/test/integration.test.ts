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
  FrameDecoder,
  Kind,
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
import * as api from "./conformance/api.js";
import { settle } from "./support/mock-server.js";
import { RustServer, serverUnavailable } from "./support/rust-server.js";

const skip = serverUnavailable();

let server: RustServer;

before(async () => {
  if (skip === undefined) server = await RustServer.start();
});

after(async () => {
  await server?.stop();
});

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

    it("surfaces the server's Unimplemented for subscriptions and streams (no engine support yet)", async () => {
      const client = createClient(api, await makeTransport());
      const sub = client.fixture.counter(null);
      await assert.rejects(
        (async () => {
          for await (const _ of sub) assert.fail("no events expected");
        })(),
        (e: RpcError) => e.code === "Unimplemented",
      );
      const stream = client.fixture.rows(null);
      await assert.rejects(stream.result, (e: RpcError) => e.code === "Unimplemented");
      assert.equal(await client.fixture.echo("alive"), "alive");
      client.$close();
    });
  });
}

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
