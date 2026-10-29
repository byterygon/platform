// One protocol connection (Ambidex spec §3, §7): handshake, call ids, frame routing, Ping, Goaway.
//
// The client side of `crates/ambidex/src/engine.rs`. Rules it keeps:
//
// - The first frame is `Hello` on call 0; the connection is usable only after `HelloAck`. An
//   `Error` on call 0 before that is the handshake rejection (`VersionMismatch`,
//   `Unauthenticated`); the server closes after it.
// - After `HelloAck`, the server's `limits.max_frame_bytes` bounds every payload in both
//   directions (spec Open question 14d); until then incoming payloads are bounded by the default.
// - Call ids start at 1 and strictly increase; an id is never reused, even after its call ended
//   (spec Open question 15). When the u32 space is used up the connection stops taking calls and
//   closes once its last call ends; the client opens a new one.
// - Frames for a call id that is no longer registered are dropped: that call already settled
//   locally (abort, client deadline), and since ids are never reused, a late answer cannot reach
//   another call.
// - A server `Goaway` or an `Error` on call 0 after the handshake ends the connection: every
//   registered call fails with that error. A malformed or unexpected frame is a protocol
//   violation: this side sends `Goaway` and closes.

import { RpcError, isErrorCode, localError } from "./errors.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  FLAG_BINARY,
  type Frame,
  FrameDecoder,
  FrameError,
  Kind,
  encodeFrame,
  jsonFrame,
  parseJson,
} from "./frame.js";
import type { Pipe, Transport } from "./transport.js";

const MAX_CALL_ID = 0xffff_ffff;

/** What the client announces in Hello. */
export interface HelloInfo {
  readonly api: string;
  readonly schemaHash: string;
  readonly protocol: number;
  readonly clientVersion: string;
}

/** Limits the server enforces on this connection (`HelloAck.limits`). */
export interface Limits {
  readonly max_frame_bytes: number;
  readonly max_concurrent_calls: number;
}

/** The server's `HelloAck`. `session` identifies the session; it is not a credential. */
export interface HelloAck {
  readonly session: string;
  readonly limits: Limits;
  readonly server_version: string;
}

/** Receives the frames of one call (or subscription, or stream). */
export interface CallHandler {
  /** A frame for this call id. */
  frame(frame: Frame): void;
  /** The connection ended before the call did. Called at most once, then never `frame`. */
  fail(error: RpcError): void;
}

export interface ConnectionOptions {
  readonly hello: HelloInfo;
  /** Time allowed for the pipe to open plus the handshake. */
  readonly helloTimeoutMs: number;
  /** First call id to hand out. Tests only (call id exhaustion); default 1. */
  readonly firstCallId?: number;
}

type State = "handshake" | "open" | "closed";

export class Connection {
  #pipe: Pipe | undefined;
  #state: State = "handshake";
  #decoder = new FrameDecoder(DEFAULT_MAX_FRAME_BYTES);
  #maxSend = DEFAULT_MAX_FRAME_BYTES;
  #ack: HelloAck | undefined;
  #lastId = 0;
  #calls = new Map<number, CallHandler>();
  #pings: Array<() => void> = [];
  #pingFailures: Array<(error: RpcError) => void> = [];
  #closeError: RpcError | undefined;
  #closedListeners = new Set<(error: RpcError) => void>();
  #handshake: { resolve: (ack: HelloAck) => void; reject: (error: RpcError) => void } | undefined;

  private constructor() {}

  /** Opens a pipe on `transport` and completes the handshake. */
  static open(transport: Transport, options: ConnectionOptions): Promise<Connection> {
    const conn = new Connection();
    return conn.#start(transport, options).then(() => conn);
  }

