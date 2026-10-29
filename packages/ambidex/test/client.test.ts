// Runtime behaviour against a scripted server (deterministic): handshake, calls, errors,
// cancellation, deadlines, call ids, subscriptions, streams, connection loss and leaks. The
// procedure table is the generated conformance fixture (`test/conformance/api.ts`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { debugState } from "../src/client.js";
import { Connection } from "../src/connection.js";
import { type ClientOptions, Kind, RpcError, createClient, isRpcError } from "../src/index.js";
import * as api from "./conformance/api.js";
import { CountingSignal, MockTransport, json, settle, tick } from "./support/mock-server.js";

function setup(options: ClientOptions = {}) {
  const transport = new MockTransport();
  const client = createClient(api, transport, options);
  return { transport, client };
}

describe("handshake", () => {
  it("sends Hello with api, schema hash, protocol and auth, then calls", async () => {
    const { transport, client } = setup();
    transport.auth = { csrf: "token" };
    const ack = client.$connect();
    const peer = await transport.peer();
    const hello = await peer.next();
    assert.equal(hello.kind, Kind.Hello);
    assert.equal(hello.callId, 0);
    assert.deepEqual(json(hello), {
      protocol: 1,
      api: "conformance",
      schema_hash: api.SCHEMA_HASH,
      client_version: "@byterygon/ambidex/0.0.0",
      auth: { csrf: "token" },
    });
    assert.equal((await ack).session, "s-1");
  });

  it("rejects calls with VersionMismatch when the server refuses Hello", async () => {
    const { transport, client } = setup();
    transport.autoAck = false;
    const call = settle(client.fixture.echo(1));
    const peer = await transport.peer();
    await peer.nextOf(Kind.Hello);
    peer.error(0, "VersionMismatch", { message: "client and server versions differ" });
    const r = await call;
    assert.equal(r.ok, false);
    assert.ok(isRpcError(r.error));
    assert.equal(r.error.code, "VersionMismatch");
    assert.equal(r.error.procedure, "fixture.echo");
    assert.ok(peer.closedByClient, "the pipe is closed after a rejection");
  });

  it("fails with Unavailable when the handshake times out, then retries on the next call", async () => {
    const { transport, client } = setup({ helloTimeoutMs: 30 });
    transport.autoAck = false;
    const r = await settle(client.fixture.echo(1));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "Unavailable");
    assert.equal(r.error.local, true);
    transport.autoAck = true;
    const second = client.fixture.echo(2);
    const peer = await transport.peer(1);
    const call = await peer.nextOf(Kind.Call);
    peer.json(Kind.Result, call.callId, 2);
    assert.equal(await second, 2);
  });

  it("times out an open that never completes", async () => {
    const { transport, client } = setup({ helloTimeoutMs: 30 });
    transport.hangOpen = true;
    const r = await settle(client.fixture.echo(1));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "Unavailable");
  });

  it("treats a malformed HelloAck as a protocol violation", async () => {
    const { transport, client } = setup();
    transport.autoAck = false;
    const call = settle(client.fixture.echo(1));
    const peer = await transport.peer();
    await peer.nextOf(Kind.Hello);
    peer.json(Kind.HelloAck, 0, { session: "s" });
    const r = await call;
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "Unavailable");
    assert.ok(peer.closedByClient);
  });

  it("refuses an api generated for another protocol major", () => {
    assert.throws(() => createClient({ ...api, PROTOCOL: 2 }, new MockTransport()), TypeError);
  });
});

