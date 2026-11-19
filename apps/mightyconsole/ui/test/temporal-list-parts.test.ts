// The Workflows list's column choice and saved queries (TSK-91 mockup frame temporal-workflows).
import { describe, expect, test } from "vitest";
import { moveColumn, normalizeChoice, shownColumns, withSaved } from "@/tools/temporal/list-parts";

describe("columns", () => {
  test("a stored choice is made whole: unknown ids dropped, new columns added at the end", () => {
    const c = normalizeChoice({ order: ["history", "nope", "status"], hidden: ["runId", "x"] });
    expect(c.order.slice(0, 2)).toEqual(["history", "status"]);
    expect(c.order).toHaveLength(8);
    expect(c.hidden).toEqual(["runId"]);
    expect(normalizeChoice(null).hidden).toEqual([]);
  });

  test("moving and hiding", () => {
    const c = normalizeChoice({});
    const moved = moveColumn(c, "type", -1);
    expect(moved.order.slice(0, 2)).toEqual(["type", "status"]);
    expect(moveColumn(c, "status", -1)).toBe(c);
    expect(shownColumns({ ...c, hidden: ["runId", "close"] })).not.toContain("runId");
  });
});

describe("saved queries", () => {
  test("a name or a query saved again replaces the old entry", () => {
    const list = [{ name: "Failed", query: "a" }, { name: "Slow", query: "b" }];
    expect(withSaved(list, "Failed", "c")).toEqual([{ name: "Slow", query: "b" }, { name: "Failed", query: "c" }]);
    expect(withSaved(list, "Mine", "b")).toEqual([{ name: "Failed", query: "a" }, { name: "Mine", query: "b" }]);
  });
});
