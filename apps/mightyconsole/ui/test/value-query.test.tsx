// The message detail's Query bar, snippets and Profile (Mightyconsole spec §5.6, TSK-113): the
// program goes to the server (`messaging.query`) with the value's text; the results replace the
// value in the same JSON view until Show value; errors mark the line and column; Cancel aborts the
// call; snippets are written for the value's own shape with the part to change selected; recent
// programs are remembered; the Profile table reads the fixed program's output.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { QueryOutput } from "@/gen/api";
import { ValueExplorer } from "@/messaging/ValueExplorer";
import {
  PROFILE_PROGRAM,
  RECENT_LIMIT,
  type ValueQuery,
  canProfile,
  keyPath,
  keysOf,
  placeholderRanges,
  profileProgram,
  recentOf,
  recordsOf,
  snippetsFor,
  valueAt,
  valueCompletion,
  withRecent,
} from "@/messaging/query";
import { fake as monaco } from "../../../../packages/ui/test/fakes/monaco.ts";
import { axeViolations, byRole, byText, cleanup, click, editorArea, key, render, type, waitFor } from "./support/render";

afterEach(cleanup);

const DOC = { orders: [{ id: 1, status: "paid", total: 12.5 }, { id: 2, status: "open", total: 3 }, { id: 3, status: "paid", total: 7, note: null }], meta: { page: 1 } };
const TEXT = JSON.stringify(DOC);

const out = (results: unknown[], extra: Partial<QueryOutput> = {}): QueryOutput => ({ results, count: results.length, bytes: JSON.stringify(results).length, ms: 4, ...extra });

function fakeQuery(answer: (jq: string) => Promise<QueryOutput>, recent: string[] = []) {
  const run = vi.fn<ValueQuery["run"]>((_text, jq) => answer(jq));
  const remember = vi.fn<ValueQuery["remember"]>();
  return { run, remember, recent };
}

const jq = () => editorArea("jq program")!;

async function openBar() {
  await click(byRole("button", /Query/));
  await waitFor(() => jq() !== null, "the jq editor");
}

describe("the value's shape", () => {
  test("records, keys and paths come from the value itself", () => {
    expect(recordsOf(DOC)).toEqual({ path: ".orders", fields: ["id", "status", "total", "note"], numeric: "id" });
    expect(recordsOf(DOC.orders)?.path).toBe(".");
    expect(recordsOf({ a: 1 })).toBeNull();
    expect(canProfile([1, 2])).toBe(false);
    expect(keyPath("a b")).toBe('."a b"');
    expect(keysOf(DOC)).toEqual(["orders", "id", "status", "total", "note", "meta", "page"]);
    expect(valueAt(DOC, ".orders[]")).toEqual(DOC.orders[0]);
    expect(valueAt(DOC, ".orders[2].total")).toBe(7);
    expect(valueAt(DOC, ".nope.x")).toBeUndefined();
  });

  test("suggestions after a dot are the fields at that path; elsewhere builtins", async () => {
    const c = valueCompletion(DOC);
    const labels = async (text: string) => (await c.provide({ text, word: { start: text.length, end: text.length, text: "" } } as never)).map((i) => i.label);
    expect(await labels(".")).toEqual(["orders", "meta"]);
    expect(await labels(".orders[].")).toEqual(["id", "status", "total"]);
    expect(await labels(".meta.")).toEqual(["page"]);
    expect(await labels(".orders | ")).toContain("group_by");
  });

  test("the snippets use the records' path and fields, and select the part to change", () => {
    const s = Object.fromEntries(snippetsFor(DOC).map((x) => [x.id, x]));
    expect(Object.keys(s)).toEqual(["find", "paths", "key", "count", "distinct", "group", "top", "stats"]);
    expect(s["group"]!.code).toBe(".orders | group_by(.id) | map({id: .[0].id, count: length}) | sort_by(-.count)");
    expect(placeholderRanges(s["group"]!.code, "id")).toHaveLength(3);
    expect(s["stats"]!.code).toContain("[.orders[].id | numbers]");
    expect(s["distinct"]!.code).toBe("[.orders[].id] | unique");
    expect(placeholderRanges(`[.. | select(. == "VALUE")]`, "VALUE")).toEqual([[19, 24]]);
    // A placeholder inside a longer word is not one of its occurrences.
    expect(placeholderRanges(".ids, .id", "id")).toEqual([[7, 9]]);
    expect(placeholderRanges(".x", "")).toEqual([]);
  });

  test("recent programs: newest first, no copies, at most the limit", () => {
    expect(recentOf({ jqRecent: ["a", 3, "", "b"] })).toEqual(["a", "b"]);
    expect(withRecent(["a", "b"], " b ")).toEqual(["b", "a"]);
    expect(withRecent(Array.from({ length: 30 }, (_, i) => `q${i}`), "new")).toHaveLength(RECENT_LIMIT);
  });

  test("the Profile program reads the records' path", () => {
    expect(profileProgram(".")).toBe(PROFILE_PROGRAM);
    expect(profileProgram(".orders").startsWith(".orders | if type")).toBe(true);
  });
});