describe("queries and mutations", () => {
  it("send {procedure, input} and resolve with the Result", async () => {
    const { transport, client } = setup();
    const echoed = client.fixture.echo({ any: ["json", 1, null] });
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    assert.equal(call.flags, 0);
    assert.deepEqual(json(call), { procedure: "fixture.echo", input: { any: ["json", 1, null] } });
    peer.json(Kind.Result, call.callId, { any: ["json", 1, null] });
    assert.deepEqual(await echoed, { any: ["json", 1, null] });

    const done = client.fixture.protected({ code: "NotFound" });
    const m = await peer.nextOf(Kind.Call);
    assert.deepEqual(json(m), { procedure: "fixture.protected", input: { code: "NotFound" } });
    peer.json(Kind.Result, m.callId, null);
    assert.equal(await done, null);
  });

  it("sends null for an omitted input", async () => {
    const { transport, client } = setup();
    // The generated types require an input here; a Rust `()` input may be omitted.
    void settle((client.fixture.wait as (input?: null) => Promise<string>)());
    const call = await (await transport.peer()).nextOf(Kind.Call);
    assert.deepEqual(json(call), { procedure: "fixture.wait", input: null });
    client.$close();
  });

  it("answers concurrent calls by call id, out of order", async () => {
    const { transport, client } = setup();
    const calls = [client.fixture.echo("a"), client.fixture.echo("b"), client.fixture.echo("c")];
    const peer = await transport.peer();
    const frames = [
      await peer.nextOf(Kind.Call),
      await peer.nextOf(Kind.Call),
      await peer.nextOf(Kind.Call),
    ];
    for (const f of [...frames].reverse()) peer.json(Kind.Result, f.callId, json(f).input);
    assert.deepEqual(await Promise.all(calls), ["a", "b", "c"]);
  });

  it("uses strictly increasing call ids and never reuses one", async () => {
    const { transport, client } = setup();
    const peer = await (async () => {
      void client.$connect();
      return transport.peer();
    })();
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const p = settle(client.fixture.wait(null, { signal: controller.signal }));
      const call = await peer.nextOf(Kind.Call);
      ids.push(call.callId);
      if (i % 2 === 0) controller.abort();
      else peer.json(Kind.Result, call.callId, "done");
      await p;
    }
    void settle(client.fixture.echo(1));
    ids.push((await peer.nextOf(Kind.Call)).callId);
    assert.deepEqual(ids, [1, 2, 3, 4, 5, 6]);
    client.$close();
  });

  it("rejects a non-JSON input locally without echoing it", async () => {
    const { transport, client } = setup();
    void client.$connect();
    await transport.peer();
    const r = await settle(client.fixture.echo(10n as unknown as number));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "InvalidArgument");
    assert.ok(!String(r.error.message).includes("10"));
  });

  it("rejects a payload over the server's frame limit without sending it", async () => {
    const { transport, client } = setup();
    void client.$connect();
    const peer = await transport.peer();
    await peer.nextOf(Kind.Hello);
    const r = await settle(client.fixture.echo("x".repeat(5000)));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "ResourceExhausted");
    await tick(10);
    assert.deepEqual(
      peer.unread().filter((f) => f.kind === Kind.Call),
      [],
    );
  });
});

