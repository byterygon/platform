import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";
import { Tag, encode, decode, hex, parseJSON, jsonBytes } from "./codec.mjs";
import { encodeTyped, decodeTyped, decimal, temporal } from "./semantic.mjs";
import {
  digest,
  dispatch,
  negotiate,
  mutationDecodeFailure,
  hash,
} from "./router.mjs";
const rust = new URL(
  "../rust/target/debug/ambidex-cbor-spike",
  import.meta.url,
);
const schema = {
  type: "object",
  fields: {
    id: "u64",
    amount: "decimal",
    at: "instant",
    date: "date",
    local: "local",
    secret: "string",
  },
};
const input = {
  id: 18446744073709551615n,
  amount: "1.2300",
  at: "2026-10-29T12:34:56.123456789Z",
  date: "2026-02-28",
  local: "2026-10-29T12:34:56.123456789",
  secret: "sensitive",
};
const fixtures = [
  ["I01", "u64", 0n, "00"],
  ["I02", "u64", 9007199254740993n, "1b0020000000000001"],
  ["I03", "u64", 18446744073709551615n, "1bffffffffffffffff"],
  ["I04", "i64", 9223372036854775807n, "1b7fffffffffffffff"],
  ["I05", "i64", -9223372036854775808n, "3b7fffffffffffffff"],
  ["D01", "decimal", "1.2300", "c4822319300c"],
  ["D02", "decimal", "12345678901234567890123456789012345678"],
  ["T01", "instant", input.at],
  ["T02", "date", input.date],
  ["N01", schema, input],
];
function compareRust(cases) {
  const r = spawnSync(rust.pathname, [], {
    input: cases.map((x) => JSON.stringify(x)).join("\n") + "\n",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim().split("\n").map(JSON.parse);
}
test("golden vectors, both languages and logical digest", () => {
  const vectors = [];
  for (const [id, s, v, golden] of fixtures) {
    const b = encodeTyped(v, s, "cbor");
    const frozen = JSON.parse(
      readFileSync(new URL("../fixtures/golden.json", import.meta.url)),
    ).find((v) => v.id === id);
    assert.equal(hex(b), golden ?? frozen.cbor);
    const typed = decodeTyped(b, s, "cbor");
    assert.deepEqual(encodeTyped(typed, s, "json"), encodeTyped(v, s, "json"));
    assert.equal(
      digest(decodeTyped(encodeTyped(v, s, "json"), s, "json"), s),
      digest(typed, s),
    );
    const [r] = compareRust([{ hex: hex(b) }]);
    assert.equal(r.ok, true, id);
    assert.equal(r.hex, hex(b));
    assert.equal("sha256:" + r.digest, digest(v, s));
    vectors.push({
      id,
      cbor: hex(b),
      json: JSON.parse(new TextDecoder().decode(encodeTyped(v, s, "json"))),
      digest: digest(v, s),
    });
  }
  writeFileSync(
    new URL("../results/golden.json", import.meta.url),
    JSON.stringify(vectors, null, 2) + "\n",
  );
});
test("scalar domain rejection and scale identity", () => {
  for (const s of [
    "1e1001",
    "1e-1001",
    "NaN",
    "Infinity",
    "123456789012345678901234567890123456789",
  ])
    assert.throws(() => decimal(s));
  for (const s of ["2026-02-29", "2026-04-31"])
    assert.throws(() => temporal(s, "date"));
  for (const s of [
    "2026-10-29T23:59:60Z",
    "2026-10-29T12:34:56.1234567891Z",
    "2026-10-29T12:34:56-00:00",
  ])
    assert.throws(() => temporal(s, "instant"));
  assert.equal(
    temporal("2026-10-29T19:34:56.123456789+07:00", "instant"),
    input.at,
  );
  assert.notEqual(digest("1.23", "decimal"), digest("1.2300", "decimal"));
  for (const b of [
    encode(18446744073709551615n),
    encode(-18446744073709551616n),
  ])
    assert.throws(() => decodeTyped(b, "i64", "cbor"));
  assert.throws(() => decodeTyped(encode("1"), "i64", "cbor"));
});
test("JSON prevalidation, hostile keys and limits", () => {
  for (const text of [
    '{"a":1,"a":2}',
    '{"x":{"a":1,"a":2}}',
    "[1]true",
    "9007199254740993",
    '"\\ud800"x',
    "[".repeat(66) + "0" + "]".repeat(66),
  ])
    assert.throws(() => parseJSON(new TextEncoder().encode(text)));
  const v = parseJSON(
    jsonBytes(
      JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":0,"prototype":1}',
      ),
    ),
  );
  assert.equal(Object.getPrototypeOf(v), null);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseJSON(new Uint8Array(1048577)));
  assert.throws(() => decode(new Uint8Array(1048577)));
});
test("authorization before sensitive validation, logs and approval binding", async () => {
  let runs = 0;
  const base = {
    codec: "json",
    schema,
    session: { principal: "human:alice", target: "db:1", context: "session:1" },
    access: async () => true,
    authorize: async (b) => b.version === 2,
    handler: async (v) => {
      runs++;
      return v.id;
    },
    logInput: true,
    redact: ["secret"],
  };
  const a = await dispatch({
    ...base,
    bytes: encodeTyped(input, schema, "json"),
  });
  const b = await dispatch({
    ...base,
    codec: "cbor",
    bytes: encodeTyped(input, schema, "cbor"),
  });
  assert.equal(a.inputDigest, b.inputDigest);
  assert.equal(a.log.secret, "<redacted>");
  assert.equal(runs, 2);
  const denied = await dispatch({
    ...base,
    access: async () => false,
    bytes: jsonBytes({
      ...input,
      id: "18446744073709551615",
      amount: "invalid",
    }),
  });
  assert.equal(denied.error, "PermissionDenied");
  assert.equal(runs, 2);
  assert.deepEqual(a.events, [
    "bounded-syntax",
    "authenticated-session",
    "access-gate",
    "hydrate",
    "digest-v2",
    "bound-authorization",
    "redact-log",
    "typed-dispatch",
  ]);
});
test("compatibility matrix and nonretryable mutation ambiguity", () => {
  for (const [a, b, c] of [
    [{}, {}, "json-v1"],
    [{}, { codecs: ["json-lossless-v2", "json-v1"] }, "json-v1"],
    [
      { codecs: ["cbor-v1", "json-lossless-v2"] },
      { codecs: ["json-lossless-v2"] },
      "json-lossless-v2",
    ],
  ])
    assert.equal(negotiate(a, b).codec, c);
  assert.throws(() => negotiate({ losslessRequired: true }, {}));
  assert.throws(() => negotiate({ codecs: ["cbor-v1"] }, {}));
  assert.equal(mutationDecodeFailure().retryable, false);
});
test("strict ordering differs from preferred acceptance", () => {
  const b = Uint8Array.from(Buffer.from("a2616201616102", "hex"));
  assert.throws(() => decode(b));
  assert.doesNotThrow(() => decode(b, false));
  const [r] = compareRust([{ hex: hex(b), strict: false }]);
  assert.equal(r.ok, true);
});
test("structure-aware and mutation differential smoke", () => {
  let seed = 21;
  const rand = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const cases = [];
  for (let i = 0; i < 1000; i++) {
    const v = {
        ["k" + (rand() % 50)]: [
          BigInt(rand()),
          "x".repeat(rand() % 64),
          new Tag(4, [-4n, BigInt(rand())]),
        ],
      },
      b = encode(v);
    cases.push({ hex: hex(b) });
    const c = b.slice();
    c[rand() % c.length] = rand() % 256;
    cases.push({ hex: hex(c) });
  }
  for (const s of [
    "1817",
    "bf",
    "a2616101616102",
    "a10100",
    "f7",
    "c24101",
    "c4823b7fffffffffffffff01",
    "c48200c249000100000000000000",
    "63ffffff",
    "a16161",
    "00ff",
  ])
    cases.push({ hex: s });
  const results = compareRust(cases),
    failures = [];
  for (let i = 0; i < cases.length; i++) {
    let accepted = true,
      value;
    try {
      value = decode(Uint8Array.from(Buffer.from(cases[i].hex, "hex")));
    } catch {
      accepted = false;
    }
    if (
      accepted !== results[i].ok ||
      results[i].panic ||
      (accepted && hex(encode(value)) !== results[i].hex)
    )
      failures.push({ case: cases[i], rust: results[i], accepted });
  }
  writeFileSync(
    new URL("../results/fuzz.json", import.meta.url),
    JSON.stringify(
      {
        seed: 21,
        executions: cases.length,
        rustExecutions: cases.length,
        coverage: "not instrumented",
        failures,
      },
      null,
      2,
    ) + "\n",
  );
  assert.deepEqual(failures, []);
});
test("resource thresholds reject before declared oversized allocation", () => {
  const bad = [
    "9a00010001",
    "ba00001001",
    "5a00040001",
    "7a00040001",
    "c4821903e901",
    "c482003bffffffffffffffff",
  ];
  // Last value is legal native Decimal mantissa (-2^64), not an int64.
  for (const s of bad.slice(0, -1)) {
    const bytes = Uint8Array.from(Buffer.from(s, "hex"));
    assert.throws(() => decode(bytes));
    const [r] = compareRust([{ hex: s }]);
    assert.equal(r.ok, false);
  }
  const [last] = compareRust([{ hex: bad.at(-1) }]);
  assert.equal(last.ok, true);
  assert.throws(() =>
    decode(encode(Array.from({ length: 65537 }, () => null))),
  );
  const nested = "81".repeat(66) + "00";
  assert.throws(() => decode(Uint8Array.from(Buffer.from(nested, "hex"))));
});
test("pinned cbor-x is a comparator, not the profile validator", async () => {
  const { Encoder, Decoder } = await import("cbor-x");
  const encoder = new Encoder({ useRecords: false, mapsAsObjects: true });
  const decoder = new Decoder({ useRecords: false, mapsAsObjects: true });
  assert.equal(
    hex(encoder.encode(18446744073709551615n)),
    "1bffffffffffffffff",
  );
  // Library defaults do not provide the profile's duplicate key rejection.
  const bytes = Uint8Array.from(Buffer.from("a2616101616102", "hex"));
  assert.throws(() => decode(bytes));
  assert.equal(decoder.decode(bytes).a, 2);
});
