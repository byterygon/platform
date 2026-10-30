import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { schema, document, CONTRACT } from "./generated.mjs";
import {
  encodeTyped,
  decodeTyped,
  AmbidexDecimal,
  AmbidexTemporal,
} from "./semantic.mjs";
import { hex, encode, jsonBytes, parseJSON } from "./codec.mjs";
import { descriptor } from "./descriptor.mjs";
const executable = new URL(
  "../rust/target/debug/ambidex-cbor-spike",
  import.meta.url,
).pathname;
function rust(cases) {
  const r = spawnSync(executable, [], {
    input: cases.map((v) => JSON.stringify(v)).join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").map(JSON.parse);
}
const input = {
  id: 18446744073709551615n,
  amount: "1.2300",
  at: "2026-10-29T19:34:56.123456789+07:00",
  date: "2026-02-28",
  local: "2026-10-29T12:34:56.123456789",
  secret: "hidden",
};
test("Rust-derived descriptors hydrate exact wrappers and both Rust wire paths", () => {
  assert.match(CONTRACT, /^sha256:/);
  const payload = new TextDecoder().decode(encodeTyped(input, schema, "json")),
    bytes = encodeTyped(input, schema, "cbor");
  const [a, b] = rust([
    { jsonPayload: payload, schema: document },
    { hex: hex(bytes), schema: document },
  ]);
  assert.equal(a.ok, true, JSON.stringify(a));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal(a.hex, b.hex);
  assert.equal(a.digest, b.digest);
  assert.deepEqual(a.json, b.json);
  const typed = decodeTyped(bytes, schema, "cbor");
  assert.ok(typed.amount instanceof AmbidexDecimal);
  assert.ok(typed.at instanceof AmbidexTemporal);
  assert.equal(typed.amount.toString(), "1.2300");
  assert.equal(typed.at.toString(), "2026-10-29T12:34:56.123456789Z");
  assert.equal(hex(encodeTyped(typed, schema, "cbor")), a.hex);
});
test("semantic differential corpus, not just syntax acceptance", () => {
  let seed = 97;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const cases = [];
  for (let i = 0; i < 500; i++) {
    const values = [
      ["i64", (BigInt(rnd()) << 32n) + BigInt(rnd()) - (1n << 63n)],
      ["u64", (BigInt(rnd()) << 32n) + BigInt(rnd())],
      ["decimal", `${rnd()}.${String(rnd()).padStart(10, "0")}`],
      [
        "instant",
        `2026-10-29T12:34:56.${String(rnd() % 1000000000).padStart(9, "0")}Z`,
      ],
    ];
    for (const [s, v] of values) {
      const text = new TextDecoder().decode(encodeTyped(v, s, "json"));
      cases.push({ jsonPayload: text, schema: s });
      cases.push({ hex: hex(encodeTyped(v, s, "cbor")), schema: s });
    }
  }
  const negative = [
    ["i64", '"9223372036854775808"'],
    ["u64", '"-1"'],
    ["decimal", '"1e1001"'],
    ["date", '"2026-02-29"'],
    ["instant", '"2026-10-29T12:34:56.1234567891Z"'],
    ["instant", '"2026-10-29T23:59:60Z"'],
  ];
  for (const [s, text] of negative)
    cases.push({ jsonPayload: text, schema: s });
  const results = rust(cases);
  const failures = [];
  for (let i = 0; i < cases.length; i++) {
    let ok = true,
      bytes;
    const c = cases[i];
    try {
      const inputBytes =
        c.jsonPayload !== undefined
          ? new TextEncoder().encode(c.jsonPayload)
          : Uint8Array.from(Buffer.from(c.hex, "hex"));
      const typed = decodeTyped(
        inputBytes,
        c.schema,
        c.jsonPayload !== undefined ? "json" : "cbor",
      );
      bytes = hex(encodeTyped(typed, c.schema, "cbor"));
    } catch {
      ok = false;
    }
    if (
      results[i].ok !== ok ||
      results[i].panic ||
      (ok && results[i].hex !== bytes)
    )
      failures.push({ case: c, rust: results[i], js: ok, bytes });
  }
  writeFileSync(
    new URL("../results/semantic-fuzz.json", import.meta.url),
    JSON.stringify({ seed: 97, executions: cases.length, failures }, null, 2) +
      "\n",
  );
  assert.deepEqual(failures, []);
});
test("JSON scanner equivalence for malformed Unicode, duplicates, flatten and untagged", () => {
  const texts = [
    '{"a":1,"\\u0061":2}',
    '{"x":{"a":1,"a":2}}',
    '"\\ud800"',
    "[1]true",
    "9007199254740993",
    '"hello"',
  ];
  const results = rust(
    texts.map((jsonPayload) => ({ jsonPayload, schema: "dynamic" })),
  );
  for (let i = 0; i < texts.length; i++) {
    let ok = true;
    try {
      decodeTyped(new TextEncoder().encode(texts[i]), "dynamic", "json");
    } catch {
      ok = false;
    }
    assert.equal(results[i].ok, ok, texts[i]);
  }
});
test("recursive, flattened, optional and enum descriptors preserve serde semantics across codecs", () => {
  const models = JSON.parse(
    readFileSync(new URL("../results/fingerprints.json", import.meta.url)),
  ).examples;
  const inputs = {
    recursive: { value: 1n, next: { value: 2n, next: null } },
    flatten: { id: 3n, x: "extra" },
    optional: { nullable: null },
    untagged: { value: 18446744073709551615n },
    tagged: { kind: "number", payload: 18446744073709551615n },
  };
  for (const [name, value] of Object.entries(inputs)) {
    const s = descriptor(models[name]);
    for (const codec of ["json", "cbor"]) {
      const b = encodeTyped(value, s, codec),
        request =
          codec === "json"
            ? { jsonPayload: new TextDecoder().decode(b), schema: models[name] }
            : { hex: hex(b), schema: models[name] };
      const [r] = rust([request]);
      assert.equal(r.ok, true, name + JSON.stringify(r));
      assert.equal(
        r.hex,
        hex(encodeTyped(decodeTyped(b, s, codec), s, "cbor")),
        name,
      );
    }
  }
});
test("edited Arrow-aligned values retain scale, nanoseconds and timezone absence", async () => {
  const { toArrow, fromArrow } = await import("./arrow.mjs");
  for (const [k, v] of [
    ["decimal", "1.2300"],
    ["decimal", "-123e4"],
    ["instant", "2026-10-29T12:34:56.123456789Z"],
    ["local", "2026-10-29T12:34:56.123456789"],
    ["local", "1960-01-01T00:00:00.123456789"],
    ["date", "2026-02-28"],
    ["time", "12:34:56.123456789"],
  ]) {
    const a = toArrow(v, k);
    assert.equal(fromArrow(a), v);
    if (k === "local") assert.equal(a.timezone, null);
  }
});
test("checked mapping keeps safe fields numeric and full-range fields exact", () => {
  const doc = JSON.parse(
    readFileSync(new URL("../results/fingerprints.json", import.meta.url)),
  ).mappingExample;
  const s = descriptor(doc);
  const value = {
    safe: 9007199254740991,
    full_signed: -9223372036854775808n,
    full_unsigned: 18446744073709551615n,
  };
  for (const codec of ["json", "cbor"]) {
    const bytes = encodeTyped(value, s, codec);
    const decoded = decodeTyped(bytes, s, codec, "checked");
    assert.equal(typeof decoded.safe, "number");
    assert.equal(typeof decoded.full_signed, "bigint");
    assert.equal(typeof decoded.full_unsigned, "bigint");
  }
  assert.throws(() =>
    encodeTyped({ ...value, safe: 9007199254740992n }, s, "json"),
  );
});
test("scale-insignificant Decimal canonicalizes but scale-significant fields remain distinct", () => {
  const s = {
    type: "decimal",
    scaleSignificant: false,
    precision: "38",
    maxAbsScale: "1000",
  };
  assert.equal(
    hex(encodeTyped("1.2300", s, "cbor")),
    hex(encodeTyped("1.23", s, "cbor")),
  );
  const [a, b] = rust([
    { jsonPayload: '"1.2300"', schema: s },
    { jsonPayload: '"1.23"', schema: s },
  ]);
  assert.equal(a.ok, true);
  assert.equal(a.hex, b.hex);
});
test("malformed nested structs, flatten and untagged reject duplicates before serde/JS hydration", () => {
  const docs = JSON.parse(
    readFileSync(new URL("../results/fingerprints.json", import.meta.url)),
  ).examples;
  const cases = [
    ["recursive", '{"value":"1","next":{"value":"2","value":"3","next":null}}'],
    ["flatten", '{"id":"1","x":"a","x":"b"}'],
    ["untagged", '{"value":"1","value":"2"}'],
  ];
  for (const [name, text] of cases) {
    const s = descriptor(docs[name]);
    assert.throws(() => decodeTyped(new TextEncoder().encode(text), s, "json"));
    const [r] = rust([{ jsonPayload: text, schema: docs[name] }]);
    assert.equal(r.ok, false);
  }
});
test("finite fractional JSON is syntax-valid but rejected by the conservative dynamic integer domain", () => {
  const text = '{"k8":[20553.3298,"1175291595",true]}';
  assert.doesNotThrow(() => parseJSON(new TextEncoder().encode(text)));
  assert.throws(() =>
    decodeTyped(new TextEncoder().encode(text), "dynamic", "json"),
  );
  const [r] = rust([{ jsonPayload: text, schema: "dynamic" }]);
  assert.equal(r.ok, false);
});
test("explicit byte scalar uses canonical base64 JSON and a CBOR byte string", () => {
  const bytes = Uint8Array.of(0, 1, 254, 255);
  for (const codec of ["json", "cbor"]) {
    const payload = encodeTyped(bytes, "bytes", codec);
    assert.deepEqual(decodeTyped(payload, "bytes", codec), bytes);
    const [r] = rust([
      codec === "json"
        ? { jsonPayload: new TextDecoder().decode(payload), schema: "bytes" }
        : { hex: hex(payload), schema: "bytes" },
    ]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.hex, hex(encodeTyped(bytes, "bytes", "cbor")));
  }
  assert.throws(() =>
    decodeTyped(new TextEncoder().encode('"AA"'), "bytes", "json"),
  );
});
test("absent, explicit null and undefined keep separate contract behavior", () => {
  const doc = JSON.parse(
      readFileSync(new URL("../results/fingerprints.json", import.meta.url)),
    ).examples.optional,
    s = descriptor(doc);
  assert.doesNotThrow(() => encodeTyped({ nullable: null }, s, "json"));
  assert.doesNotThrow(() => encodeTyped({}, s, "json"));
  assert.throws(() => encodeTyped({ count: null }, s, "json"));
  assert.throws(() => encodeTyped({ nullable: undefined }, s, "json"));
  assert.notEqual(
    hex(encodeTyped({}, s, "cbor")),
    hex(encodeTyped({ nullable: null }, s, "cbor")),
  );
});
test("integral JSON numeric spellings normalize consistently in the conservative dynamic domain", () => {
  for (const text of ["1.0", "1e0", "-0.0", "9007199254740991.0"]) {
    const js = decodeTyped(new TextEncoder().encode(text), "dynamic", "json");
    const [r] = rust([{ jsonPayload: text, schema: "dynamic" }]);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.hex, hex(encodeTyped(js, "dynamic", "cbor")));
  }
});