describe("errors", () => {
  it("maps an Error frame to a typed RpcError with details, retryable and correlation id", async () => {
    const { transport, client } = setup();
    const failed = settle(client.fixture.fail({ code: "NotFound", retryable: true }));
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    peer.json(Kind.Error, call.callId, {
      code: "NotFound",
      message: "requested NotFound",
      details: { kind: "Requested", code: "NotFound", retryable: true },
      retryable: true,
      correlation_id: "abc-1",
    });
    const r = await failed;
    assert.equal(r.ok, false);
    const e = r.error;
    assert.ok(e instanceof RpcError);
    assert.ok(isRpcError(e, api.procedures.fixture.fail));
    assert.ok(!isRpcError(e, api.procedures.fixture.echo), "narrowing is per procedure");
    assert.equal(e.code, "NotFound");
    assert.equal(e.message, "requested NotFound");
    assert.deepEqual(e.details, { kind: "Requested", code: "NotFound", retryable: true });
    assert.equal(e.retryable, true);
    assert.equal(e.correlation_id, "abc-1");
    assert.equal(e.local, false);
    // Typed per the generated FixtureError.
    const details = e.details as api.FixtureError | undefined;
    assert.equal(details?.kind, "Requested");
  });

  it("keeps PermissionDenied generic and ApprovalRequired's approval id", async () => {
    const { transport, client } = setup();
    const denied = settle(client.fixture.protected({ code: "NotFound" }));
    const approval = settle(client.fixture.approval(null));
    const peer = await transport.peer();
    const d = await peer.nextOf(Kind.Call);
    const a = await peer.nextOf(Kind.Call);
    peer.json(Kind.Error, d.callId, {
      code: "PermissionDenied",
      message: "permission denied",
      retryable: false,
      correlation_id: "x-1",
    });
    peer.json(Kind.Error, a.callId, {
      code: "ApprovalRequired",
      message: "approval required",
      details: { approval_id: "approval-1" },
      retryable: false,
      correlation_id: "x-2",
    });
    const dr = await denied;
    assert.equal(dr.ok, false);
    assert.equal(dr.error.code, "PermissionDenied");
    assert.equal(dr.error.details, undefined);
    const ar = await approval;
    assert.equal(ar.ok, false);
    const e = ar.error;
    assert.ok(isRpcError(e, api.procedures.fixture.approval));
    if (e.code === "ApprovalRequired" && e.details !== undefined && "approval_id" in e.details) {
      assert.equal(e.details.approval_id, "approval-1");
    } else {
      assert.fail("ApprovalRequired with approval id expected");
    }
  });

  it("never carries details on Internal and survives a malformed Error payload", async () => {
    const { transport, client } = setup();
    const leak = settle(client.fixture.leak(null));
    const bad = settle(client.fixture.echo(1));
    const peer = await transport.peer();
    const l = await peer.nextOf(Kind.Call);
    const b = await peer.nextOf(Kind.Call);
    peer.json(Kind.Error, l.callId, {
      code: "Internal",
      message: "internal error",
      details: { dsn: "postgres://x" },
      retryable: false,
      correlation_id: "c",
    });
    peer.json(Kind.Error, b.callId, "nonsense");
    const lr = await leak;
    assert.equal(lr.ok, false);
    assert.equal(lr.error.code, "Internal");
    assert.equal(lr.error.details, undefined);
    const br = await bad;
    assert.equal(br.ok, false);
    assert.equal(br.error.code, "Internal");
  });
});

describe("cancellation", () => {
  it("abort before dispatch sends nothing and consumes no call id", async () => {
    const { transport, client } = setup();
    void client.$connect();
    const peer = await transport.peer();
    await peer.nextOf(Kind.Hello);
    const controller = new AbortController();
    controller.abort();
    const r = await settle(client.fixture.wait(null, { signal: controller.signal }));
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "Cancelled");
    assert.equal(r.error.local, true);
    void settle(client.fixture.echo(1));
    assert.equal((await peer.nextOf(Kind.Call)).callId, 1);
    client.$close();
  });

  it("abort while connecting sends nothing", async () => {
    const { transport, client } = setup();
    transport.autoAck = false;
    const controller = new AbortController();
    const r = settle(client.fixture.wait(null, { signal: controller.signal }));
    const peer = await transport.peer();
    await peer.nextOf(Kind.Hello);
    controller.abort();
    assert.equal((await r).ok, false);
    peer.json(Kind.HelloAck, 0, {
      session: "s",
      limits: { max_frame_bytes: 4096, max_concurrent_calls: 4 },
      server_version: "v",
    });
    await tick(10);
    assert.deepEqual(peer.unread(), []);
  });

  it("abort during execution sends one Cancel and rejects at once; the late answer is dropped", async () => {
    const { transport, client } = setup();
    const signal = new CountingSignal();
    const waiting = settle(client.fixture.wait(null, { signal: signal.signal }));
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    assert.equal(signal.listeners, 1);
    signal.abort();
    signal.abort();
    const r = await waiting;
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "Cancelled");
    const cancel = await peer.next();
    assert.equal(cancel.kind, Kind.Cancel);
    assert.equal(cancel.callId, call.callId);
    assert.equal(cancel.payload.byteLength, 0);
    // The server's Cancelled reply and even a late Result for that id reach nobody.
    peer.error(call.callId, "Cancelled");
    peer.json(Kind.Result, call.callId, "late");
    const next = client.fixture.echo("fresh");
    const fresh = await peer.nextOf(Kind.Call);
    assert.ok(fresh.callId > call.callId);
    peer.json(Kind.Result, fresh.callId, "fresh");
    assert.equal(await next, "fresh");
    await tick(10);
    assert.deepEqual(
      peer.unread().filter((f) => f.kind === Kind.Cancel),
      [],
      "one Cancel only",
    );
  });

  it("abort after completion is a no-op and leaves no listener", async () => {
    const { transport, client } = setup();
    const signal = new CountingSignal();
    const echoed = client.fixture.echo(1, { signal: signal.signal });
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    peer.json(Kind.Result, call.callId, 1);
    assert.equal(await echoed, 1);
    assert.equal(signal.listeners, 0);
    signal.abort();
    await tick(10);
    assert.deepEqual(peer.unread(), []);
  });
});

