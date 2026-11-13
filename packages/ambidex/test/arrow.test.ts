// The Arrow helper against a scripted server (deterministic): decoding through the in-thread
// decoder and through a worker thread, pacing, errors and cancellation. The same helper against
// the Rust engine's `ArrowSink` is in `integration.test.ts`.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  Dictionary,
  Field,
  Float64,
  Int32,
  Int64,
  List,
  Struct,
  Table,
  Utf8,
  tableToIPC,
  vectorFromArray,
} from "apache-arrow";

import { type ArrowBatch, arrowIsValid, arrowTransferables, decodeArrow } from "../src/arrow.js";
import { inThreadArrowDecoder } from "../src/arrow-decoder.js";
import { Kind, type RpcError, createClient } from "../src/index.js";
import * as api from "./conformance/api.js";
import { cell, rowsOf, startArrowWorker } from "./support/arrow.js";
import { type MockPeer, MockTransport, tick } from "./support/mock-server.js";

async function setup() {
  const transport = new MockTransport();
  const client = createClient(api, transport);
  const stream = client.fixture.arrow_rows({ rows: 0, batch_rows: 1 });
  const peer = await transport.peer();
  const call = await peer.nextOf(Kind.Call);
  return { client, stream, peer, id: call.callId };
}

/** Splits `bytes` into pieces of at most `size` bytes: chunk boundaries anywhere. */
function pieces(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += size) out.push(bytes.slice(at, at + size));
  return out;
}

function send(peer: MockPeer, id: number, chunks: Uint8Array[], summary: unknown): void {
  for (const chunk of chunks) peer.binary(Kind.Chunk, id, chunk);
  peer.json(Kind.StreamEnd, id, summary);
}

function sampleTable(rows: number): Table {
  const ids = Array.from({ length: rows }, (_, i) => i);
  return new Table({
    id: vectorFromArray(ids.map(BigInt), new Int64()),
    n: vectorFromArray(
      ids.map((i) => (i % 3 === 0 ? null : i - 5)),
      new Int32(),
    ),
    s: vectorFromArray(
      ids.map((i) => `value-${i}`),
      new Utf8(),
    ),
  });
}

const worker = startArrowWorker();
after(() => worker.stop());

