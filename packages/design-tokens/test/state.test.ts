import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { SCHEMA_VERSION } from "../src/model.js";
import { STATE_HASH_VERSION, base64urlDecode, base64urlEncode, decodeState, encodeState, readThemeFile } from "../src/state.js";
import { ROOT } from "./helpers.js";

const PRESETS = readdirSync(join(ROOT, "themes")).filter((file) => file.endsWith(".theme.json"));
const preset = (file: string) => JSON.parse(readFileSync(join(ROOT, "themes", file), "utf8")) as Record<string, unknown>;

test("base64url round-trips every byte length, without padding", () => {
  for (let length = 0; length < 70; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 97 + length) & 255);
    const text = base64urlEncode(bytes);
    assert.match(text, /^[A-Za-z0-9_-]*$/);
    assert.equal(text, Buffer.from(bytes).toString("base64url"));
    assert.deepEqual(base64urlDecode(text), bytes);
  }
  assert.equal(base64urlDecode("a+b/"), undefined);
  assert.equal(base64urlDecode("abcde"), undefined);
});

test("every preset round-trips through the hash, with the view", async () => {
  for (const file of PRESETS) {
    const theme = preset(file);
    const hash = await encodeState({ theme, mode: "dark", density: "compact" });
    assert.match(hash, /^#by=1&theme=[A-Za-z0-9_-]+&mode=dark&density=compact$/);
    assert.equal(hash, await encodeState({ theme, mode: "dark", density: "compact" }), "deterministic");
    // Six presets fit in 600 characters; Aurora's 14 overrides take about 750.
    assert.ok(hash.length < 800, `${file}: ${hash.length} characters`);
    const decoded = await decodeState(`file:///opt/theme-studio/index.html${hash}`);
    assert.equal(decoded.ok, true);
    assert.deepEqual(decoded.diagnostics, []);
    assert.deepEqual(decoded.state, { theme, mode: "dark", density: "compact" });
  }
});

test("the view parameters are optional; unknown ones are ignored, bad values warn", async () => {
  const theme = preset("default.theme.json");
  const bare = await encodeState({ theme });
  assert.doesNotMatch(bare, /mode|density/);
  const decoded = await decodeState(`${bare}&mode=dim&panel=export`);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.state, { theme });
  assert.deepEqual(decoded.diagnostics.map((d) => [d.rule, d.token, d.severity]), [["state-value-ignored", "mode", "warning"]]);
});

test("a hash from a newer version opens, with a warning", async () => {
  const theme = preset("slate.theme.json");
  const hash = (await encodeState({ theme })).replace("by=1", `by=${STATE_HASH_VERSION + 1}`);
  const decoded = await decodeState(`${hash}&future=1`);
  assert.equal(decoded.ok, true);
  assert.deepEqual(decoded.state!.theme, theme);
  assert.deepEqual(decoded.diagnostics.map((d) => d.rule), ["state-newer-version"]);
});

test("a theme file from a newer schemaVersion keeps what this version knows", async () => {
  const newer = {
    schemaVersion: SCHEMA_VERSION + 1,
    name: "future",
    palette: "x",
    seeds: { radius: 4, motion: "calm", colors: { brand: { hue: 150, curve: "s" } }, contrast: { level: "AAA", method: "apca-2" } },
    overrides: { "radius.lg": "12px" },
  };
  const read = readThemeFile(newer);
  assert.deepEqual(read.theme, {
    schemaVersion: SCHEMA_VERSION,
    name: "future",
    seeds: { radius: 4, colors: { brand: { hue: 150 } }, contrast: { level: "AAA" } },
    overrides: { "radius.lg": "12px" },
  });
  assert.deepEqual(read.diagnostics.map((d) => [d.rule, d.token]), [
    ["theme-newer-version", "schemaVersion"],
    ["theme-key-dropped", "palette"],
    ["theme-key-dropped", "seeds.motion"],
    ["theme-key-dropped", "seeds.colors.brand.curve"],
    ["theme-key-dropped", "seeds.contrast.method"],
  ]);
  assert.ok(read.diagnostics.every((d) => d.severity === "warning"));

  const decoded = await decodeState(await encodeState({ theme: newer }));
  assert.deepEqual(decoded.state!.theme, read.theme);
  assert.equal(decoded.diagnostics.length, read.diagnostics.length);

  const current = preset("paper.theme.json");
  assert.equal(readThemeFile(current).theme, current, "a current file is returned as it is");
  assert.deepEqual(readThemeFile(current).diagnostics, []);
});

test("malformed hashes fail with an actionable error", async () => {
  const good = await encodeState({ theme: preset("default.theme.json") });
  for (const input of ["", "#theme=abc", "#by=one&theme=abc", "#by=1", "#by=1&theme=a+b", "#by=1&theme=AAAA", good.slice(0, -10)]) {
    const decoded = await decodeState(input);
    assert.equal(decoded.ok, false, input);
    assert.equal(decoded.state, undefined);
    const [diagnostic] = decoded.diagnostics;
    assert.equal(diagnostic!.rule, "state-invalid");
    assert.ok(diagnostic!.fix!.summary.length > 10);
  }
});
