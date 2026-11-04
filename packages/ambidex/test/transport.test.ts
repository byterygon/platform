// Transport adapters in isolation: the Tauri pipe against a fake `__TAURI_INTERNALS__` that
// behaves like Tauri 2.12 (raw-body invokes, `{message, index}` / `{end, index}` channel
// messages delivered out of order), the WebSocket pipe against a fake socket, and selection.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  CONNECTION_HEADER,
  type PipeSink,
  TAURI_COMMANDS,
  type TauriIpc,
  TauriTransport,
  TransportError,
  type WebSocketLike,
  WebSocketTransport,
  autoTransport,
  isTauri,
} from "../src/index.js";
import { tick } from "./support/mock-server.js";

class RecordingSink implements PipeSink {
  chunks: number[][] = [];
  closes: Array<Error | undefined> = [];
  data(bytes: Uint8Array): void {
    this.chunks.push([...bytes]);
  }
  closed(error?: Error): void {
    this.closes.push(error);
  }
}

interface Invoke {
  cmd: string;
  args: unknown;
  headers: Record<string, string> | undefined;
}

class FakeTauri implements TauriIpc {
  invokes: Invoke[] = [];
  callbacks = new Map<number, (m: unknown) => void>();
  nextId = 41;
  failConnect = false;
  failSend = false;
  /** Pending send invokes resolve when the test releases them. */
  holdSends = false;
  #held: Array<() => void> = [];

