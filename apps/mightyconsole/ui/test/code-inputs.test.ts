// The code inputs of TSK-93 (DOC-21 Open question 45 (m)), their pure parts: the
// temporal-visibility completion and error markers, the jq suggestions, and the JSON Schemas the
// LangGraph editors get.
import { describe, expect, test } from "vitest";
import type { CodeCompletion, CodeCompletionItem } from "@/components/ui/code-editor";
import type { SearchAttribute } from "@/gen/api";
import { jqCompletion } from "@/messaging/FilterBar";
import { configSchema, partialSchema, schemaObject, seenKeysSchema } from "@/tools/langgraph/shared";
import { JQ_GRAMMAR } from "@/lib/monaco";
import { VISIBILITY_GRAMMAR, collectValues, queryErrorMarker, recentQueries, rememberQuery, tokenize, visibilityCompletion } from "@/tools/temporal/visibility";
// Monaco's own Monarch compiler (pure; a relative path, so the test alias to the fake skips it).
// @ts-expect-error -- no declaration file
import { compile } from "../node_modules/monaco-editor/esm/vs/editor/standalone/common/monarch/monarchCompile.js";

describe("the grammars compile with Monaco's Monarch compiler", () => {
  test.each([
    ["temporal-visibility", VISIBILITY_GRAMMAR],
    ["jq", JQ_GRAMMAR],
  ])("%s", (id, grammar) => {
    const lexer = (compile as (id: string, json: unknown) => { tokenizer: Record<string, unknown[]> })(id, grammar);
    expect(Object.keys(lexer.tokenizer).length).toBeGreaterThan(0);
  });
});

const attributes: SearchAttribute[] = [
  { name: "Amount", valueType: "Double", custom: true },
  { name: "Customer Tier", valueType: "Keyword", custom: true },
  { name: "ExecutionStatus", valueType: "Keyword", custom: false },
  { name: "Paused", valueType: "Bool", custom: true },
  { name: "StartTime", valueType: "Datetime", custom: false },
  { name: "WorkflowType", valueType: "Keyword", custom: false },
];

async function ask(source: CodeCompletion, text: string, offset = text.length): Promise<CodeCompletionItem[]> {
  const start = /[A-Za-z0-9_]*$/.exec(text.slice(0, offset))!.index;
  return [...(await source.provide({ text, offset, line: 1, column: offset + 1, word: { text: text.slice(start, offset), start, end: offset }, reason: "invoke" }))];
}

