import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { encode, decode, parseJSON, jsonBytes, hex } from "./codec.mjs";
const executable = new URL(
  "../rust/target/debug/ambidex-cbor-spike",
  import.meta.url,
).pathname;
function rust(req) {
  const r = spawnSync(executable, [], {
    input: JSON.stringify(req) + "\n",
    encoding: "utf8",
    timeout: 10000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
const rows = [];
function check(label, bytes, expected, { codec = "cbor", budget } = {}) {
  let ok = true;
  const start = performance.now();
  try {
    if (codec === "cbor") decode(bytes, true, budget);
    else parseJSON(bytes);
  } catch {
    ok = false;
  }
  const elapsedMs = performance.now() - start;
  const req =
    codec === "cbor"
      ? { hex: hex(bytes), budget }
      : { jsonPayload: new TextDecoder().decode(bytes), schema: "dynamic" };
  const r = rust(req);
  assert.equal(ok, expected, label + " JS");
  assert.equal(r.ok, expected, label + " Rust " + JSON.stringify(r));
  rows.push({
    label,
    bytes: bytes.length,
    accepted: ok,
    jsElapsedMs: elapsedMs,
    rustAccepted: r.ok,
  });
}
test("all structural thresholds at minus one, exact and plus one in Rust and JS", () => {
  for (const count of [65535, 65536, 65537])
    check("array-" + count, encode(Array(count).fill(null)), count <= 65536);
  for (const count of [4095, 4096, 4097])
    check(
      "map-" + count,
      encode(
        Object.fromEntries(
          Array.from({ length: count }, (_, i) => ["k" + i, null]),
        ),
      ),
      count <= 4096,
    );
  for (const size of [262143, 262144, 262145]) {
    check("field-cbor-" + size, encode("x".repeat(size)), size <= 262144);
    check("field-json-" + size, jsonBytes("x".repeat(size)), size <= 262144, {
      codec: "json",
    });
  }
  for (const depth of [63, 64, 65]) {
    let v = null;
    for (let i = 0; i < depth; i++) v = [v];
    check("depth-" + depth, encodeUnchecked(v), depth <= 64);
    check("json-depth-" + depth, jsonBytes(v), depth <= 64, { codec: "json" });
  }
  for (const count of [99999, 100000, 100001]) {
    const v = [Array(49998).fill(null), Array(count - 3 - 49998).fill(null)];
    check("nodes-" + count, encode(v), count <= 100000);
  }
  for (const budget of [31, 32, 33])
    check("accounted-budget-" + budget, encode(null), budget >= 32, { budget });
  for (const n of [1048575, 1048576, 1048577]) {
    const bytes = new Uint8Array(n).fill(32);
    bytes[0] = 110;
    bytes[1] = 117;
    bytes[2] = 108;
    bytes[3] = 108;
    check("payload-json-" + n, bytes, n <= 1048576, { codec: "json" });
  }
  // The payload cap is checked before materialization, independently of syntax.
  check("payload-cbor-1048577", new Uint8Array(1048577), false);
  writeFileSync(
    new URL("../results/resources.json", import.meta.url),
    JSON.stringify(
      {
        thresholds:
          "RFC PoC thresholds; allocation is parser-accounted, measured heap/RSS is reported separately",
        rows,
      },
      null,
      2,
    ) + "\n",
  );
});
function encodeUnchecked(v) {
  if (Array.isArray(v))
    return Uint8Array.from(Buffer.from("81".repeat(depth(v)) + "f6", "hex"));
  return encode(v);
}
function depth(v) {
  let n = 0;
  while (Array.isArray(v)) {
    n++;
    v = v[0];
  }
  return n;
}
