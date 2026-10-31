// Stable seeded mutation smoke; extended campaigns remain a production-readiness goal.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Tag, encode, decode, hex, parseJSON, jsonBytes } from "./codec.mjs";
let seed = 0x21cb0;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return seed >>> 0;
};
function tree(d) {
  if (d > 4) return BigInt(random());
  switch (random() % 7) {
    case 0:
      return BigInt(random()) - (1n << 31n);
    case 1:
      return "🌍" + String(random());
    case 2:
      return null;
    case 3:
      return [tree(d + 1), tree(d + 1)];
    case 4:
      return Object.fromEntries(
        Array.from({ length: random() % 5 }, (_, i) => ["k" + i, tree(d + 1)]),
      );
    case 5:
      return new Tag(4, [-BigInt(random() % 1000), BigInt(random())]);
    default:
      return !!(random() % 2);
  }
}
const cases = [];
for (let i = 0; i < 5000; i++) {
  const bytes = encode(tree(0));
  cases.push({ hex: hex(bytes) });
  const mutation = bytes.slice();
  if (mutation.length)
    mutation[random() % mutation.length] ^= 1 << (random() % 8);
  cases.push({ hex: hex(mutation) });
}
const jsonCases = [];
for (let i = 0; i < 1000; i++) {
  const s = JSON.stringify({
    ["k" + (random() % 50)]: [random(), String(random()), true],
  });
  jsonCases.push(s);
  const offset = random() % s.length;
  jsonCases.push(
    s.slice(0, offset) +
      String.fromCharCode(32 + (random() % 95)) +
      s.slice(offset + 1),
  );
}
for (const text of jsonCases)
  cases.push({ jsonPayload: text, jsonSyntaxOnly: true });
const binary = new URL(
  "../rust/target/debug/ambidex-cbor-spike",
  import.meta.url,
).pathname;
const failures = [];
let panics = 0;
const started = performance.now();
for (let offset = 0; offset < cases.length; offset += 500) {
  const batch = cases.slice(offset, offset + 500);
  const r = spawnSync(binary, [], {
    input: batch.map((x) => JSON.stringify(x)).join("\n") + "\n",
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 128 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error("Rust fuzz process failed: " + r.stderr);
  const rows = r.stdout.trim().split("\n").map(JSON.parse);
  if (rows.length !== batch.length) throw new Error("result count");
  for (let i = 0; i < batch.length; i++) {
    let ok = true,
      canonical;
    try {
      if (batch[i].hex) {
        const decoded = decode(
          Uint8Array.from(Buffer.from(batch[i].hex, "hex")),
        );
        canonical = hex(encode(decoded));
      } else {
        parseJSON(new TextEncoder().encode(batch[i].jsonPayload));
      }
    } catch {
      ok = false;
    }
    if (rows[i].panic) panics++;
    if (
      ok !== rows[i].ok ||
      rows[i].panic ||
      (canonical && canonical !== rows[i].hex)
    )
      failures.push({ case: batch[i], rust: rows[i], js: ok, canonical });
  }
}
const result = {
  seed: "0x21cb0",
  executionsPerLanguage: cases.length,
  syntaxCBOR: 10000,
  syntaxJSON: 2000,
  elapsedMs: performance.now() - started,
  coverage:
    "grammar categories and differential acceptance; no instrumented edge coverage",
  panics,
  failures,
};
writeFileSync(
  new URL("../results/fuzz-extended-smoke.json", import.meta.url),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(result);
if (failures.length) process.exitCode = 1;