  /** The server's HelloAck. */
  get ack(): HelloAck {
    if (this.#ack === undefined) throw new Error("handshake not complete");
    return this.#ack;
  }

  get closed(): boolean {
    return this.#state === "closed";
  }

  /** Calls, subscriptions and streams registered and not yet ended. */
  get activeCalls(): number {
    return this.#calls.size;
  }

  /** False once call ids are used up or the connection closed: open a new connection. */
  get accepting(): boolean {
    return this.#state === "open" && this.#lastId < MAX_CALL_ID;
  }

  /** Called once when the connection ends, with the reason given to its calls. */
  onClosed(listener: (error: RpcError) => void): () => void {
    if (this.#closeError !== undefined) {
      listener(this.#closeError);
      return () => {};
    }
    this.#closedListeners.add(listener);
    return () => this.#closedListeners.delete(listener);
  }

  /**
   * Registers a call and returns its id, the next one in strictly increasing order. Returns
   * `undefined` when the connection cannot take calls (closed, or ids exhausted).
   */
  register(handler: CallHandler): number | undefined {
    if (!this.accepting) return undefined;
    const id = ++this.#lastId;
    this.#calls.set(id, handler);
    return id;
  }

  /** Forgets a call; later frames for its id are dropped. */
  release(id: number): void {
    this.#calls.delete(id);
    this.#retireIfDone();
  }

  /**
   * Sends a JSON frame for a registered call. Throws a local `RpcError` (`ResourceExhausted`)
   * when the payload exceeds the server's frame limit, or `InvalidArgument` when `message` is not
   * JSON-serializable; nothing is sent then.
   */
  sendJson(kind: Kind, callId: number, message: unknown): void {
    let frame: Frame;
    try {
      frame = jsonFrame(kind, callId, message);
    } catch {
      // Never echo the value: it is the caller's input.
      throw localError("InvalidArgument", "input is not JSON-serializable");
    }
    this.#send(frame);
  }

  /** Sends Cancel for `callId` and forgets the call. Safe to call for a call that already ended. */
  cancel(callId: number): void {
    if (!this.#calls.delete(callId)) return;
    if (this.#state === "open") this.#trySend(jsonFrame(Kind.Cancel, callId, undefined));
    this.#retireIfDone();
  }

  /** Sends Unsubscribe for `callId` and forgets the subscription. */
  unsubscribe(callId: number): void {
    if (!this.#calls.delete(callId)) return;
    if (this.#state === "open") this.#trySend(jsonFrame(Kind.Unsubscribe, callId, undefined));
    this.#retireIfDone();
  }

  /** Round trip of a Ping, in milliseconds. */
  ping(): Promise<number> {
    if (this.#state !== "open") {
      return Promise.reject(this.#closeError ?? localError("Unavailable", "connection closed"));
    }
    const started = Date.now();
    return new Promise<number>((resolve, reject) => {
      this.#pings.push(() => resolve(Date.now() - started));
      this.#pingFailures.push(reject);
      this.#trySend(jsonFrame(Kind.Ping, 0, undefined));
    });
  }

  /**
   * Closes the connection: sends Goaway (the server then cancels every call on it) and closes
   * the pipe. Registered calls fail with `error`.
   */
  close(error: RpcError = localError("Unavailable", "connection closed")): void {
    if (this.#state === "closed") return;
    if (this.#state === "open") {
      this.#trySend(jsonFrame(Kind.Goaway, 0, { code: "Unavailable", message: "client closed" }));
    }
    this.#shutdown(error);
  }

  // ---- internals

  async #start(transport: Transport, options: ConnectionOptions): Promise<void> {
    this.#lastId = (options.firstCallId ?? 1) - 1;
    const handshake = new Promise<HelloAck>((resolve, reject) => {
      this.#handshake = { resolve, reject };
    });
    // Rejections are delivered through the awaited race below; never leave one unhandled.
    handshake.catch(() => {});
    const timer = setTimeout(() => {
      this.#shutdown(localError("Unavailable", "handshake timed out", { retryable: true }));
    }, options.helloTimeoutMs);
    try {
      const opening = transport.open({
        data: (bytes) => this.#onData(bytes),
        closed: (error) => this.#onPipeClosed(error),
      });
      // A pipe that opens after the handshake already failed (timeout) is closed at once.
      opening.then(
        (pipe) => {
          if (this.#state === "closed") pipe.close();
        },
        () => {},
      );
      // Before the pipe exists the handshake can only reject (timeout, pipe closed).
      const pipe = await Promise.race([opening, handshake.then(() => opening)]);
      if (this.#state === "closed") {
        throw this.#closeError ?? localError("Unavailable", "connection closed");
      }
      this.#pipe = pipe;
      const { hello } = options;
      const payload: Record<string, unknown> = {
        protocol: hello.protocol,
        api: hello.api,
        schema_hash: hello.schemaHash,
        client_version: hello.clientVersion,
      };
      if (pipe.auth !== undefined) payload["auth"] = pipe.auth;
      this.#send(jsonFrame(Kind.Hello, 0, payload));
      this.#ack = await handshake;
    } catch (error) {
      this.#shutdown(
        error instanceof RpcError
          ? error
          : localError("Unavailable", "transport failed to open", { retryable: true }),
      );
      throw this.#closeError;
    } finally {
      clearTimeout(timer);
    }
  }

  #send(frame: Frame): void {
    if (this.#pipe === undefined || this.#state === "closed") {
      throw this.#closeError ?? localError("Unavailable", "connection closed");
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeFrame(frame, this.#maxSend);
    } catch (error) {
      if (error instanceof FrameError && error.reason === "too-large") {
        throw localError("ResourceExhausted", "payload exceeds the frame size limit");
      }
      throw error;
    }
    this.#pipe.send(bytes);
  }

  /** Sends a control frame; a failure here only means the connection is going away. */
  #trySend(frame: Frame): void {
    try {
      this.#send(frame);
    } catch {
      // Closing is reported through the pipe.
    }
  }

  #onData(bytes: Uint8Array): void {
    if (this.#state === "closed") return;
    this.#decoder.push(bytes);
    for (;;) {
      let frame: Frame | undefined;
      try {
        frame = this.#decoder.next();
      } catch {
        return this.#violation();
      }
      if (frame === undefined) return;
      this.#onFrame(frame);
      // A frame can close the connection (Goaway, violation).
      if (this.closed) return;
    }
  }

  #onFrame(frame: Frame): void {
    if (this.#state === "handshake") return this.#onHandshakeFrame(frame);
    switch (frame.kind) {
      case Kind.Result:
      case Kind.Error:
      case Kind.Event:
      case Kind.Chunk:
      case Kind.StreamEnd: {
        if (frame.callId === 0) {
          if (frame.kind === Kind.Error) return this.#fatal(frame);
          return this.#violation();
        }
        // Control payloads are JSON; only stream chunks may be binary.
        if ((frame.flags & FLAG_BINARY) !== 0 && frame.kind !== Kind.Chunk) {
          return this.#violation();
        }
        this.#calls.get(frame.callId)?.frame(frame);
        return;
      }
      case Kind.Ping:
        this.#trySend({ ...frame, kind: Kind.Pong });
        return;
      case Kind.Pong:
        this.#pingFailures.shift();
        this.#pings.shift()?.();
        return;
      case Kind.Goaway: {
        const goaway = safeJson(frame.payload);
        const error = goawayError(goaway);
        this.#shutdown(error);
        return;
      }
      default:
        // Hello, HelloAck, Call, Cancel, Credit, Subscribe, Unsubscribe: client-to-server only, or
        // a second HelloAck.
        return this.#violation();
    }
  }

  #onHandshakeFrame(frame: Frame): void {
    if (frame.callId !== 0 || (frame.flags & FLAG_BINARY) !== 0) return this.#violation();
    if (frame.kind === Kind.Error) {
      // The server closes after a rejection; so do we.
      return this.#shutdown(RpcError.fromPayload(safeJson(frame.payload)));
    }
    if (frame.kind === Kind.Goaway) return this.#shutdown(goawayError(safeJson(frame.payload)));
    if (frame.kind !== Kind.HelloAck) return this.#violation();
    const ack = parseAck(safeJson(frame.payload));
    if (ack === undefined) return this.#violation();
    this.#maxSend = ack.limits.max_frame_bytes;
    this.#decoder.maxPayload = ack.limits.max_frame_bytes;
    this.#state = "open";
    this.#handshake?.resolve(ack);
    this.#handshake = undefined;
  }

  /** `Error` on call 0 after the handshake: the server reports a violation and closes. */
  #fatal(frame: Frame): void {
    this.#shutdown(RpcError.fromPayload(safeJson(frame.payload)));
  }

  /** The server broke the protocol. Tell it, then close. */
  #violation(): void {
    if (this.#state === "open") {
      this.#trySend(
        jsonFrame(Kind.Goaway, 0, { code: "InvalidArgument", message: "protocol violation" }),
      );
    }
    this.#shutdown(localError("Unavailable", "protocol violation by the server"));
  }

  #onPipeClosed(error?: Error): void {
    void error; // Transport details are not surfaced: they may describe the network.
    this.#shutdown(localError("Unavailable", "connection closed", { retryable: true }));
  }

  /** Closes once nothing is registered and no new call can be registered (ids exhausted). */
  #retireIfDone(): void {
    if (this.#state === "open" && this.#lastId >= MAX_CALL_ID && this.#calls.size === 0) {
      this.close(localError("Unavailable", "call ids exhausted", { retryable: true }));
    }
  }