for (const [name, port] of [
  ["a worker thread", () => worker.port],
  ["the calling thread", () => inThreadArrowDecoder()],
] as const) {
  describe(`decodeArrow in ${name}`, () => {
    it("yields the schema and the record batches as plain buffers", async () => {
      const { stream, peer, id } = await setup();
      const table = sampleTable(10);
      send(peer, id, pieces(tableToIPC(table, "stream"), 64), { rows: 10 });
      const arrow = decodeArrow(stream, port());
      const fields = await arrow.schema;
      assert.deepEqual(
        fields.map((f) => [f.name, f.type, f.nullable]),
        [
          ["id", "Int64", true],
          ["n", "Int32", true],
          ["s", "Utf8", true],
        ],
      );
      const rows: unknown[][] = [];
      for await (const batch of arrow.batches()) {
        assert.equal(batch.columns.length, 3);
        assert.ok(batch.columns[0]?.values instanceof BigInt64Array);
        assert.ok(batch.columns[1]?.values instanceof Int32Array);
        assert.ok(batch.columns[2]?.offsets instanceof Int32Array);
        // One buffer holds the whole batch, ready to be transferred on.
        assert.equal(arrowTransferables(batch).length, 1);
        rows.push(...rowsOf(batch));
      }
      assert.deepEqual(
        rows,
        Array.from({ length: 10 }, (_, i) => [BigInt(i), i % 3 === 0 ? null : i - 5, `value-${i}`]),
      );
      assert.deepEqual(await arrow.result, { rows: 10 });
    });

    it("resolves the schema of a result without rows", async () => {
      const { stream, peer, id } = await setup();
      send(peer, id, [tableToIPC(sampleTable(0), "stream")], { rows: 0 });
      const arrow = decodeArrow(stream, port());
      assert.equal((await arrow.schema).length, 3);
      const batches: ArrowBatch[] = [];
      for await (const batch of arrow.batches()) batches.push(batch);
      assert.equal(
        batches.reduce((n, b) => n + b.numRows, 0),
        0,
      );
      assert.deepEqual(await arrow.result, { rows: 0 });
    });

    it("describes nested and dictionary-encoded columns", async () => {
      const { stream, peer, id } = await setup();
      const table = new Table({
        tag: vectorFromArray(["a", "b", "a", null], new Dictionary(new Utf8(), new Int32())),
        point: vectorFromArray(
          [{ x: 1 }, { x: 2 }, null, { x: 4 }],
          new Struct([new Field("x", new Float64())]),
        ),
        list: vectorFromArray([[1, 2], [], null, [3]], new List(new Field("item", new Int32()))),
      });
      send(peer, id, [tableToIPC(table, "stream")], { rows: 4 });
      const arrow = decodeArrow(stream, port());
      const fields = await arrow.schema;
      assert.deepEqual(
        fields.map((f) => f.children.map((c) => c.name)),
        [[], ["x"], ["item"]],
      );
      const batches: ArrowBatch[] = [];
      for await (const batch of arrow.batches()) batches.push(batch);
      assert.equal(batches.length, 1);
      const [tag, point, list] = (batches[0] as ArrowBatch).columns;
      assert.ok(tag !== undefined && point !== undefined && list !== undefined);
      // Dictionary: indices into the dictionary's values; a null index is a null element.
      assert.deepEqual([...(tag.values as Int32Array)].slice(0, 3), [0, 1, 0]);
      assert.equal(arrowIsValid(tag, 3), false);
      assert.deepEqual(
        [0, 1].map((i) => cell((tag.dictionary ?? [])[0] as never, i)),
        ["a", "b"],
      );
      // Struct: one child per field, same length; its own validity.
      assert.equal(arrowIsValid(point, 2), false);
      assert.deepEqual([...((point.children[0]?.values ?? []) as Float64Array)].slice(0, 2), [1, 2]);
      // List: offsets into its child.
      // Buffers keep the padding of the IPC message: read `length + 1` offsets.
      assert.deepEqual([...(list.offsets as Int32Array)].slice(0, list.length + 1), [0, 2, 2, 2, 3]);
      assert.equal(list.children[0]?.length, 3);
      assert.deepEqual([...((list.children[0]?.values ?? []) as Int32Array)].slice(0, 3), [1, 2, 3]);
      assert.equal(arrowIsValid(list, 2), false);
    });

    it("takes the next chunk only when the consumer comes back for a batch", async () => {
      const { stream, peer, id } = await setup();
      // Whole IPC messages per chunk, as `ArrowSink` sends them: schema, three batches, end.
      const one = sampleTable(4).batches;
      const bytes = tableToIPC(new Table([...one, ...one, ...one]), "stream");
      const chunks = messages(bytes);
      assert.equal(chunks.length, 5);
      for (const chunk of chunks.slice(0, 4)) peer.binary(Kind.Chunk, id, chunk);
      const credits = () => peer.unread().filter((f) => f.kind === Kind.Credit).length;
      const arrow = decodeArrow(stream, port());
      await arrow.schema;
      await tick(30);
      // Only the schema chunk was taken: nobody asked for a batch yet.
      assert.equal(credits(), 0);
      const it = arrow.batches()[Symbol.asyncIterator]();
      assert.equal((await it.next()).value?.numRows, 4);
      await tick(30);
      // Asking for the first batch took its chunk, which paid for the schema chunk; holding
      // the batch takes nothing more.
      assert.equal(credits(), 1);
      assert.equal((await it.next()).value?.numRows, 4);
      await tick(30);
      assert.equal(credits(), 2);
      assert.equal((await it.next()).value?.numRows, 4);
      send(peer, id, chunks.slice(4), { rows: 12 });
      assert.equal((await it.next()).done, true);
      assert.deepEqual(await arrow.result, { rows: 12 });
    });

    it("fails with a local Internal error and cancels when the chunks are not Arrow", async () => {
      const { stream, peer, id } = await setup();
      // An IPC message header announcing 16 bytes of metadata that are not a flatbuffer.
      const garbage = new Uint8Array(24).fill(0xff);
      new DataView(garbage.buffer).setInt32(4, 16, true);
      peer.binary(Kind.Chunk, id, garbage);
      const arrow = decodeArrow(stream, port());
      await assert.rejects(arrow.schema, (e: RpcError) => e.code === "Internal" && e.local);
      await assert.rejects(
        arrow.batches()[Symbol.asyncIterator]().next(),
        (e: RpcError) => e.code === "Internal" && e.message === "Arrow decoding failed",
      );
      assert.equal((await peer.nextOf(Kind.Cancel)).callId, id);
      await assert.rejects(arrow.result, (e: RpcError) => e.code === "Cancelled");
    });

    it("fails when the stream ends without an Arrow schema", async () => {
      const { stream, peer, id } = await setup();
      send(peer, id, [], { rows: 0 });
      const arrow = decodeArrow(stream, port());
      await assert.rejects(arrow.schema, (e: RpcError) => e.code === "Internal" && e.local);
      // The call itself succeeded.
      assert.deepEqual(await arrow.result, { rows: 0 });
    });

    it("delivers decoded batches before the server's error", async () => {
      const { stream, peer, id } = await setup();
      const chunks = messages(tableToIPC(sampleTable(4), "stream"));
      for (const chunk of chunks.slice(0, 2)) peer.binary(Kind.Chunk, id, chunk);
      const arrow = decodeArrow(stream, port());
      const it = arrow.batches()[Symbol.asyncIterator]();
      assert.equal((await it.next()).value?.numRows, 4);
      peer.error(id, "Unavailable");
      await assert.rejects(it.next(), (e: RpcError) => e.code === "Unavailable" && !e.local);
      await assert.rejects(arrow.result, (e: RpcError) => e.code === "Unavailable");
    });

    it("leaving batches() early cancels the stream", async () => {
      const { stream, peer, id } = await setup();
      const chunks = messages(tableToIPC(sampleTable(4), "stream"));
      for (const chunk of chunks.slice(0, 2)) peer.binary(Kind.Chunk, id, chunk);
      const arrow = decodeArrow(stream, port());
      for await (const batch of arrow.batches()) {
        assert.equal(batch.numRows, 4);
        break;
      }
      assert.equal((await peer.nextOf(Kind.Cancel)).callId, id);
      await assert.rejects(arrow.result, (e: RpcError) => e.code === "Cancelled" && e.local);
    });

    it("cancel() before the schema rejects it with Cancelled", async () => {
      const { stream, peer, id } = await setup();
      const arrow = decodeArrow(stream, port());
      arrow.cancel();
      assert.equal((await peer.nextOf(Kind.Cancel)).callId, id);
      await assert.rejects(arrow.schema, (e: RpcError) => e.code === "Cancelled");
      await assert.rejects(arrow.result, (e: RpcError) => e.code === "Cancelled");
    });
  });
}

