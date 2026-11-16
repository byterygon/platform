import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { PRESET_LABELS, copyName, duplicateTheme, presetLabel, presetOrder } from "../src/presets.js";
import { ROOT } from "./helpers.js";

const FILES = readdirSync(join(ROOT, "themes"))
  .filter((file) => file.endsWith(".theme.json"))
  .map((file) => file.slice(0, -".theme.json".length));

test("every preset in themes/ has a label, and every label a preset", () => {
  assert.deepEqual(Object.keys(PRESET_LABELS).sort(), [...FILES].sort());
  assert.equal(presetLabel("default"), "Aurora");
  assert.equal(presetLabel("high-contrast"), "High contrast");
  assert.equal(presetLabel("my-ocean-theme"), "My ocean theme");
});

test("presetOrder puts the labelled presets first, in the gallery's order, then the rest by name", () => {
  assert.deepEqual(presetOrder([...FILES].sort()), ["default", "classic", "slate", "paper", "midnight", "terminal", "high-contrast"]);
  assert.deepEqual(presetOrder(["zeta", "slate", "alpha", "default", "slate"]), ["default", "slate", "alpha", "zeta"]);
});

test("copyName finds a free name and does not stack suffixes", () => {
  assert.equal(copyName("slate", []), "slate-copy");
  assert.equal(copyName("slate", ["slate-copy"]), "slate-copy-2");
  assert.equal(copyName("slate-copy", ["slate-copy", "slate-copy-2"]), "slate-copy-3");
  assert.equal(copyName("slate-copy-2", ["slate-copy"]), "slate-copy-2");
});

test("duplicateTheme is what preset create --from writes", () => {
  const paper = JSON.parse(readFileSync(join(ROOT, "themes", "paper.theme.json"), "utf8")) as Record<string, unknown>;
  const copy = duplicateTheme(paper, "paper-copy");
  assert.deepEqual(Object.keys(copy), Object.keys(paper).filter((key) => key !== "$schema"));
  assert.equal(copy["name"], "paper-copy");
  assert.equal(copy["description"], "Based on the paper preset.");
  assert.deepEqual(copy["seeds"], paper["seeds"]);
  assert.notEqual(copy["seeds"], paper["seeds"], "a deep copy");
  assert.equal(paper["name"], "paper", "the base is not changed");
  assert.deepEqual(duplicateTheme(undefined, "fresh"), { schemaVersion: 1, name: "fresh", description: "A new theme on the engine defaults." });
});
