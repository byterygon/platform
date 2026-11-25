// @vitest-environment node
// The release files (TSK-87), without building anything: the committed notes give a valid
// version, the version rule (0.1.0-alpha.N per finished tool, 0.1.0 with all six), the release
// notes' order, and what the shipped README must say.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { RELEASE_DIR, TOOLS, readFix, readNotes, releaseNotes, versionFor } from "../../release/release.mts";

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
    expect(versionFor(notes)).toMatch(/^0\.1\.0(-alpha\.\d+(\.\d+)?)?$/);
  });

  test("one alpha per finished tool, 0.1.0 with all six", () => {
    const none = fixture(BASE, []);
    expect(versionFor(readNotes(none.notes, none.tools), 0)).toBe("0.1.0-alpha.0");

    const two = fixture({ ...BASE, "1-docker.md": "Docker notes", "2-k8s.md": "Kubernetes notes" }, ["docker", "k8s"]);
    expect(versionFor(readNotes(two.notes, two.tools), 0)).toBe("0.1.0-alpha.2");

    const all = fixture(Object.fromEntries([...Object.entries(BASE), ...TOOLS.map((t, i) => [`${i + 1}-${t.id}.md`, `${t.name} notes`])]), TOOLS.map((t) => t.id));
    expect(versionFor(readNotes(all.notes, all.tools), 0)).toBe("0.1.0");
  });

  test("a fix release of the same tools is 0.1.0-alpha.N.R and goes stale with the next tool", () => {
    const two = fixture({ ...BASE, "1-docker.md": "Docker notes", "2-k8s.md": "Kubernetes notes" }, ["docker", "k8s"]);
    const notes = readNotes(two.notes, two.tools);
    expect(versionFor(notes, 1)).toBe("0.1.0-alpha.2.1");
    expect(versionFor(notes, 12)).toBe("0.1.0-alpha.2.12");

    const dir = fixture({}, []).notes;
    const file = join(dir, "FIX");
    expect(readFix(2, file)).toBe(0); // no file
    writeFileSync(file, "2.1\n");
    expect(readFix(2, file)).toBe(1);
    expect(readFix(3, file)).toBe(0); // a third tool made it stale: back to 0.1.0-alpha.3
    for (const bad of ["", "2", "2.0", "2.01", "x.1", "2.1.1", "-2.1"]) {
      writeFileSync(file, bad);
      expect(() => readFix(2, file), JSON.stringify(bad)).toThrow(/FIX/);
    }

    const all = fixture(Object.fromEntries([...Object.entries(BASE), ...TOOLS.map((t, i) => [`${i + 1}-${t.id}.md`, `${t.name} notes`])]), TOOLS.map((t) => t.id));
    expect(() => versionFor(readNotes(all.notes, all.tools), 1)).toThrow(/0\.1\.1/);
  });

  test("the committed FIX is read and shown in the version and the release notes", () => {
    const notes = readNotes();
    const fix = readFix(notes.length - 1);
    expect(versionFor(notes)).toBe(fix > 0 ? `0.1.0-alpha.${notes.length - 1}.${fix}` : `0.1.0-alpha.${notes.length - 1}`);
    if (fix > 0) expect(releaseNotes(notes)).toContain(`Fix release ${fix} of alpha ${notes.length - 1}`);
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
    const text = releaseNotes(readNotes(notes, tools), 0);
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

  test("the shipped README covers start, open, the certificate, sign-in, profiles and exposure", () => {
    const readme = readFileSync(join(RELEASE_DIR, "README.md"), "utf8");
    for (const needle of ["Everyone signs in", "admin-password", "docker cp mightyconsole:/data/admin-password -", "reset-admin --print", "127.0.0.1", "https://localhost:7443/", "fingerprint", "mkcert", "IndexedDB", "Export all profiles", "SHA256SUMS", "loses those secrets", "keys generate --out", "-p 127.0.0.1:7443:7443", "AGPL-3.0-only"]) {
      expect(readme, needle).toContain(needle);
    }
    const dockerfile = readFileSync(join(RELEASE_DIR, "Dockerfile"), "utf8");
    expect(dockerfile).toMatch(/^FROM scratch$/m);
    expect(dockerfile).toMatch(/^USER 65532:65532$/m);
  });
});