describe("deadlines", () => {
  it("sends timeoutMs as timeout_ms and surfaces the server's DeadlineExceeded", async () => {
    const { transport, client } = setup();
    const r = settle(client.fixture.wait(null, { timeoutMs: 250 }));
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    assert.deepEqual(json(call), { procedure: "fixture.wait", input: null, timeout_ms: 250 });
    peer.error(call.callId, "DeadlineExceeded");
    const out = await r;
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "DeadlineExceeded");
    assert.equal(out.error.local, false);
  });

  it("rejects an invalid timeoutMs locally", async () => {
    const { client } = setup();
    for (const timeoutMs of [-1, 1.5, Number.NaN, 2 ** 53]) {
      const r = await settle(client.fixture.echo(1, { timeoutMs }));
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "InvalidArgument");
    }
  });

  it("fails locally only after the effective deadline plus slack, and sends Cancel", async () => {
    const { transport, client } = setup({ timeoutSlackMs: 40 });
    // fixture.capped has timeoutMaxMs 50: a 10 s client timeout is capped to 50 ms.
    const started = Date.now();
    const r = settle(client.fixture.capped(null, { timeoutMs: 10_000 }));
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    assert.equal(json(call).timeout_ms, 10_000);
    const out = await r;
    const elapsed = Date.now() - started;
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "DeadlineExceeded");
    assert.equal(out.error.local, true);
    assert.ok(elapsed >= 85, `failed after ${elapsed} ms, before deadline + slack`);
    const cancel = await peer.nextOf(Kind.Cancel);
    assert.equal(cancel.callId, call.callId);
  });

  it("lets the server's answer win inside the slack window", async () => {
    const { transport, client } = setup({ timeoutSlackMs: 500 });
    const r = client.fixture.capped(null);
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    await tick(80); // past the 50 ms deadline, inside the slack
    peer.json(Kind.Result, call.callId, "ok");
    assert.equal(await r, "ok");
  });
});