  async invoke(
    cmd: string,
    args?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<unknown> {
    this.invokes.push({ cmd, args, headers: options?.headers });
    if (cmd === TAURI_COMMANDS.connect) {
      if (this.failConnect) throw "session refused";
      return "c0ffee";
    }
    if (cmd === TAURI_COMMANDS.send) {
      if (this.failSend) throw "unknown connection";
      if (this.holdSends) await new Promise<void>((r) => this.#held.push(r));
    }
    return null;
  }

  transformCallback(callback: (m: unknown) => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  unregisterCallback(id: number): void {
    this.callbacks.delete(id);
  }

  release(): void {
    for (const r of this.#held.splice(0)) r();
  }

  /** Delivers a channel message as Tauri's injected script does. */
  emit(id: number, message: unknown): void {
    this.callbacks.get(id)?.(message);
  }

  sends(): Invoke[] {
    return this.invokes.filter((i) => i.cmd === TAURI_COMMANDS.send);
  }
}

const ab = (...b: number[]) => new Uint8Array(b).buffer;

describe("TauriTransport", () => {
  it("connects with a serialized channel and sends raw bodies with the connection header", async () => {
    const ipc = new FakeTauri();
    const sink = new RecordingSink();
    const pipe = await new TauriTransport({ ipc }).open(sink);
    const connect = ipc.invokes[0] as Invoke;
    assert.equal(connect.cmd, "plugin:ambidex|connect");
    assert.deepEqual(connect.args, { onFrame: "__CHANNEL__:41" });
    pipe.send(new Uint8Array([1, 2, 3]));
    await tick();
    const send = ipc.sends()[0] as Invoke;
    assert.ok(send.args instanceof Uint8Array, "raw body, not JSON");
    assert.deepEqual([...(send.args as Uint8Array)], [1, 2, 3]);
    assert.deepEqual(send.headers, { [CONNECTION_HEADER]: "c0ffee" });
    assert.equal(pipe.auth, undefined, "the desktop session needs no credentials from the page");
  });

  it("keeps one send in flight and coalesces queued bytes in order", async () => {
    const ipc = new FakeTauri();
    ipc.holdSends = true;
    const pipe = await new TauriTransport({ ipc }).open(new RecordingSink());
    pipe.send(new Uint8Array([1]));
    pipe.send(new Uint8Array([2]));
    pipe.send(new Uint8Array([3]));
    await tick();
    assert.equal(ipc.sends().length, 1);
    ipc.release();
    await tick();
    assert.equal(ipc.sends().length, 2);
    assert.deepEqual([...(ipc.sends()[1]?.args as Uint8Array)], [2, 3]);
    ipc.release();
  });

  it("reorders channel messages by index and delivers ArrayBuffers as bytes", async () => {
    const ipc = new FakeTauri();
    const sink = new RecordingSink();
    await new TauriTransport({ ipc }).open(sink);
    ipc.emit(41, { message: ab(3), index: 2 });
    ipc.emit(41, { message: ab(1), index: 0 });
    assert.deepEqual(sink.chunks, [[1]]);
    ipc.emit(41, { message: new Uint8Array([2]), index: 1 });
    assert.deepEqual(sink.chunks, [[1], [2], [3]]);
  });

  it("closes cleanly on the channel end only after every earlier message", async () => {
    const ipc = new FakeTauri();
    const sink = new RecordingSink();
    await new TauriTransport({ ipc }).open(sink);
    ipc.emit(41, { end: true, index: 1 });
    assert.deepEqual(sink.closes, []);
    ipc.emit(41, { message: ab(7), index: 0 });
    assert.deepEqual(sink.chunks, [[7]]);
    assert.deepEqual(sink.closes, [undefined]);
    assert.equal(ipc.callbacks.size, 0, "channel callback released");
  });

  it("closes with an error when a send fails or a message is not binary", async () => {
    const ipc = new FakeTauri();
    ipc.failSend = true;
    const sink = new RecordingSink();
    const pipe = await new TauriTransport({ ipc }).open(sink);
    pipe.send(new Uint8Array([1]));
    await tick();
    assert.equal(sink.closes.length, 1);
    assert.ok(sink.closes[0] instanceof TransportError);

    const ipc2 = new FakeTauri();
    const sink2 = new RecordingSink();
    await new TauriTransport({ ipc: ipc2 }).open(sink2);
    ipc2.emit(41, { message: "text", index: 0 });
    assert.ok(sink2.closes[0] instanceof TransportError);
  });

  it("close() invokes close for the connection and reports closed once", async () => {
    const ipc = new FakeTauri();
    const sink = new RecordingSink();
    const pipe = await new TauriTransport({ ipc }).open(sink);
    pipe.close();
    pipe.close();
    await tick();
    const closes = ipc.invokes.filter((i) => i.cmd === TAURI_COMMANDS.close);
    assert.deepEqual(
      closes.map((c) => c.args),
      [{ connection: "c0ffee" }],
    );
    assert.deepEqual(sink.closes, [undefined]);
    assert.equal(ipc.callbacks.size, 0);
    pipe.send(new Uint8Array([1]));
    await tick();
    assert.equal(ipc.sends().length, 0, "nothing is sent after close");
  });

  it("fails open without leaking the channel callback", async () => {
    const ipc = new FakeTauri();
    ipc.failConnect = true;
    await assert.rejects(new TauriTransport({ ipc }).open(new RecordingSink()), TransportError);
    assert.equal(ipc.callbacks.size, 0);
  });
});

class FakeSocket implements WebSocketLike {
  static last: FakeSocket | undefined;
  binaryType = "blob";
  readyState = 0;
  sent: Uint8Array[] = [];
  closedWith: number | undefined;
  #listeners = new Map<string, Set<(e: any) => void>>();

  constructor(readonly url: string) {
    FakeSocket.last = this;
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }
  addEventListener(type: string, l: (e: any) => void): void {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type)?.add(l);
  }
  removeEventListener(type: string, l: (e: any) => void): void {
    this.#listeners.get(type)?.delete(l);
  }
  fire(type: string, event: unknown = {}): void {
    if (type === "open") this.readyState = 1;
    for (const l of [...(this.#listeners.get(type) ?? [])]) l(event);
  }
  get listenerCount(): number {
    let n = 0;
    for (const s of this.#listeners.values()) n += s.size;
    return n;
  }
}

const fakeSocket = (url: string) => new FakeSocket(url);

describe("WebSocketTransport", () => {
  afterEach(() => {
    delete (globalThis as { location?: unknown }).location;
  });

  it("opens a binary socket, passes auth and moves bytes both ways", async () => {
    const sink = new RecordingSink();
    const opening = new WebSocketTransport({
      url: "wss://dbee.test/rpc/ws",
      auth: () => ({ csrf: "t" }),
      createSocket: fakeSocket,
    }).open(sink);
    const socket = FakeSocket.last as FakeSocket;
    assert.equal(socket.binaryType, "arraybuffer");
    socket.fire("open");
    const pipe = await opening;
    assert.deepEqual(pipe.auth, { csrf: "t" });
    pipe.send(new Uint8Array([1, 2]));
    assert.deepEqual([...(socket.sent[0] as Uint8Array)], [1, 2]);
    socket.fire("message", { data: ab(9, 8) });
    assert.deepEqual(sink.chunks, [[9, 8]]);
    pipe.close();
    assert.equal(socket.closedWith, 1000);
    assert.deepEqual(sink.closes, [undefined]);
    assert.equal(socket.listenerCount, 0, "listeners removed");
  });

  it("closes on a text message, like the server does", async () => {
    const sink = new RecordingSink();
    const opening = new WebSocketTransport({
      url: "wss://x.test/rpc/ws",
      createSocket: fakeSocket,
    }).open(sink);
    const socket = FakeSocket.last as FakeSocket;
    socket.fire("open");
    await opening;
    socket.fire("message", { data: "hello" });
    assert.ok(sink.closes[0] instanceof TransportError);
    assert.equal(socket.closedWith, 1000);
  });

  it("reports an abnormal close as an error and a normal one without", async () => {
    for (const [event, abnormal] of [
      [{ code: 1006, wasClean: false }, true],
      [{ code: 1000, wasClean: true }, false],
    ] as const) {
      const sink = new RecordingSink();
      const opening = new WebSocketTransport({
        url: "wss://x.test/rpc/ws",
        createSocket: fakeSocket,
      }).open(sink);
      const socket = FakeSocket.last as FakeSocket;
      socket.fire("open");
      await opening;
      socket.fire("close", event);
      assert.equal(sink.closes.length, 1);
      assert.equal(sink.closes[0] instanceof TransportError, abnormal);
    }
  });

  it("rejects open when the socket fails before opening (e.g. upgrade refused)", async () => {
    const opening = new WebSocketTransport({
      url: "wss://x.test/rpc/ws",
      createSocket: fakeSocket,
    }).open(new RecordingSink());
    (FakeSocket.last as FakeSocket).fire("error");
    await assert.rejects(opening, TransportError);
  });

  it("derives wss://<page host>/rpc/ws and refuses plain ws: unless allowed", async () => {
    (globalThis as { location?: unknown }).location = { host: "dbee.example.com:8443" };
    void new WebSocketTransport({ createSocket: fakeSocket }).open(new RecordingSink());
    assert.equal(FakeSocket.last?.url, "wss://dbee.example.com:8443/rpc/ws");
    await assert.rejects(
      new WebSocketTransport({ url: "ws://dbee.test/rpc/ws", createSocket: fakeSocket }).open(
        new RecordingSink(),
      ),
      TransportError,
    );
    void new WebSocketTransport({
      url: "ws://127.0.0.1:1/rpc/ws",
      createSocket: fakeSocket,
      allowInsecure: true,
    }).open(new RecordingSink());
    assert.equal(FakeSocket.last?.url, "ws://127.0.0.1:1/rpc/ws");
  });
});

describe("autoTransport", () => {
  afterEach(() => {
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("picks WebSocket in an ordinary browser", () => {
    assert.equal(isTauri(), false);
    assert.equal(autoTransport().name, "websocket");
  });

  it("does not take a partial or look-alike global for Tauri", () => {
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: () => {} };
    assert.equal(isTauri(), false);
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = "yes";
    assert.equal(autoTransport().name, "websocket");
  });

  it("picks Tauri when the webview has Tauri's IPC", async () => {
    const ipc = new FakeTauri();
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = ipc;
    assert.equal(isTauri(), true);
    const transport = autoTransport();
    assert.equal(transport.name, "tauri");
    await transport.open(new RecordingSink());
    assert.equal(ipc.invokes[0]?.cmd, TAURI_COMMANDS.connect);
  });

  it("honours an explicit choice", () => {
    assert.equal(autoTransport({ force: "tauri" }).name, "tauri");
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = new FakeTauri();
    assert.equal(autoTransport({ force: "websocket" }).name, "websocket");
  });
});
