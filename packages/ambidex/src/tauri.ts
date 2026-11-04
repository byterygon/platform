// Tauri IPC transport (Ambidex spec §4), the webview side of `crates/ambidex-tauri`.
//
// Command contract (TSK-9, `ambidex_tauri::plugin`):
//
//   plugin:ambidex|connect  { onFrame: Channel }                         -> connection id
//   plugin:ambidex|send     raw body = client bytes, header ambidex-connection: <id>
//   plugin:ambidex|close    { connection: <id> }
//
// Server frames arrive on the `onFrame` channel as `ArrayBuffer`s. Tauri wraps each channel
// message as `{ message, index }` and signals the Rust side dropping the channel (the connection
// ended) with `{ end: true, index }`; large messages are fetched asynchronously and can arrive out
// of order, so the pipe reorders by `index` exactly like `@tauri-apps/api`'s `Channel` does.
//
// Client bytes go out as raw-body invokes, never JSON-wrapped. Invokes are asynchronous and Tauri
// may run them concurrently, so sends are serialized: one invoke in flight, later bytes coalesced
// into the next one, which keeps the byte stream in order.
//
// No network listener, no URI scheme: the session is the webview's desktop session, bound by the
// plugin to the calling webview's label (spec §8); this side sends no credentials.

import { type Pipe, type PipeSink, type Transport, TransportError } from "./transport.js";

/** Plugin command names. */
export const TAURI_COMMANDS = {
  connect: "plugin:ambidex|connect",
  send: "plugin:ambidex|send",
  close: "plugin:ambidex|close",
} as const;

/** Header carrying the connection id on `send` (`ambidex_tauri::CONNECTION_HEADER`). */
export const CONNECTION_HEADER = "ambidex-connection";

/** The IPC primitives the transport needs. `window.__TAURI_INTERNALS__` provides them. */
export interface TauriIpc {
  invoke(
    cmd: string,
    args?: unknown,
    options?: { headers?: Record<string, string> },
  ): Promise<unknown>;
  /** Registers a callback and returns its id (Tauri's `transformCallback`). */
  transformCallback(callback: (message: unknown) => void, once?: boolean): number;
  unregisterCallback?(id: number): void;
}

/** Tauri's serialized channel argument (`IPC_PAYLOAD_PREFIX`). */
const CHANNEL_PREFIX = "__CHANNEL__:";

/** The Tauri IPC of this webview, if it runs inside a Tauri app. */
export function tauriIpc(): TauriIpc | undefined {
  const internals = (globalThis as { __TAURI_INTERNALS__?: Partial<TauriIpc> }).__TAURI_INTERNALS__;
  if (
    typeof internals !== "object" ||
    internals === null ||
    typeof internals.invoke !== "function" ||
    typeof internals.transformCallback !== "function"
  ) {
    return undefined;
  }
  return internals as TauriIpc;
}

export interface TauriTransportOptions {
  /** IPC to use. Default: `window.__TAURI_INTERNALS__`. For tests. */
  readonly ipc?: TauriIpc;
}

export class TauriTransport implements Transport {
  readonly name = "tauri";
  readonly #ipc: TauriIpc | undefined;

  constructor(options: TauriTransportOptions = {}) {
    this.#ipc = options.ipc;
  }

  async open(sink: PipeSink): Promise<Pipe> {
    const ipc = this.#ipc ?? tauriIpc();
    if (ipc === undefined) throw new TransportError("not running in a Tauri webview");
    const pipe = new TauriPipe(ipc, sink);
    try {
      await pipe.connect();
    } catch {
      pipe.dispose();
      // The plugin's error strings ("session refused", ...) are safe, but keep one shape.
      throw new TransportError("Tauri connect failed");
    }
    return pipe;
  }
}

class TauriPipe implements Pipe {
  readonly #ipc: TauriIpc;
  readonly #sink: PipeSink;
  readonly #callbackId: number;
  #connection: string | undefined;
  #ended = false;
  // Channel ordering.
  #nextIndex = 0;
  #pending = new Map<number, unknown>();
  #endIndex: number | undefined;
  // Send queue.
  #queue: Uint8Array[] = [];
  #sending = false;

  constructor(ipc: TauriIpc, sink: PipeSink) {
    this.#ipc = ipc;
    this.#sink = sink;
    this.#callbackId = ipc.transformCallback((raw) => this.#onChannel(raw));
  }

  async connect(): Promise<void> {
    const id = await this.#ipc.invoke(TAURI_COMMANDS.connect, {
      onFrame: `${CHANNEL_PREFIX}${this.#callbackId}`,
    });
    if (typeof id !== "string") throw new TransportError("bad connection id");
    if (this.#ended) {
      // Ended while connecting (channel end): release the server side.
      this.#ipc.invoke(TAURI_COMMANDS.close, { connection: id }).catch(() => {});
      throw new TransportError("connection ended");
    }
    this.#connection = id;
  }

  send(bytes: Uint8Array): void {
    if (this.#ended) return;
    this.#queue.push(bytes);
    if (!this.#sending) void this.#flush();
  }

  close(): void {
    if (this.#ended) return;
    const id = this.#connection;
    this.#end();
    if (id !== undefined)
      this.#ipc.invoke(TAURI_COMMANDS.close, { connection: id }).catch(() => {});
  }

  /** Releases the channel callback without notifying the sink (open failed). */
  dispose(): void {
    this.#ended = true;
    this.#ipc.unregisterCallback?.(this.#callbackId);
  }

  async #flush(): Promise<void> {
    this.#sending = true;
    try {
      while (!this.#ended && this.#queue.length > 0) {
        const body = coalesce(this.#queue);
        this.#queue = [];
        await this.#ipc.invoke(TAURI_COMMANDS.send, body, {
          headers: { [CONNECTION_HEADER]: this.#connection ?? "" },
        });
      }
    } catch {
      // "unknown connection": the server side closed (session ended, page load).
      this.#end(new TransportError("Tauri send failed"));
    } finally {
      this.#sending = false;
    }
  }

  #onChannel(raw: unknown): void {
    if (this.#ended) return;
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as { index?: unknown }).index !== "number"
    ) {
      return this.#end(new TransportError("unexpected channel message"));
    }
    const msg = raw as { index: number; end?: boolean; message?: unknown };
    if (msg.end === true) {
      this.#endIndex = msg.index;
    } else {
      this.#pending.set(msg.index, msg.message);
    }
    while (this.#pending.has(this.#nextIndex)) {
      const message = this.#pending.get(this.#nextIndex);
      this.#pending.delete(this.#nextIndex);
      this.#nextIndex += 1;
      const bytes = toBytes(message);
      if (bytes === undefined) return this.#end(new TransportError("non-binary channel message"));
      this.#sink.data(bytes);
      if (this.#ended) return;
    }
    // The Rust side dropped the channel once every message before `end` was delivered.
    if (this.#endIndex !== undefined && this.#nextIndex >= this.#endIndex) this.#end();
  }

  #end(error?: Error): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#queue = [];
    this.#pending.clear();
    this.#ipc.unregisterCallback?.(this.#callbackId);
    this.#sink.closed(error);
  }
}

function toBytes(message: unknown): Uint8Array | undefined {
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return undefined;
}

function coalesce(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let len = 0;
  for (const c of chunks) len += c.byteLength;
  const out = new Uint8Array(len);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