describe("connection loss", () => {
  it("fails calls in flight with Unavailable; only queries are marked retryable", async () => {
    const { transport, client } = setup();
    const q = settle(client.fixture.wait(null));
    const m = settle(client.fixture.escalate(null));
    const peer = await transport.peer();
    await peer.nextOf(Kind.Call);
    await peer.nextOf(Kind.Call);
    peer.drop(new Error("socket reset"));
    const [qr, mr] = await Promise.all([q, m]);
    assert.equal(qr.ok, false);
    assert.equal(qr.error.code, "Unavailable");
    assert.equal(qr.error.retryable, true);
    assert.equal(mr.ok, false);
    assert.equal(mr.error.retryable, false, "a mutation may have run");
    assert.ok(!String(qr.error.message).includes("socket reset"), "transport details stay out");
    // The next call opens a new connection; nothing is replayed.
    const again = client.fixture.echo(1);
    const peer2 = await transport.peer(1);
    const calls = [];
    for (let f = await peer2.next(); ; f = await peer2.next()) {
      if (f.kind === Kind.Call) {
        calls.push(json(f));
        peer2.json(Kind.Result, f.callId, 1);
        break;
      }
    }
    assert.equal(await again, 1);
    assert.deepEqual(calls, [{ procedure: "fixture.echo", input: 1 }]);
  });

  it("fails calls with the Goaway code and message (session revoked)", async () => {
    const { transport, client } = setup();
    const r = settle(client.fixture.wait(null));
    const peer = await transport.peer();
    await peer.nextOf(Kind.Call);
    peer.json(Kind.Goaway, 0, { code: "Unauthenticated", message: "session revoked" });
    const out = await r;
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "Unauthenticated");
    assert.equal(out.error.message, "session revoked");
    assert.ok(peer.closedByClient);
  });

  it("closes on an Error for call 0 after the handshake", async () => {
    const { transport, client } = setup();
    const r = settle(client.fixture.wait(null));
    const peer = await transport.peer();
    await peer.nextOf(Kind.Call);
    peer.error(0, "InvalidArgument");
    const out = await r;
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "InvalidArgument");
  });

  it("answers a server protocol violation with Goaway and closes", async () => {
    const { transport, client } = setup();
    const r = settle(client.fixture.wait(null));
    const peer = await transport.peer();
    await peer.nextOf(Kind.Call);
    // A client-only frame kind from the server.
    peer.json(Kind.Call, 9, {});
    const out = await r;
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "Unavailable");
    const goaway = await peer.nextOf(Kind.Goaway);
    assert.deepEqual(json(goaway), { code: "InvalidArgument", message: "protocol violation" });
    assert.ok(peer.closedByClient);
  });

  it("treats garbage bytes and binary control payloads as violations", async () => {
    for (const poison of [
      (p: import("./support/mock-server.js").MockPeer, id: number) =>
        p.raw(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9])),
      (p: import("./support/mock-server.js").MockPeer, id: number) =>
        p.binary(Kind.Result, id, new Uint8Array([1])),
      (p: import("./support/mock-server.js").MockPeer, id: number) =>
        p.frame(Kind.Result, id, new Uint8Array(5000)),
    ]) {
      const { transport, client } = setup();
      const r = settle(client.fixture.wait(null));
      const peer = await transport.peer();
      const call = await peer.nextOf(Kind.Call);
      poison(peer, call.callId);
      const out = await r;
      assert.equal(out.ok, false);
      assert.equal(out.error.code, "Unavailable");
      assert.ok(peer.closedByClient);
    }
  });

  it("$close sends Goaway, cancels calls and refuses new ones", async () => {
    const { transport, client } = setup();
    const r = settle(client.fixture.wait(null));
    const peer = await transport.peer();
    await peer.nextOf(Kind.Call);
    client.$close();
    const out = await r;
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "Cancelled");
    const goaway = await peer.nextOf(Kind.Goaway);
    assert.deepEqual(json(goaway), { code: "Unavailable", message: "client closed" });
    const after = await settle(client.fixture.echo(1));
    assert.equal(after.ok, false);
    assert.equal(after.error.code, "Unavailable");
  });

  it("answers Ping with $ping and server Pings with Pong", async () => {
    const { transport, client } = setup();
    const rtt = client.$ping();
    const peer = await transport.peer();
    const ping = await peer.nextOf(Kind.Ping);
    assert.equal(ping.callId, 0);
    peer.json(Kind.Pong, 0);
    assert.ok((await rtt) >= 0);
    peer.frame(Kind.Ping, 0, new Uint8Array([1, 2]));
    const pong = await peer.nextOf(Kind.Pong);
    assert.deepEqual([...pong.payload], [1, 2]);
  });
});