describe("temporal-visibility", () => {
  const values = collectValues([
    { workflowId: "order-1", runId: "r1", workflowType: "OrderWorkflow", status: "Running", startTime: "x", taskQueue: "orders", historyLength: 1 },
    { workflowId: "order-2", runId: "r2", workflowType: "ShipWorkflow", status: "Failed", startTime: "x", taskQueue: "orders", historyLength: 1 },
  ]);
  const source = visibilityCompletion(() => ({ attributes, values, recent: ["WorkflowType = \"OrderWorkflow\""], saved: [{ name: "Failed today", query: 'ExecutionStatus = "Failed"' }], now: () => new Date("2026-11-18T10:30:00Z") }));
  const labels = async (text: string, offset?: number) => (await ask(source, text, offset)).map((i) => i.label);

  test("tokens: strings (open or closed), backquoted names, numbers, operators", () => {
    expect(tokenize('`Customer Tier` = "gold" AND Amount >= -2.5 AND x IN ("a",').map((t) => [t.kind, t.text])).toEqual([
      ["word", "`Customer Tier`"], ["operator", "="], ["string", '"gold"'], ["word", "AND"], ["word", "Amount"], ["operator", ">="], ["number", "-2.5"],
      ["word", "AND"], ["word", "x"], ["word", "IN"], ["open", "("], ["string", '"a"'], ["comma", ","],
    ]);
    expect(tokenize('WorkflowType = "Ord').at(-1)).toMatchObject({ kind: "string", closed: false });
  });

  test("at the start: saved and recent queries replacing the text, then the attributes, custom first", async () => {
    const items = await ask(source, "");
    const queries = items.filter((i) => i.kind === "history").sort((a, b) => a.sortText!.localeCompare(b.sortText!));
    expect(queries.map((i) => [i.label, i.detail])).toEqual([['ExecutionStatus = "Failed"', "saved: Failed today"], ['WorkflowType = "OrderWorkflow"', "recent"]]);
    expect(queries[0]!.replace).toEqual({ start: 0, end: 0 });
    expect(queries.every((q) => q.sortText! < "1")).toBe(true);
    const fields = items.filter((i) => i.kind === "field").sort((a, b) => a.sortText!.localeCompare(b.sortText!));
    expect(fields.map((f) => f.label)).toEqual(["Amount", "Customer Tier", "Paused", "ExecutionStatus", "StartTime", "WorkflowType"]);
    expect(fields.find((f) => f.label === "Customer Tier")).toMatchObject({ insertText: "`Customer Tier`", detail: "Keyword · custom" });
    expect(await labels("Wor")).toContain("WorkflowType");
  });

  test("after an attribute, the operators of its type", async () => {
    expect(await labels("Amount ")).toEqual(["=", "!=", ">", ">=", "<", "<=", "BETWEEN"]);
    expect(await labels("Paused ")).toEqual(["=", "!="]);
    expect(await labels("`Customer Tier` ")).toEqual(["=", "!=", "IN", "STARTS_WITH", "IS NULL", "IS NOT NULL"]);
  });

  test("after an operator, values: seen in the rows, every status, booleans, dates", async () => {
    expect(await labels("WorkflowType = ")).toEqual(['"OrderWorkflow"', '"ShipWorkflow"']);
    expect(await labels("ExecutionStatus != ")).toEqual(expect.arrayContaining(['"Running"', '"Failed"', '"Completed"', '"TimedOut"']));
    expect(await labels("Paused = ")).toEqual(["true", "false"]);
    expect(await labels("StartTime > ")).toEqual(['"2026-11-18T00:00:00Z"', '"2026-11-17T10:30:00Z"']);
    expect(await labels("StartTime BETWEEN \"2026-11-01T00:00:00Z\" AND ")).toEqual(['"2026-11-18T00:00:00Z"', '"2026-11-17T10:30:00Z"']);
    expect(await labels('WorkflowType IN ("OrderWorkflow", ')).toEqual(['"OrderWorkflow"', '"ShipWorkflow"']);
  });

  test("inside a string: the bare values, closing the quote when it is open", async () => {
    const items = await ask(source, 'WorkflowType = "Sh');
    expect(items.map((i) => [i.label, i.insertText, i.replace])).toEqual([
      ["OrderWorkflow", 'OrderWorkflow"', { start: 16, end: 18 }],
      ["ShipWorkflow", 'ShipWorkflow"', { start: 16, end: 18 }],
    ]);
    const closed = await ask(source, 'WorkflowType = "Sh"', 18);
    expect(closed[0]!.insertText).toBe("OrderWorkflow");
  });

  test("after a value: AND, OR, ORDER BY; then attributes, IS, IN, ORDER BY's directions", async () => {
    expect(await labels('WorkflowType = "OrderWorkflow" ')).toEqual(["AND", "OR", "ORDER BY"]);
    expect(await labels('WorkflowType = "OrderWorkflow" AND ')).toContain("StartTime");
    expect(await labels("WorkflowType IS ")).toEqual(["NULL", "NOT NULL"]);
    expect(await labels("WorkflowType IS NOT ")).toEqual(["NULL", "NOT NULL"]);
    expect(await labels("WorkflowType IN ")).toEqual(["(…)"]);
    expect(await labels("ExecutionStatus = \"Running\" ORDER BY StartTime ")).toEqual(["ASC", "DESC"]);
  });

  test("the server's error marks the part it quotes, else the whole query", () => {
    expect(queryErrorMarker("invalid search attribute: Bogus", 'Bogus = "x"')).toMatchObject({ column: 1, endColumn: 6 });
    expect(queryErrorMarker("unable to parse query: syntax error at position 20 near 'ANDD'", 'A = "x" ANDD B = 1')).toMatchObject({ column: 9, endColumn: 13 });
    expect(queryErrorMarker("operator 'LIKE' not allowed", "  A LIKE 'x%'  ")).toMatchObject({ column: 5, endColumn: 9 });
    expect(queryErrorMarker("something went wrong", "  A = 1 ")).toMatchObject({ column: 3, endColumn: 8 });
    expect(queryErrorMarker("x", "")).toBeNull();
  });

  test("recent queries: per profile and namespace, newest first, ten at most, no repeats", () => {
    for (let i = 0; i < 12; i += 1) rememberQuery("p", "ns", `q${i}`);
    rememberQuery("p", "ns", "q5");
    rememberQuery("p", "ns", "  ");
    expect(recentQueries("p", "ns")).toEqual(["q5", "q11", "q10", "q9", "q8", "q7", "q6", "q4", "q3", "q2"]);
    expect(recentQueries("p", "other")).toEqual([]);
  });
});

describe("jq suggestions", () => {
  test("the message's fields after a leading dot; builtins and keywords otherwise", async () => {
    expect((await ask(jqCompletion, ".")).map((i) => i.label)).toEqual(["value", "key", "headers", "subject", "source", "partition", "offset", "sequence", "timestamp"]);
    expect((await ask(jqCompletion, ".value | .")).map((i) => i.label)).toContain("timestamp");
    expect(await ask(jqCompletion, ".value.")).toEqual([]);
    const words = (await ask(jqCompletion, "sel")).map((i) => i.label);
    expect(words).toEqual(expect.arrayContaining([".value", "select", "length", "and", "if"]));
  });
});

describe("LangGraph JSON Schemas", () => {
  test("schemaObject keeps objects only", () => {
    expect(schemaObject({ type: "object" })).toEqual({ type: "object" });
    for (const v of [null, true, [], {}, "x"]) expect(schemaObject(v)).toBeUndefined();
  });

  test("a partial update requires nothing", () => {
    expect(partialSchema({ type: "object", properties: { a: {} }, required: ["a"] })).toEqual({ type: "object", properties: { a: {} } });
  });

  test("config: a whole-config schema as it is; a configurable one wrapped, its $defs at the root", () => {
    const whole = { type: "object", properties: { configurable: { type: "object" } } };
    expect(configSchema(whole)).toBe(whole);
    expect(configSchema({ type: "object", properties: { model: { $ref: "#/$defs/Model" } }, $defs: { Model: { enum: ["a"] } } })).toEqual({
      type: "object",
      properties: { configurable: { type: "object", properties: { model: { $ref: "#/$defs/Model" } } } },
      $defs: { Model: { enum: ["a"] } },
    });
    expect(configSchema(null)).toBeUndefined();
  });

  test("seen keys become properties with their scalar values as examples", () => {
    expect(seenKeysSchema([{ user: "ana", n: 1, deep: { x: 1 } }, { user: "bo" }, null, ["x"]])).toEqual({
      type: "object",
      properties: { deep: {}, n: { examples: [1] }, user: { examples: ["ana", "bo"] } },
    });
  });
});
