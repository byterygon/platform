import { test } from "node:test";
import assert from "node:assert/strict";
import { Peer, relay, forwardArrow, mutate } from "./relay.mjs";
import { ApprovalStore, dispatch, digest, negotiate } from "./router.mjs";
import { schema } from "./generated.mjs";
import { encodeTyped } from "./semantic.mjs";
const session = {
  principal: "human:alice",
  context: "session:1",
  target: "db:1",
};
const value = {
  id: 18446744073709551615n,
  amount: "1.2300",
  at: "2026-10-29T12:34:56.123456789Z",
  date: "2026-02-28",
  local: "2026-10-29T12:34:56.123456789",
  secret: "secret",
};
test("separately negotiated relay transcodes with stable approval digest and preserves opaque Arrow frames", () => {
  const left = new Peer(
      { codecs: ["json-lossless-v2"] },
      { codecs: ["json-lossless-v2"] },
      session,
    ),
    right = new Peer({ codecs: ["cbor-v1"] }, { codecs: ["cbor-v1"] }, session);
  const out = relay(left, right, left.encode(value, schema), schema);
  assert.equal(
    out.inputDigest,
    digest(right.receive(out.bytes, schema), schema),
  );
  assert.equal(
    relay(right, left, out.bytes, schema).inputDigest,
    out.inputDigest,
  );
  const arrow = {
    kind: "Chunk",
    callId: 7,
    flags: 1,
    payload: Uint8Array.of(255, 255, 255, 255, 8, 0, 0, 0, 65, 82, 82, 79, 87),
  };
  const forwarded = forwardArrow(arrow);
  assert.deepEqual(forwarded, arrow);
  assert.notEqual(forwarded.payload, arrow.payload);
  assert.throws(() => right.renegotiate());
  assert.throws(() =>
    relay(
      left,
      new Peer(
        { codecs: ["cbor-v1"] },
        { codecs: ["cbor-v1"] },
        { ...session, principal: "human:bob" },
      ),
      left.encode(value, schema),
      schema,
    ),
  );
});
test("mutation commits once, malformed result reports outcome unknown without replay", () => {
  const peer = new Peer(
    { codecs: ["cbor-v1"] },
    { codecs: ["cbor-v1"] },
    session,
  );
  const result = mutate(peer, value, schema, { corruptReply: true });
  assert.equal(peer.executions, 1);
  assert.equal(result.error.retryable, false);
  assert.match(result.error.message, /outcome unknown/);
});
test("approval scope is codec-independent, versioned and policy-bound", async () => {
  const approvals = new ApprovalStore();
  let binding;
  const base = {
    schema,
    session,
    access: async () => true,
    authorize: async (b) => {
      binding = b;
      return true;
    },
    handler: async (x) => x.id,
    contract: "c1",
    policy: "p1",
  };
  await dispatch({
    ...base,
    codec: "json",
    bytes: encodeTyped(value, schema, "json"),
  });
  const id = approvals.issue(binding);
  assert.equal(approvals.accepts(id, binding), true);
  const b = await dispatch({
    ...base,
    codec: "cbor",
    bytes: encodeTyped(value, schema, "cbor"),
    authorize: async (b) => approvals.accepts(id, b),
  });
  assert.equal(b.error, undefined);
  for (const key of [
    "version",
    "contract",
    "policy",
    "procedure",
    "principal",
    "target",
    "context",
    "inputDigest",
  ])
    assert.equal(
      approvals.accepts(id, {
        ...binding,
        [key]: key === "version" ? 1 : "changed",
      }),
      false,
      key,
    );
});
test("no silent required-profile downgrade or auth/protocol fallback", () => {
  for (const codecs of [["cbor-v1"], ["json-lossless-v2"]])
    assert.throws(() => negotiate({ codecs, losslessRequired: true }, {}));
  assert.throws(() => new Peer({}, {}, null));
});
test("new/old peers use explicit safe-only legacy adapter; unsafe mutations are rejected before send", () => {
  const legacy = new Peer(
      { codecs: ["cbor-v1", "json-lossless-v2", "json-v1"] },
      {},
      session,
    ),
    modern = new Peer(
      { codecs: ["cbor-v1"] },
      { codecs: ["cbor-v1"] },
      session,
    );
  assert.equal(legacy.agreement.codec, "json-v1");
  assert.equal(legacy.ack.capabilities, undefined);
  assert.throws(() => legacy.encode(value, schema));
  assert.equal(legacy.executions, 0);
  const safe = { ...value, id: 42n };
  const encoded = legacy.encode(safe, schema);
  assert.equal(JSON.parse(new TextDecoder().decode(encoded)).id, 42);
  const result = relay(legacy, modern, encoded, schema);
  assert.equal(modern.receive(result.bytes, schema).id, 42n);
  assert.throws(
    () =>
      new Peer(
        { codecs: ["future-codec"] },
        { codecs: ["future-codec"] },
        session,
      ),
  );
  assert.throws(
    () =>
      new Peer(
        { codecs: ["cbor-v1"], contract: "a" },
        { codecs: ["cbor-v1"], contract: "b" },
        session,
      ),
  );
});