describe("call id exhaustion", () => {
  it("stops taking calls at u32::MAX and closes once idle", async () => {
    const transport = new MockTransport();
    const conn = await Connection.open(transport, {
      hello: { api: "conformance", schemaHash: api.SCHEMA_HASH, protocol: 1, clientVersion: "t" },
      helloTimeoutMs: 1000,
      firstCallId: 0xffff_ffff,
    });
    const handler = { frame() {}, fail() {} };
    const last = conn.register(handler);
    assert.equal(last, 0xffff_ffff);
    assert.equal(conn.register(handler), undefined, "no id after u32::MAX");
    assert.equal(conn.accepting, false);
    assert.equal(conn.closed, false, "stays open while a call runs");
    conn.release(last as number);
    assert.equal(conn.closed, true, "closes once the last call ended");
  });
});

describe("subscriptions", () => {
  it("sends Subscribe and yields events in order", async () => {
    const { transport, client } = setup();
    const sub = client.fixture.counter(null);
    const peer = await transport.peer();
    const s = await peer.nextOf(Kind.Subscribe);
    assert.deepEqual(json(s), { procedure: "fixture.counter", input: null });
    for (let i = 1; i <= 5; i++) peer.json(Kind.Event, s.callId, i);
    const seen: number[] = [];
    for await (const n of sub) {
      seen.push(n);
      if (n === 5) break;
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5]);
    // Leaving the loop unsubscribed.
    const unsub = await peer.nextOf(Kind.Unsubscribe);
    assert.equal(unsub.callId, s.callId);
  });

  it("unsubscribe() sends Unsubscribe once, ends the iterator and drops later events", async () => {
    const { transport, client } = setup();
    const signal = new CountingSignal();
    const sub = client.fixture.counter(null, { signal: signal.signal });
    const peer = await transport.peer();
    const s = await peer.nextOf(Kind.Subscribe);
    const it = sub[Symbol.asyncIterator]();
    const pending = it.next();
    sub.unsubscribe();
    sub.unsubscribe();
    assert.deepEqual(await pending, { value: undefined, done: true });
    peer.json(Kind.Event, s.callId, 99);
    assert.deepEqual(await it.next(), { value: undefined, done: true });
    assert.equal(signal.listeners, 0);
    await peer.nextOf(Kind.Unsubscribe);
    await tick(10);
    assert.deepEqual(peer.unread(), []);
  });

  it("propagates the server's Error to the consumer after buffered events", async () => {
    const { transport, client } = setup();
    const sub = client.fixture.counter(null);
    const peer = await transport.peer();
    const s = await peer.nextOf(Kind.Subscribe);
    peer.json(Kind.Event, s.callId, 1);
    peer.error(s.callId, "Unimplemented");
    const seen: number[] = [];
    await assert.rejects(
      (async () => {
        for await (const n of sub) seen.push(n);
      })(),
      (e: RpcError) => e.code === "Unimplemented" && e.procedure === "fixture.counter",
    );
    assert.deepEqual(seen, [1]);
  });

  it("abort ends the iteration with Cancelled and unsubscribes", async () => {
    const { transport, client } = setup();
    const controller = new AbortController();
    const sub = client.fixture.counter(null, { signal: controller.signal });
    const peer = await transport.peer();
    const s = await peer.nextOf(Kind.Subscribe);
    const it = sub[Symbol.asyncIterator]();
    const next = it.next();
    controller.abort();
    await assert.rejects(next, (e: RpcError) => e.code === "Cancelled");
    assert.equal((await peer.nextOf(Kind.Unsubscribe)).callId, s.callId);
  });

  it("ends on disconnect and on Goaway", async () => {
    const { transport, client } = setup();
    const sub = client.fixture.counter(null);
    const peer = await transport.peer();
    await peer.nextOf(Kind.Subscribe);
    peer.json(Kind.Goaway, 0, { code: "Unauthenticated", message: "session revoked" });
    await assert.rejects(
      sub[Symbol.asyncIterator]().next(),
      (e: RpcError) => e.code === "Unauthenticated",
    );
  });

  it("ends with ResourceExhausted when the consumer falls behind the buffer limit", async () => {
    const { transport, client } = setup({ maxBufferedEvents: 3 });
    const sub = client.fixture.counter(null);
    const peer = await transport.peer();
    const s = await peer.nextOf(Kind.Subscribe);
    for (let i = 0; i < 5; i++) peer.json(Kind.Event, s.callId, i);
    const seen: number[] = [];
    await assert.rejects(
      (async () => {
        for await (const n of sub) seen.push(n);
      })(),
      (e: RpcError) => e.code === "ResourceExhausted",
    );
    assert.deepEqual(seen, [0, 1, 2]);
    await peer.nextOf(Kind.Unsubscribe);
  });

  it("allows one iteration only", () => {
    const { client } = setup();
    const sub = client.fixture.counter(null);
    sub[Symbol.asyncIterator]();
    assert.throws(() => sub[Symbol.asyncIterator](), TypeError);
    sub.unsubscribe();
  });
});

