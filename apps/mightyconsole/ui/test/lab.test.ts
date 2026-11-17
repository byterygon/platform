// @vitest-environment node
// The test lab's files (spec section 14, TSK-79), without Docker: every published port is bound
// to 127.0.0.1, every pulled image is pinned by digest and listed in images.lock, every tool has
// its compose profile, and nothing generated is committed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { LAB, TOOLS, imagePins } from "../../lab/lab.mts";

const compose = readFileSync(join(LAB, "compose.yaml"), "utf8");

describe("test lab", () => {
  test("every published port is on 127.0.0.1", () => {
    const ports = [...compose.matchAll(/^\s+ports:\s*\[(.*)\]\s*$/gm)].flatMap((m) => m[1]!.split(",").map((p) => p.trim().replace(/^"|"$/g, "")));
    expect(ports.length).toBeGreaterThanOrEqual(10);
    for (const port of ports) expect(port, port).toMatch(/^127\.0\.0\.1:\d+:\d+$/);
    // No other way of publishing (long syntax, host networking).
    expect(compose).not.toMatch(/network_mode:\s*host|published:/);
  });

  test("every image is pinned by digest and listed in images.lock", () => {
    const { compose: images, problems } = imagePins();
    expect(problems).toEqual([]);
    expect(images.filter((i) => !i.startsWith("mightyconsole-lab-")).every((i) => i.includes("@sha256:"))).toBe(true);
  });

  test("one profile per tool, and all", () => {
    for (const tool of [...TOOLS, "all"]) expect(compose).toMatch(new RegExp(`profiles: \\[[^\\]]*\\b${tool}\\b`));
  });

  test("the Python packages are locked with hashes", () => {
    for (const dir of ["tools", "langgraph"]) {
      const lock = readFileSync(join(LAB, dir, "requirements.lock"), "utf8");
      const pins = lock.split("\n").filter((l) => /^[a-z0-9]/i.test(l));
      expect(pins.length, dir).toBeGreaterThan(5);
      for (const pin of pins) expect(pin, `${dir}: ${pin}`).toMatch(/==\S+.*\\$/);
      expect(lock).toContain("--hash=sha256:");
      expect(readFileSync(join(LAB, dir, "Dockerfile"), "utf8")).toContain("--require-hashes");
    }
  });

  test("generated credentials are ignored, never committed", () => {
    expect(readFileSync(join(LAB, ".gitignore"), "utf8")).toContain(".generated/");
    expect(existsSync(join(LAB, "credentials.json"))).toBe(false);
  });
});
