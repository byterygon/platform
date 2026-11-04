// An in-memory transport with a scripted server side, for deterministic runtime tests: the test
// reads every frame the client sends and decides each server frame (order, timing, payload).

import {
  FLAG_BINARY,
  type Frame,
  FrameDecoder,
  Kind,
  type Pipe,
  type PipeSink,
  type Transport,
  encodeFrame,
} from "../../src/index.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const ACK = {
  session: "s-1",
  limits: { max_frame_bytes: 4096, max_concurrent_calls: 4 },
  server_version: "mock",
};

export function json(frame: Frame): any {
  return frame.payload.byteLength === 0 ? undefined : JSON.parse(textDecoder.decode(frame.payload));
}

export class MockPeer {
  readonly received: Frame[] = [];
  readonly pipe: Pipe;
  closedByClient = false;
  #sink: PipeSink;
  #decoder = new FrameDecoder(Number.MAX_SAFE_INTEGER);
  #cursor = 0;
  #waiters: Array<() => void> = [];
  #ended = false;

  constructor(sink: PipeSink, autoAck: boolean, auth?: unknown) {
    this.#sink = sink;
    this.pipe = {
      send: (bytes) => {
        if (this.#ended) return;
        this.#decoder.push(bytes);
        for (let f = this.#decoder.next(); f !== undefined; f = this.#decoder.next()) {
          this.received.push(f);
          if (autoAck && f.kind === Kind.Hello) {
            queueMicrotask(() => this.json(Kind.HelloAck, 0, ACK));
          }
        }
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const w of waiters) w();
      },
      close: () => {
        if (this.#ended) return;
        this.closedByClient = true;
        this.#end();
      },
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** The next frame the client sent that the test has not consumed yet. */
  async next(timeoutMs = 2000): Promise<Frame> {
    const until = Date.now() + timeoutMs;
    while (this.#cursor >= this.received.length) {
      if (Date.now() > until) throw new Error("no frame from client");
      await new Promise<void>((resolve) => {
        this.#waiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
    return this.received[this.#cursor++] as Frame;
  }

  /** Skips to the next frame of `kind`. */
  async nextOf(kind: Kind, timeoutMs = 2000): Promise<Frame> {
    for (;;) {
      const f = await this.next(timeoutMs);
      if (f.kind === kind) return f;
    }
  }

  /** Frames received but not consumed. */
  unread(): Frame[] {
    return this.received.slice(this.#cursor);
  }

  raw(bytes: Uint8Array): void {
    if (!this.#ended) this.#sink.data(bytes);
  }

  frame(kind: Kind, callId: number, payload: Uint8Array, flags = 0): void {
    this.raw(encodeFrame({ kind, flags, callId, payload }, Number.MAX_SAFE_INTEGER));
  }

  json(kind: Kind, callId: number, message?: unknown): void {
    const payload =
      message === undefined ? new Uint8Array(0) : textEncoder.encode(JSON.stringify(message));
    this.frame(kind, callId, payload);
  }

  binary(kind: Kind, callId: number, payload: Uint8Array): void {
    this.frame(kind, callId, payload, FLAG_BINARY);
  }

  error(callId: number, code: string, extra: Record<string, unknown> = {}): void {
    this.json(Kind.Error, callId, {
      code,
      message: `${code} from mock`,
      retryable: false,
      correlation_id: `c-${callId}`,
      ...extra,
    });
  }

  /** The server side drops the pipe. */
  drop(error?: Error): void {
    if (this.#ended) return;
    this.#end(error);
  }

  #end(error?: Error): void {
    this.#ended = true;
    this.#sink.closed(error);
  }
}

export class MockTransport implements Transport {
  readonly name = "mock";
  readonly peers: MockPeer[] = [];
  autoAck = true;
  auth: unknown;
  /** Make `open` reject. */
  failOpen = false;
  /** Make `open` never settle. */
  hangOpen = false;
  #waiters: Array<() => void> = [];

  open(sink: PipeSink): Promise<Pipe> {
    if (this.failOpen) return Promise.reject(new Error("refused"));
    if (this.hangOpen) return new Promise(() => {});
    const peer = new MockPeer(sink, this.autoAck, this.auth);
    this.peers.push(peer);
    for (const w of this.#waiters.splice(0)) w();
    return Promise.resolve(peer.pipe);
  }

  /** The peer of the `n`th opened connection, waiting for it if needed. */
  async peer(n = 0): Promise<MockPeer> {
    while (this.peers.length <= n) await new Promise<void>((r) => this.#waiters.push(r));
    return this.peers[n] as MockPeer;
  }
}

/** A generated-module-shaped API for tests, built from the conformance fixture. */
export async function settle<T>(
  promise: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: any }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

/** An AbortSignal stand-in that counts its listeners, to check none leak. */
export class CountingSignal {
  aborted = false;
  reason: unknown;
  #listeners = new Set<() => void>();

  get listeners(): number {
    return this.#listeners.size;
  }

  addEventListener(_type: "abort", listener: () => void): void {
    this.#listeners.add(listener);
  }

  removeEventListener(_type: "abort", listener: () => void): void {
    this.#listeners.delete(listener);
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    for (const l of [...this.#listeners]) {
      this.#listeners.delete(l);
      l();
    }
  }

  get signal(): AbortSignal {
    return this as unknown as AbortSignal;
  }
}

export const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));
