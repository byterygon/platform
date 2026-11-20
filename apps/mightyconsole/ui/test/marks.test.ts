// @vitest-environment node
// The tools' own marks (DOC-21 Open question 45 (e), (g)): vendored byte for byte with their sha256,
// the generated module current, a trademark notice per mark, and the ToolModule fields additive.
import { describe, expect, test } from "vitest";
import { MODULE, problems, readManifest, render } from "../scripts/marks";
import { readFileSync } from "node:fs";
import { echoTool } from "../src/tools/echo";
import { LangGraphMark, TemporalMark } from "../src/tools/marks";
import { TOOLS, TOOL_CATEGORIES, orderedTools, toolCategory, toolIcon } from "../src/tools/registry";
import type { ToolModule } from "../src/tools/types";

describe("vendored marks", () => {
  test("every file matches its sha256, none is unlisted, each has its trademark line", () => {
    expect(problems()).toEqual([]);
  });

  test("src/tools/marks.ts is what scripts/marks.ts writes", () => {
    expect(readFileSync(MODULE, "utf8")).toBe(render());
  });

  test("the vendored set is Kubernetes, NATS, Temporal and LangGraph; Docker and Kafka wait for their owners", () => {
    const slugs = readManifest().marks.map((m) => m.slug).sort();
    expect(slugs).toEqual(["kubernetes", "langgraph", "natsdotio", "temporal"]);
    for (const mark of readManifest().marks) {
      expect(mark.guidelines).toMatch(/^https:\/\//);
      expect(mark.upstream).toMatch(/^https:\/\//);
    }
  });

  test("a mark is 24 px artwork the Icon component draws in currentColor, the same shape in both styles", () => {
    expect(TemporalMark.regular[24]).toEqual(TemporalMark.filled[24]);
    expect(TemporalMark.regular[24]).toHaveLength(1);
    expect(LangGraphMark.name).toBe("mark-langgraph");
  });
});

describe("ToolModule's additive fields", () => {
  const bare: ToolModule = { ...echoTool, id: "bare", mark: undefined, category: undefined, order: undefined } as unknown as ToolModule;

  test("toolIcon falls back to the Fluent icon, toolCategory to Other", () => {
    expect(toolIcon(bare)).toBe(echoTool.icon);
    expect(toolCategory(bare)).toBe("Other");
    expect(TOOL_CATEGORIES).toContain("Other");
  });

  test("Temporal and LangGraph carry their marks and the Workflows and agents group", () => {
    const temporal = TOOLS.find((t) => t.id === "temporal")!;
    const langgraph = TOOLS.find((t) => t.id === "langgraph")!;
    expect(toolIcon(temporal)).toBe(TemporalMark);
    expect(toolIcon(langgraph)).toBe(LangGraphMark);
    expect(toolCategory(temporal)).toBe("Workflows and agents");
  });

  test("orderedTools sorts by order, then keeps registry order for ties and tools without one", () => {
    const a = { ...bare, id: "a" } as ToolModule;
    const b = { ...bare, id: "b", order: 5 } as ToolModule;
    const c = { ...bare, id: "c" } as ToolModule;
    const d = { ...bare, id: "d", order: 5 } as ToolModule;
    expect(orderedTools([a, b, c, d]).map((t) => t.id)).toEqual(["b", "d", "a", "c"]);
    expect(orderedTools(TOOLS).map((t) => t.id)).toEqual(["nats", "docker", "temporal", "langgraph", "echo"]);
  });
});
