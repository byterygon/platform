// Frame codec: byte layout identical to `crates/ambidex/src/frame.rs`, incremental decoding and
// the same validation (version, kind, flags, size before buffering).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FLAG_BINARY,
  FrameDecoder,
  FrameError,
  HEADER_LEN,
  Kind,
  encodeFrame,
} from "../src/index.js";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("frame codec", () => {
  it("encodes the 12-byte little-endian header like the Rust codec", () => {
    // Same vector as frame.rs `header_layout_is_little_endian`.
    const encoded = encodeFrame({
      kind: Kind.Call,
      flags: 0,
      callId: 0x0403_0201,
      payload: new TextEncoder().encode("{}"),
    });
    assert.deepEqual([...encoded], [1, 3, 0, 0, 0x01, 0x02, 0x03, 0x04, 2, 0, 0, 0, 0x7b, 0x7d]);
    const binary = encodeFrame({
      kind: Kind.Chunk,
      flags: FLAG_BINARY,
      callId: 7,
      payload: bytes(9),
    });
    assert.deepEqual([...binary.subarray(0, 4)], [1, 7, 1, 0]);
    assert.equal(HEADER_LEN, 12);
  });

  it("numbers kinds Hello=1 .. Goaway=15 in spec order", () => {
    assert.deepEqual(
      Object.values(Kind),
      [...Array(15).keys()].map((i) => i + 1),
    );
    assert.equal(Kind.Subscribe, 10);
    assert.equal(Kind.Goaway, 15);
  });

  it("round-trips frames split and coalesced across chunks", () => {
    const frames = [
      { kind: Kind.Result, flags: 0, callId: 1, payload: new TextEncoder().encode('{"a":1}') },
      { kind: Kind.Chunk, flags: FLAG_BINARY, callId: 2, payload: bytes(0, 255, 1) },
      { kind: Kind.Pong, flags: 0, callId: 0, payload: bytes() },
    ];
    const wire = Buffer.concat(frames.map((f) => encodeFrame(f)));
    for (const step of [1, 5, 12, 13, wire.length]) {
      const decoder = new FrameDecoder();
      const out = [];
      for (let at = 0; at < wire.length; at += step) {
        decoder.push(wire.subarray(at, at + step));
        for (let f = decoder.next(); f !== undefined; f = decoder.next()) out.push(f);
      }
      assert.deepEqual(
        out.map((f) => ({ ...f, payload: [...f.payload] })),
        frames.map((f) => ({ ...f, payload: [...f.payload] })),
        `step ${step}`,
      );
      assert.equal(decoder.buffered, 0);
    }
  });

  it("frames stay valid after the decoder reuses its buffer", () => {
    const decoder = new FrameDecoder();
    decoder.push(encodeFrame({ kind: Kind.Event, flags: 0, callId: 1, payload: bytes(1, 2) }));
    const first = decoder.next();
    decoder.push(encodeFrame({ kind: Kind.Event, flags: 0, callId: 2, payload: bytes(3, 4) }));
    decoder.next();
    assert.deepEqual([...(first?.payload ?? [])], [1, 2]);
  });

  it("rejects a bad version, kind 0, an unknown kind and reserved flags", () => {
    const header = (b: number[]) => {
      const d = new FrameDecoder();
      d.push(bytes(...b));
      return () => d.next();
    };
    assert.throws(
      header([2, 4, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      (e: FrameError) => e.reason === "version",
    );
    assert.throws(
      header([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      (e: FrameError) => e.reason === "kind",
    );
    assert.throws(
      header([1, 16, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      (e: FrameError) => e.reason === "kind",
    );
    // Compressed (bit 1) is reserved in v1 and rejected like unknown bits.
    assert.throws(
      header([1, 4, 2, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
      (e: FrameError) => e.reason === "flags",
    );
    assert.throws(
      header([1, 4, 0, 0x80, 1, 0, 0, 0, 0, 0, 0, 0]),
      (e: FrameError) => e.reason === "flags",
    );
  });

  it("rejects an oversize payload from the header alone", () => {
    const d = new FrameDecoder(1024);
    // Header announces 1025 bytes; no payload follows.
    d.push(bytes(1, 4, 0, 0, 1, 0, 0, 0, 0x01, 0x04, 0, 0));
    assert.throws(
      () => d.next(),
      (e: FrameError) => e.reason === "too-large",
    );
    assert.throws(
      () => encodeFrame({ kind: Kind.Call, flags: 0, callId: 1, payload: new Uint8Array(11) }, 10),
      (e: FrameError) => e.reason === "too-large",
    );
  });

  it("refuses call ids outside u32 and unknown kinds when encoding", () => {
    assert.throws(
      () => encodeFrame({ kind: Kind.Call, flags: 0, callId: 2 ** 32, payload: bytes() }),
      RangeError,
    );
    assert.throws(
      () => encodeFrame({ kind: Kind.Call, flags: 0, callId: -1, payload: bytes() }),
      RangeError,
    );
    assert.throws(
      () => encodeFrame({ kind: 99 as Kind, flags: 0, callId: 1, payload: bytes() }),
      FrameError,
    );
  });

  it("decodes 100k coalesced frames in linear time", () => {
    const one = encodeFrame({ kind: Kind.Pong, flags: 0, callId: 0, payload: bytes() });
    const n = 100_000;
    const chunk = new Uint8Array(one.length * n);
    for (let i = 0; i < n; i++) chunk.set(one, i * one.length);
    const decoder = new FrameDecoder();
    const started = performance.now();
    decoder.push(chunk);
    let count = 0;
    while (decoder.next() !== undefined) count++;
    assert.equal(count, n);
    // Quadratic copying of a 1.2 MB buffer takes seconds; linear decoding takes milliseconds.
    assert.ok(performance.now() - started < 1500, "decoding is not linear");
  });
});