describe("streams (M1 shape)", () => {
  it("yields binary chunks then resolves the StreamEnd summary", async () => {
    const { transport, client } = setup();
    const stream = client.fixture.rows(null);
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    assert.deepEqual(json(call), { procedure: "fixture.rows", input: null });
    peer.binary(Kind.Chunk, call.callId, new Uint8Array([1, 2]));
    peer.binary(Kind.Chunk, call.callId, new Uint8Array([3]));
    peer.json(Kind.StreamEnd, call.callId, 3);
    const chunks: number[][] = [];
    for await (const c of stream.chunks()) chunks.push([...c]);
    assert.deepEqual(chunks, [[1, 2], [3]]);
    assert.equal(await stream.result, 3);
  });

  it("rejects result and chunks on Error without an unhandled rejection", async () => {
    const { transport, client } = setup();
    const stream = client.fixture.rows(null);
    const peer = await transport.peer();
    const call = await peer.nextOf(Kind.Call);
    peer.error(call.callId, "Unimplemented");
    await assert.rejects(stream.result, (e: RpcError) => e.code === "Unimplemented");
    await assert.rejects(
      stream.chunks()[Symbol.asyncIterator]().next(),
      (e: RpcError) => e.code === "Unimplemented",
    );
  });
});

describe("leaks", () => {
  it("leaves no registered call and no abort listener after every way a call can end", async () => {
    const transport = new MockTransport();
    const client = createClient(api, transport);
    await client.$connect();
    const peer = await transport.peer();
    const signals: CountingSignal[] = [];
    const sig = () => {
      const s = new CountingSignal();
      signals.push(s);
      return s.signal;
    };
    const ok = client.fixture.echo(1, { signal: sig() });
    const err = settle(client.fixture.fail({ code: "NotFound" }, { signal: sig() }));
    const aborted = settle(client.fixture.wait(null, { signal: sig() }));
    const timedOutClient = createClient(api, transport, { timeoutSlackMs: 1 });
    const timedOut = settle(timedOutClient.fixture.capped(null));
    const sub = client.fixture.counter(null, { signal: sig() });
    const f1 = await peer.nextOf(Kind.Call);
    const f2 = await peer.nextOf(Kind.Call);
    await peer.nextOf(Kind.Call);
    await peer.nextOf(Kind.Subscribe);
    peer.json(Kind.Result, f1.callId, 1);
    peer.error(f2.callId, "NotFound");
    (signals[2] as CountingSignal).abort();
    sub.unsubscribe();
    await Promise.all([ok, err, aborted, timedOut]);
    for (const s of signals) assert.equal(s.listeners, 0);
    assert.deepEqual(debugState(client), { live: 0, activeCalls: 0 });
    assert.deepEqual(debugState(timedOutClient), { live: 0, activeCalls: 0 });
    // Late frames for every finished id reach nobody and change nothing.
    for (let id = 1; id <= 4; id++) peer.json(Kind.Result, id, "late");
    assert.deepEqual(debugState(client), { live: 0, activeCalls: 0 });
    client.$close();
    timedOutClient.$close();
  });
});
