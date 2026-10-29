// Frame codec (Ambidex spec §3), the TypeScript twin of `crates/ambidex/src/frame.rs`.
//
// Every frame is a 12-byte little-endian header followed by `payload_len` bytes:
//
//   version u8 | kind u8 | flags u16 | call_id u32 | payload_len u32
//
// Transports may split or coalesce frames freely, so decoding is incremental: push bytes into a
// `FrameDecoder` and pull whole frames out. The header is validated before any payload is
// buffered, so an oversize `payload_len` is rejected without allocating for it.

/** Protocol major carried in every frame header. */
export const PROTOCOL_VERSION = 1;

/** Size of the fixed frame header in bytes. */
export const HEADER_LEN = 12;

/** Default maximum payload size (16 MiB), spec §3. */
export const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** Frame kinds, numbered in spec §3 order from 1 (spec Open question 14a); 0 is invalid. */
export const Kind = {
  Hello: 1,
  HelloAck: 2,
  Call: 3,
  Result: 4,
  Error: 5,
  Cancel: 6,
  Chunk: 7,
  StreamEnd: 8,
  Credit: 9,
  Subscribe: 10,
  Event: 11,
  Unsubscribe: 12,
  Ping: 13,
  Pong: 14,
  Goaway: 15,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** Payload is raw bytes; otherwise it is JSON. */
export const FLAG_BINARY = 1 << 0;
/** Reserved, rejected in v1 like every unknown bit (spec Open question 14c). */
export const FLAG_COMPRESSED = 1 << 1;
const SUPPORTED_FLAGS = FLAG_BINARY;

const MAX_U32 = 0xffff_ffff;

export interface Frame {
  readonly kind: Kind;
  readonly flags: number;
  readonly callId: number;
  readonly payload: Uint8Array;
}

/** A frame-level protocol violation. Always fatal for the connection. */
export class FrameError extends Error {
  constructor(
    readonly reason: "version" | "kind" | "flags" | "too-large",
    message: string,
  ) {
    super(message);
    this.name = "FrameError";
  }
}

function isKind(value: number): value is Kind {
  return value >= Kind.Hello && value <= Kind.Goaway;
}

/** Encodes one frame, refusing payloads larger than `maxPayload`. */
export function encodeFrame(frame: Frame, maxPayload = DEFAULT_MAX_FRAME_BYTES): Uint8Array {
  const { kind, flags, callId, payload } = frame;
  if (!isKind(kind)) throw new FrameError("kind", `unknown frame kind ${kind}`);
  if ((flags & ~SUPPORTED_FLAGS) !== 0) {
    throw new FrameError("flags", `unsupported frame flags ${flags}`);
  }
  if (!Number.isInteger(callId) || callId < 0 || callId > MAX_U32) {
    throw new RangeError("call id must be a u32");
  }
  if (payload.byteLength > maxPayload) {
    throw new FrameError(
      "too-large",
      `frame payload of ${payload.byteLength} bytes exceeds the ${maxPayload}-byte limit`,
    );
  }
  const out = new Uint8Array(HEADER_LEN + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, PROTOCOL_VERSION);
  view.setUint8(1, kind);
  view.setUint16(2, flags, true);
  view.setUint32(4, callId, true);
  view.setUint32(8, payload.byteLength, true);
  out.set(payload, HEADER_LEN);
  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** A JSON control frame. */
export function jsonFrame(kind: Kind, callId: number, message: unknown): Frame {
  const payload =
    message === undefined ? new Uint8Array(0) : encoder.encode(JSON.stringify(message));
  return { kind, flags: 0, callId, payload };
}

/** Parses a JSON payload. Throws on invalid UTF-8 or JSON. */
export function parseJson(payload: Uint8Array): unknown {
  return JSON.parse(decoder.decode(payload));
}

/**
 * Incremental decoder. Keeps a read offset into its buffer and compacts only when the consumed
 * prefix passes half the buffer, so a chunk of many coalesced frames decodes in linear time.
 */
export class FrameDecoder {
  #buf = new Uint8Array(0);
  #start = 0;
  #end = 0;

  constructor(public maxPayload = DEFAULT_MAX_FRAME_BYTES) {}

  /** Bytes buffered and not yet returned as frames. */
  get buffered(): number {
    return this.#end - this.#start;
  }

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    const needed = this.#end + bytes.byteLength;
    if (needed > this.#buf.byteLength) {
      const live = this.#end - this.#start;
      if (this.#start > 0 && live + bytes.byteLength <= this.#buf.byteLength) {
        this.#buf.copyWithin(0, this.#start, this.#end);
      } else {
        const grown = new Uint8Array(Math.max(live + bytes.byteLength, this.#buf.byteLength * 2));
        grown.set(this.#buf.subarray(this.#start, this.#end));
        this.#buf = grown;
      }
      this.#end = live;
      this.#start = 0;
    }
    this.#buf.set(bytes, this.#end);
    this.#end += bytes.byteLength;
  }

  /** The next whole frame, `undefined` if more bytes are needed. Throws `FrameError`. */
  next(): Frame | undefined {
    if (this.#end - this.#start < HEADER_LEN) return undefined;
    const view = new DataView(this.#buf.buffer, this.#buf.byteOffset + this.#start, HEADER_LEN);
    const version = view.getUint8(0);
    if (version !== PROTOCOL_VERSION) {
      throw new FrameError("version", `unsupported protocol version ${version}`);
    }
    const kind = view.getUint8(1);
    if (!isKind(kind)) throw new FrameError("kind", `unknown frame kind ${kind}`);
    const flags = view.getUint16(2, true);
    if ((flags & ~SUPPORTED_FLAGS) !== 0) {
      throw new FrameError("flags", `unsupported frame flags ${flags}`);
    }
    const callId = view.getUint32(4, true);
    const len = view.getUint32(8, true);
    if (len > this.maxPayload) {
      throw new FrameError(
        "too-large",
        `frame payload of ${len} bytes exceeds the ${this.maxPayload}-byte limit`,
      );
    }
    if (this.#end - this.#start < HEADER_LEN + len) return undefined;
    const from = this.#start + HEADER_LEN;
    // Copy out, so the frame stays valid after the buffer is compacted or reused.
    const payload = this.#buf.slice(from, from + len);
    this.#start = from + len;
    if (this.#start === this.#end) {
      this.#start = this.#end = 0;
    } else if (this.#start > this.#buf.byteLength / 2) {
      this.#buf.copyWithin(0, this.#start, this.#end);
      this.#end -= this.#start;
      this.#start = 0;
    }
    return { kind, flags, callId, payload };
  }
}