describe("decodeArrow with a decoder that fails", () => {
  it("fails the stream when the Worker reports an error", async () => {
    const { stream, peer, id } = await setup();
    const listeners = new Map<string, (event: { data?: unknown }) => void>();
    const arrow = decodeArrow(stream, {
      postMessage: () => {},
      addEventListener: (type, listener) => void listeners.set(type, listener),
      removeEventListener: (type) => void listeners.delete(type),
    });
    peer.binary(Kind.Chunk, id, new Uint8Array(8));
    await tick(10);
    // What a Worker whose script failed to load (no apache-arrow) emits.
    listeners.get("error")?.({});
    await assert.rejects(arrow.schema, (e: RpcError) => e.code === "Internal" && e.local);
    assert.equal((await peer.nextOf(Kind.Cancel)).callId, id);
    assert.equal(listeners.size, 0, "listeners removed");
  });
});

/** Splits an Arrow IPC stream into its messages (continuation marker, length, metadata, body). */
function messages(bytes: Uint8Array): Uint8Array[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.byteLength) {
    assert.equal(view.getUint32(at, true), 0xffff_ffff);
    const metadata = view.getInt32(at + 4, true);
    let end = at + 8 + metadata;
    if (metadata > 0) end += bodyLength(bytes.subarray(at + 8, at + 8 + metadata));
    out.push(bytes.slice(at, end));
    at = end;
  }
  return out;
}

/** `Message.bodyLength` (field 3) of a flatbuffer-encoded IPC message. */
function bodyLength(metadata: Uint8Array): number {
  const view = new DataView(metadata.buffer, metadata.byteOffset, metadata.byteLength);
  const table = view.getUint32(0, true);
  const vtable = table - view.getInt32(table, true);
  const slot = 4 + 3 * 2;
  if (slot >= view.getUint16(vtable, true)) return 0;
  const field = view.getUint16(vtable + slot, true);
  return field === 0 ? 0 : Number(view.getBigInt64(table + field, true));
}