  #shutdown(error: RpcError): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#closeError = error;
    const pipe = this.#pipe;
    this.#pipe = undefined;
    pipe?.close();
    this.#handshake?.reject(error);
    this.#handshake = undefined;
    const calls = [...this.#calls.values()];
    this.#calls.clear();
    for (const call of calls) call.fail(error);
    const failures = this.#pingFailures;
    this.#pingFailures = [];
    this.#pings = [];
    for (const fail of failures) fail(error);
    const listeners = [...this.#closedListeners];
    this.#closedListeners.clear();
    for (const listener of listeners) listener(error);
  }
}

function safeJson(payload: Uint8Array): unknown {
  try {
    return parseJson(payload);
  } catch {
    return undefined;
  }
}

function goawayError(goaway: unknown): RpcError {
  const g = (typeof goaway === "object" && goaway !== null ? goaway : {}) as Record<
    string,
    unknown
  >;
  const code = isErrorCode(g["code"]) ? g["code"] : "Unavailable";
  const message = typeof g["message"] === "string" ? g["message"] : "server closed the connection";
  return new RpcError(code, message);
}

function isU32(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_CALL_ID;
}

function parseAck(value: unknown): HelloAck | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  const limits = v["limits"] as Record<string, unknown> | undefined;
  if (
    typeof v["session"] !== "string" ||
    typeof v["server_version"] !== "string" ||
    typeof limits !== "object" ||
    limits === null ||
    !isU32(limits["max_frame_bytes"]) ||
    !isU32(limits["max_concurrent_calls"])
  ) {
    return undefined;
  }
  return {
    session: v["session"],
    server_version: v["server_version"],
    limits: {
      max_frame_bytes: limits["max_frame_bytes"],
      max_concurrent_calls: limits["max_concurrent_calls"],
    },
  };
}