describe("the Query bar (spec §5.6)", () => {
  test("Run sends the value and the program; several results show as a list with their count; Show value returns", async () => {
    const query = fakeQuery(async () => out([1, 2, 3]));
    const { container } = render(<ValueExplorer text={TEXT} label="Value" modeKey="test.value" query={query} />);
    expect(container.querySelector("[data-slot=query-bar]")).toBeNull();
    await openBar();
    await type(jq(), ".orders[].id");
    await key("Enter", {}, jq());
    await waitFor(() => byText(/3 results/) !== null, "the results line");
    expect(query.run).toHaveBeenCalledWith(TEXT, ".orders[].id", expect.any(AbortSignal));
    expect(query.remember).toHaveBeenCalledWith(".orders[].id");
    expect(byRole("tree", "Value: jq results")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
    await click(byRole("button", "Show value"));
    expect(byText(/3 results/)).toBeNull();
    expect(byRole("tree", "Value")).not.toBeNull();
  });

  test("a cut or stopped run says why", async () => {
    let next = out([1], { stopped: "output" });
    const query = fakeQuery(async () => next);
    render(<ValueExplorer text={TEXT} label="Value" modeKey="test.value" query={query} />);
    await openBar();
    await type(jq(), "range(1e18)");
    await click(byRole("button", "Run"));
    await waitFor(() => byText(/Showing the first 1 MiB of results/) !== null, "the output note");
    next = out([1, 2], { stopped: "deadline" });
    await click(byRole("button", "Run"));
    await waitFor(() => byText(/Stopped at the time limit; it is in Settings/) !== null, "the deadline note");
  });

  test("the server's error is shown under the program and marked where it points", async () => {
    const query = fakeQuery(async () => {
      throw Object.assign(new Error("Invalid"), { details: { message: "env is not available: a query cannot read the server's environment", position: { line: 1, column: 10 } } });
    });
    render(<ValueExplorer text={TEXT} label="Value" modeKey="test.value" query={query} />);
    await openBar();
    await type(jq(), ".orders | env");
    await key("Enter", {}, jq());
    await waitFor(() => byText(/env is not available.*\(line 1, column 10\)/) !== null, "the error");
    await waitFor(() => (monaco.markers as unknown[]).length === 1, "the marker");
    expect(query.remember).not.toHaveBeenCalled();
    // Typing clears it.
    await type(jq(), ".orders");
    await waitFor(() => byText(/env is not available/) === null, "the error cleared");
  });

  test("Cancel aborts the call and Run comes back", async () => {
    let signal: AbortSignal | null = null;
    const query = fakeQuery(() => new Promise<QueryOutput>(() => {}));
    query.run.mockImplementation((_t, _j, s) => {
      signal = s;
      return new Promise<QueryOutput>(() => {});
    });
    render(<ValueExplorer text={TEXT} label="Value" modeKey="test.value" query={query} />);
    await openBar();
    await type(jq(), "def f: f; f");
    await click(byRole("button", "Run"));
    await waitFor(() => byRole("button", "Cancel") !== null, "Cancel");
    await click(byRole("button", "Cancel"));
    expect((signal as AbortSignal | null)?.aborted).toBe(true);
    await waitFor(() => byRole("button", "Run") !== null, "Run again");
  });

  test("a snippet fills the editor for this value with the part to change selected", async () => {
    const query = fakeQuery(async () => out([[{ status: "paid", count: 2 }]]));
    render(<ValueExplorer text={TEXT} label="Value" modeKey="test.value" query={query} />);
    await openBar();
    await click(byRole("button", /Snippets/));
    await click(byRole("menuitem", "Group by a field with counts"));
    await waitFor(() => jq().value.startsWith(".orders | group_by(.id)"), "the snippet");
    const area = jq();
    expect(area.value.slice(area.selectionStart, area.selectionEnd)).toBe("id");
    await click(byRole("button", /Snippets/));
    await click(byRole("menuitem", "Find a value"));
    await waitFor(() => jq().value === '[.. | select(. == "VALUE")]', "the find snippet");
    expect(jq().value.slice(jq().selectionStart, jq().selectionEnd)).toBe("VALUE");
  });

  test("Recent lists the profile's programs and puts one back", async () => {
    const query = fakeQuery(async () => out([]), [".meta", ".orders | length"]);
    render(<ValueExplorer text={TEXT} label="Value" modeKey="test.value" query={query} />);
    await openBar();
    await click(byRole("button", /Recent/));
    await click(byRole("menuitem", ".orders | length"));
    await waitFor(() => jq().value === ".orders | length", "the recent program");
  });

  test("Profile runs the fixed program on the records and shows a table", async () => {
    const result = {
      objects: 3,
      others: 0,
      more: 0,
      fields: [
        { field: "id", present: 3, nulls: 0, types: [{ type: "number", count: 3 }], distinct: 3, numbers: { min: 1, max: 3, average: 2 } },
        { field: "note", present: 1, nulls: 1, types: [{ type: "null", count: 1 }], distinct: 1, numbers: null },
        { field: "total", present: 3, nulls: 0, types: [{ type: "number", count: 2 }, { type: "string", count: 1 }], distinct: 3, numbers: { min: 3, max: 12.5, average: 7.75 } },
      ],
    };
    const query = fakeQuery(async () => out([result]));
    const { container } = render(<ValueExplorer text={TEXT} label="Value" modeKey="test.value" query={query} />);
    await openBar();
    await click(byRole("button", /Profile/));
    await waitFor(() => query.run.mock.calls.length === 1, "the profile call");
    await waitFor(() => container.querySelector('table[aria-label="Profile of the fields"]') !== null, "the profile table");
    expect(query.run.mock.calls[0]![1]).toBe(profileProgram(".orders"));
    expect(query.remember).not.toHaveBeenCalled();
    const rows = [...container.querySelectorAll("tbody tr")].map((r) => [...r.querySelectorAll("td")].map((c) => c.textContent));
    expect(rows).toEqual([
      ["id", "number", "3", "0", "3", "1", "3", "2"],
      ["note", "null", "1 of 3", "1", "1", "", "", ""],
      ["total", "number 2, string 1", "3", "0", "3", "3", "12.5", "7.75"],
    ]);
    expect(byText(/Profile of \.orders: 3 objects, 3 fields/)).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Profile is offered only for a value with an array of objects", async () => {
    render(<ValueExplorer text='{"a":1}' label="Value" modeKey="test.value" query={fakeQuery(async () => out([]))} />);
    await openBar();
    expect(byRole("button", /Profile/)).toBeNull();
  });
});
