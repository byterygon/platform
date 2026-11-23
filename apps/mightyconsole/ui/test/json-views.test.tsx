// Every JSON value shown to the user goes through one component (TSK-112): JsonView, Byterygon UI's
// JsonViewer with the choice of Tree or Text remembered in the workspace settings by `modeKey`.
// The first test is the guard: a CodeBlock with language "json" or a direct JsonViewer in a
// tool is a mistake unless it is an exception with its reason (`json-exception:`).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { JsonView } from "@/app/json-view";
import { DEFAULT_SETTINGS, StoreProvider, loadPersisted } from "@/app/store";
import { MemoryStorage } from "@/profiles/storage";
import { act, byText, cleanup, click, render, settle, waitFor } from "./support/render";

afterEach(() => cleanup());

const SRC = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? (name === "gen" ? [] : files(path)) : /\.(tsx?|mts)$/.test(name) ? [path] : [];
  });

describe("JSON views are one component", () => {
  const sources = files(SRC).filter((f) => !f.includes(join("components", "ui")));

  test("no CodeBlock with language json shows data without a json-exception, and the tools use JsonView, not JsonViewer", () => {
    const problems: string[] = [];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      const name = relative(SRC, file);
      if (name !== join("app", "json-view.tsx") && /from "@\/components\/ui\/json-viewer"/.test(text)) problems.push(`${name} imports JsonViewer: use JsonView from @/app/json-view`);
      for (const match of text.matchAll(/<CodeBlock\b[^>]*?\blanguage=(?:"json"|\{[^}]*"json"[^}]*\})/gs)) {
        const before = text.slice(Math.max(0, match.index! - 400), match.index!);
        if (!/json-exception: \S/.test(before.split("\n").slice(-4).join("\n"))) problems.push(`${name}: a CodeBlock with language json (use JsonView, or say why not with a "json-exception: reason" comment just above)`);
      }
    }
    expect(problems).toEqual([]);
  });

  test("every JsonView names itself with a modeKey that no other place uses", () => {
    const keys = new Map<string, string>();
    const dup: string[] = [];
    for (const file of sources) {
      for (const match of readFileSync(file, "utf8").matchAll(/<JsonView\s+modeKey=(?:"([^"]+)"|\{`([^`]+)`\})/g)) {
        const key = match[1] ?? match[2]!;
        const where = relative(SRC, file);
        if (keys.has(key) && keys.get(key) !== where) dup.push(`${key}: ${keys.get(key)} and ${where}`);
        keys.set(key, where);
      }
    }
    expect(dup).toEqual([]);
    expect(keys.size).toBeGreaterThan(20);
  });
});

describe("JsonView remembers the view per modeKey in the settings", () => {
  const value = { id: 1, name: "Ana" };
  const button = (name: string) => [...document.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === name)!;

  test("it starts in its defaultMode, a change is saved, and the next load opens in what was chosen", async () => {
    const storage = new MemoryStorage();
    const mount = async () => {
      const persisted = await loadPersisted(storage, ["nats"]);
      return render(
        <StoreProvider persisted={persisted} storage={storage} saveDelayMs={0}>
          <JsonView modeKey="test.a" defaultMode="text" value={value} aria-label="A" />
          <JsonView modeKey="test.b" value={value} aria-label="B" />
        </StoreProvider>,
      );
    };
    const first = await mount();
    expect(document.querySelectorAll('[data-slot="json-viewer"][data-mode="text"]')).toHaveLength(1);
    expect(document.querySelectorAll('[data-slot="json-viewer"][data-mode="tree"]')).toHaveLength(1);
    // Switch A to Tree: the first Tree button belongs to A.
    await click([...document.querySelectorAll<HTMLElement>("button")].filter((b) => b.textContent === "Tree")[0]!);
    await waitFor(() => document.querySelectorAll('[data-slot="json-viewer"][data-mode="tree"]').length === 2, "A in Tree");
    await act(async () => new Promise<void>((r) => setTimeout(r, 30)));
    const saved = await storage.getSettings<{ settings: { jsonModes: Record<string, string> } }>();
    expect(saved?.settings.jsonModes).toEqual({ "test.a": "tree" });
    first.unmount();
    await mount();
    await settle();
    expect(document.querySelectorAll('[data-slot="json-viewer"][data-mode="tree"]')).toHaveLength(2);
    expect(byText("Text")).not.toBeNull();
    void button;
  });

  test("a settings document with a bad jsonModes is read as no choices", async () => {
    const storage = new MemoryStorage();
    await storage.putSettings({ version: 1, settings: { jsonModes: { "x.y": "text", bad: "grid", n: 3 } } });
    const persisted = await loadPersisted(storage, ["nats"]);
    expect(persisted.settings.jsonModes).toEqual({ "x.y": "text" });
    await storage.putSettings({ version: 1, settings: { jsonModes: [1, 2] } });
    expect((await loadPersisted(storage, ["nats"])).settings.jsonModes).toEqual({});
    expect(DEFAULT_SETTINGS.jsonModes).toEqual({});
  });

  test("without a store it still works from its defaultMode", () => {
    render(<JsonView modeKey="test.c" defaultMode="text" value={value} aria-label="C" />);
    expect(document.querySelector('[data-slot="json-viewer"]')!.getAttribute("data-mode")).toBe("text");
  });
});
