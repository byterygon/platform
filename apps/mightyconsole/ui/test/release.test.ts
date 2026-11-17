// @vitest-environment node
// The release files (TSK-87), without building anything: the committed notes give a valid
// version, the version rule (0.1.0-alpha.N per finished tool, 0.1.0 with all six), the release
// notes' order, and what the shipped README must say.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RELEASE_DIR, TOOLS, readNotes, releaseNotes, versionFor } from "../../release/release.mts";

const temp: string[] = [];
afterEach(() => {
  for (const dir of temp.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A notes folder and a tools folder with the given files and tool modules. */
function fixture(files: Record<string, string>, tools: string[]): { notes: string; tools: string } {
  const root = mkdtempSync(join(tmpdir(), "mightyconsole-release-"));
  temp.push(root);
  const notes = join(root, "notes");
  const toolsDir = join(root, "tools");
  mkdirSync(notes);
  mkdirSync(toolsDir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(notes, name), text);
  for (const tool of tools) mkdirSync(join(toolsDir, tool));
  return { notes, tools: toolsDir };
}

const BASE = { "0-foundation.md": "## The base\n\n- the shell" };

describe("release", () => {
  test("the committed notes are valid", () => {
    const notes = readNotes();
    expect(notes[0]!.id).toBe("foundation");
    expect(versionFor(notes)).toMatch(/^0\.1\.0(-alpha\.\d)?$/);
  });

  test("one alpha per finished tool, 0.1.0 with all six", () => {
    const none = fixture(BASE, []);
    expect(versionFor(readNotes(none.notes, none.tools))).toBe("0.1.0-alpha.0");

    const two = fixture({ ...BASE, "1-docker.md": "Docker notes", "2-k8s.md": "Kubernetes notes" }, ["docker", "k8s"]);
    expect(versionFor(readNotes(two.notes, two.tools))).toBe("0.1.0-alpha.2");

    const all = fixture(Object.fromEntries([...Object.entries(BASE), ...TOOLS.map((t, i) => [`${i + 1}-${t.id}.md`, `${t.name} notes`])]), TOOLS.map((t) => t.id));
    expect(versionFor(readNotes(all.notes, all.tools))).toBe("0.1.0");
  });

  test("gaps, duplicates, unknown tools and missing modules are refused", () => {
    const cases: [Record<string, string>, string[], RegExp][] = [
      [{ ...BASE, "2-docker.md": "x" }, ["docker"], /expected number 1/],
      [{ ...BASE, "1-docker.md": "x", "1-k8s.md": "y" }, ["docker", "k8s"], /expected number 2/],
      [{ ...BASE, "1-docker.md": "x", "2-docker.md": "y" }, ["docker"], /docker: more than one note/],
      [{ ...BASE, "1-redis.md": "x" }, ["redis"], /"redis" is not one of/],
      [{ ...BASE, "1-docker.md": "x" }, [], /no tool module src\/tools\/docker/],
      [{ "1-docker.md": "x" }, ["docker"], /0-foundation\.md is missing/],
      [{ ...BASE, "notes.txt": "x" }, [], /not <N>-<tool>\.md/],
    ];
    for (const [files, tools, error] of cases) {
      const { notes, tools: dir } = fixture(files, tools);
      expect(() => readNotes(notes, dir)).toThrow(error);
    }
  });

  test("the notes put the newest tool first and list what is still missing", () => {
    const { notes, tools } = fixture({ ...BASE, "1-docker.md": "## Docker\n\n- containers", "2-k8s.md": "- pods and logs" }, ["docker", "k8s"]);
    const text = releaseNotes(readNotes(notes, tools));
    expect(text.startsWith("# Mightyconsole 0.1.0-alpha.2\n")).toBe(true);
    const at = (needle: string) => text.indexOf(needle);
    expect(at("## New in this release: Kubernetes")).toBeGreaterThan(0);
    expect(at("## Earlier in 0.1")).toBeGreaterThan(at("- pods and logs"));
    expect(at("### Docker over SSH (alpha 1)")).toBeGreaterThan(at("## Earlier in 0.1"));
    // The tool's own heading moves under the release's.
    expect(text).toContain("#### Docker\n");
    expect(at("## The base")).toBeGreaterThan(at("- containers"));
    expect(text).toContain("## Not in this release yet\n\n- NATS (TSK-85)");
    expect(text).not.toContain("- Docker over SSH (TSK-81)");
  });

  test("the shipped README covers start, open, the certificate, profiles and exposure", () => {
    const readme = readFileSync(join(RELEASE_DIR, "README.md"), "utf8");
    for (const needle of ["no login", "127.0.0.1", "https://localhost:7443/", "fingerprint", "mkcert", "IndexedDB", "Export all profiles", "SHA256SUMS", "-p 127.0.0.1:7443:7443", "AGPL-3.0-only"]) {
      expect(readme, needle).toContain(needle);
    }
    const dockerfile = readFileSync(join(RELEASE_DIR, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^FROM scratch$/m);
    expect(dockerfile).toMatch(/^USER 65532:65532$/m);
  });
});
