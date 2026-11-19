// The actions of the workflow tab (Mightyconsole spec §9.4): signal, cancel, terminate and reset,
// each behind a confirmation that names the workflow, with the destructive ones needing their
// reason; the server's error stays in the dialog; and the Queries view.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { EventCategory, HistoryEvent, WorkflowDetail } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { parseArgs, resetPoints } from "@/tools/temporal/ActionDialogs";
import { queryNamesOf } from "@/tools/temporal/QueriesPanel";
import { WorkflowTab } from "@/tools/temporal/WorkflowTab";
import { profile as schema } from "@/tools/temporal/profile";
import type { TabProps, TabRecord } from "@/tools/types";
import { byRole, byText, cleanup, click, dialogWith, editorArea, render, settle, type, waitFor } from "./support/render";

afterEach(cleanup);

const T0 = Date.parse("2026-11-18T01:00:00Z");
const ev = (eventId: number, eventType: string, atMs: number, category: EventCategory, attributes: Record<string, unknown> = {}): HistoryEvent => ({ eventId, eventTime: new Date(T0 + atMs).toISOString(), eventType, category, attributes });

const events: HistoryEvent[] = [
  ev(1, "WorkflowExecutionStarted", 0, "Workflow", { workflowType: { name: "Fulfilment" }, input: ["ord-1"] }),
  ev(2, "WorkflowTaskScheduled", 1, "WorkflowTask"),
  ev(3, "WorkflowTaskStarted", 2, "WorkflowTask"),
  ev(4, "WorkflowTaskCompleted", 3, "WorkflowTask"),
  ev(5, "WorkflowExecutionSignaled", 800, "Signal", { signalName: "approve" }),
  ev(6, "WorkflowTaskScheduled", 801, "WorkflowTask"),
  ev(7, "WorkflowTaskStarted", 802, "WorkflowTask"),
  ev(8, "WorkflowTaskCompleted", 803, "WorkflowTask"),
];

const RUN = "0190aaaa-bbbb-cccc-dddd-000000000001";
const detail = (status: WorkflowDetail["workflow"]["status"] = "Running"): WorkflowDetail => ({
  workflow: { workflowId: "fulfilment-long-running", runId: RUN, workflowType: "Fulfilment", status, startTime: new Date(T0).toISOString(), taskQueue: "lab", historyLength: events.length },
  executionConfig: {},
  pendingActivities: [],
  pendingChildren: [],
  memo: {},
  searchAttributes: {},
  autoResetPoints: [],
});

function setup(options: { status?: WorkflowDetail["workflow"]["status"]; fail?: unknown } = {}) {
  const status = options.status ?? "Running";
  const never = { result: new Promise<never>(() => {}), cancel: () => {}, chunks: async function* () {} };
  const write = (name: string, value: unknown = {}) =>
    vi.fn(async (_input: unknown) => {
      if (options.fail) throw options.fail;
      void name;
      return value;
    });
  const wf = {
    describe: vi.fn(async (_input: unknown) => detail(status)),
    history: vi.fn(async (_input: unknown) => ({ events })),
    followHistory: vi.fn((_input: unknown, _options?: unknown) => never),
    query: vi.fn(async (_input: { queryType: string }) => ({ result: "ok" }) as { result: unknown }),
    signal: write("signal"),
    cancel: write("cancel"),
    terminate: write("terminate"),
    reset: write("reset", { runId: "0190ffff-new-run" }),
  };
  const client = { temporal: { workflows: wf } } as unknown as MightyClient;
  const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const tab: TabRecord = { id: "t2", tool: "temporal", profileId: "01T", kind: "temporal.workflow", params: { namespace: "lab", workflowId: "fulfilment-long-running" }, title: "w", pinned: false };
  const openTab = vi.fn();
  const props: TabProps = { tab, profile, connId: "conn-1", client, active: true, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab };
  const view = render(<WorkflowTab {...props} />);
  return { wf, openTab, ...view };
}

const ready = () => waitFor(() => byRole("button", "Signal") !== null && byRole("tab", "Queries") !== null, "the loaded tab");
/** Opens the header's overflow menu and picks an item (Reset…, Terminate…, Refresh). */
async function fromMenu(name: RegExp) {
  await click(byRole("button", "More actions"));
  await waitFor(() => byRole("menuitem", name) !== null, "the overflow menu");
  await click(byRole("menuitem", name));
}
const confirm = (name: string) => byRole("button", name, dialogWith(name)!.ownerDocument.body);
const dialogButton = (dialogText: string, button: string) => {
  const d = dialogWith(dialogText);
  if (!d) throw new Error(`no dialog with ${dialogText}`);
  return byRole("button", button, d);
};
const field = (dialogText: string, label: string): HTMLInputElement => {
  const d = dialogWith(dialogText)!;
  for (const l of d.querySelectorAll<HTMLLabelElement>("label")) {
    if (l.textContent?.includes(label)) {
      const input = l.querySelector("input") ?? (l.htmlFor ? d.querySelector<HTMLInputElement>(`#${CSS.escape(l.htmlFor)}`) : null) ?? l.parentElement?.querySelector("input");
      if (input) return input as HTMLInputElement;
    }
  }
  throw new Error(`no field ${label}`);
};
const isDisabled = (el: HTMLElement | null) => el !== null && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"));

/** Writes the arguments into their CodeEditor (Monaco's test fake). */
async function writeCode(json: string) {
  const area = editorArea("Arguments");
  if (!area) throw new Error("no code field");
  await type(area, json);
  await settle(2);
}

describe("pure parts", () => {
  test("arguments: an array is one argument per item, any other JSON is one, empty is none", () => {
    expect(parseArgs("")).toEqual({ args: [] });
    expect(parseArgs('["a", 2]')).toEqual({ args: ["a", 2] });
    expect(parseArgs('{"a":1}')).toEqual({ args: [{ a: 1 }] });
    expect(parseArgs("7")).toEqual({ args: [7] });
    expect("error" in parseArgs("{oops")).toBe(true);
  });

  test("reset points are the workflow tasks that completed, started or failed", () => {
    const all = [...events, ev(9, "WorkflowTaskFailed", 900, "WorkflowTask"), ev(10, "ActivityTaskScheduled", 910, "Activity")];
    expect(resetPoints(all).map((e) => e.eventId)).toEqual([3, 4, 7, 8, 9]);
  });

  test("query names come from the worker's metadata when it has them", () => {
    expect(queryNamesOf({ definition: { queryDefinitions: [{ name: "status" }, { name: "history", description: "x" }, { nope: 1 }] } })).toEqual(["status", "history"]);
    expect(queryNamesOf("not metadata")).toEqual([]);
    expect(queryNamesOf(null)).toEqual([]);
  });
});

describe("actions (spec §9.4)", () => {
  test("Signal names the workflow, needs a name, and sends the JSON arguments", async () => {
    const { wf } = setup();
    await ready();
    await click(byRole("button", "Signal"));
    await waitFor(() => dialogWith("Signal fulfilment-long-running") !== null, "the dialog");
    expect(isDisabled(dialogButton("Signal fulfilment-long-running", "Send signal"))).toBe(true);
    await type(field("Signal fulfilment-long-running", "Signal name"), "approve");
    await waitFor(() => editorArea("Arguments") !== null, "the editor");
    await writeCode('["tester", 2]');
    expect(isDisabled(dialogButton("Signal fulfilment-long-running", "Send signal"))).toBe(false);
    await click(dialogButton("Signal fulfilment-long-running", "Send signal"));
    await waitFor(() => wf.signal.mock.calls.length === 1, "the call");
    expect(wf.signal.mock.calls[0]![0]).toEqual({ connId: "conn-1", namespace: "lab", workflowId: "fulfilment-long-running", runId: RUN, signalName: "approve", args: ["tester", 2] });
    await waitFor(() => dialogWith("Signal fulfilment-long-running") === null, "the dialog to close");
  });

  test("a signal with invalid JSON cannot be sent", async () => {
    const { wf } = setup();
    await ready();
    await click(byRole("button", "Signal"));
    await waitFor(() => editorArea("Arguments") !== null, "the editor");
    await type(field("Signal fulfilment-long-running", "Signal name"), "approve");
    await writeCode("{oops");
    expect(isDisabled(dialogButton("Signal fulfilment-long-running", "Send signal"))).toBe(true);
    expect(wf.signal).not.toHaveBeenCalled();
  });

  test("Cancel is a plain confirmation that names the workflow; the reason is optional", async () => {
    const { wf } = setup();
    await ready();
    await click(byRole("button", "Request cancellation"));
    await waitFor(() => dialogWith("Request cancellation of fulfilment-long-running?") !== null, "the dialog");
    await type(field("Request cancellation", "Reason"), "no longer needed");
    await click(dialogButton("Request cancellation of", "Request cancellation"));
    await waitFor(() => wf.cancel.mock.calls.length === 1, "the call");
    expect(wf.cancel.mock.calls[0]![0]).toMatchObject({ workflowId: "fulfilment-long-running", runId: RUN, reason: "no longer needed" });
  });

  test("Terminate needs a reason before it can be confirmed", async () => {
    const { wf } = setup();
    await ready();
    await fromMenu(/^Terminate/);
    await waitFor(() => dialogWith("Terminate fulfilment-long-running?") !== null, "the dialog");
    expect(dialogWith("Terminate fulfilment-long-running?")!.textContent).toContain("cannot be undone");
    expect(isDisabled(dialogButton("Terminate fulfilment-long-running?", "Terminate"))).toBe(true);
    await type(field("Terminate fulfilment-long-running?", "Reason"), "   ");
    expect(isDisabled(dialogButton("Terminate fulfilment-long-running?", "Terminate"))).toBe(true);
    await type(field("Terminate fulfilment-long-running?", "Reason"), "bad deploy");
    await click(dialogButton("Terminate fulfilment-long-running?", "Terminate"));
    await waitFor(() => wf.terminate.mock.calls.length === 1, "the call");
    expect(wf.terminate.mock.calls[0]![0]).toMatchObject({ reason: "bad deploy", runId: RUN });
  });

  test("Reset offers the latest completed workflow task, asks for a reason, and shows the new run", async () => {
    const { wf, openTab } = setup();
    await ready();
    await fromMenu(/^Reset/);
    await waitFor(() => dialogWith("Reset fulfilment-long-running?") !== null, "the dialog");
    // The picker starts on the latest WorkflowTaskCompleted (event 8).
    expect(dialogWith("Reset fulfilment-long-running?")!.textContent).toContain("#8 WorkflowTaskCompleted");
    expect(isDisabled(dialogButton("Reset fulfilment-long-running?", "Reset"))).toBe(true);
    await type(field("Reset fulfilment-long-running?", "Reason"), "retry from the start");
    await click(dialogButton("Reset fulfilment-long-running?", "Reset"));
    await waitFor(() => wf.reset.mock.calls.length === 1, "the call");
    expect(wf.reset.mock.calls[0]![0]).toEqual({ connId: "conn-1", namespace: "lab", workflowId: "fulfilment-long-running", runId: RUN, eventId: 8, reapply: "all", reason: "retry from the start" });
    await waitFor(() => byText("A new run started") !== null, "the new run notice");
    await click(byRole("button", "Open new run"));
    expect(openTab).toHaveBeenCalledWith({ kind: "temporal.workflow", params: { namespace: "lab", workflowId: "fulfilment-long-running", runId: "0190ffff-new-run" }, title: "fulfilment-long-running" });
  });

  test("a failing action stays open with the server's message and Retry", async () => {
    const closed = new RpcError("FailedPrecondition", "workflow execution already completed", { details: { kind: "Conflict", system: "temporal", message: "workflow execution already completed", retryable: false } });
    const { wf } = setup({ fail: closed });
    await ready();
    await fromMenu(/^Terminate/);
    await waitFor(() => dialogWith("Terminate fulfilment-long-running?") !== null, "the dialog");
    await type(field("Terminate fulfilment-long-running?", "Reason"), "x");
    await click(dialogButton("Terminate fulfilment-long-running?", "Terminate"));
    await waitFor(() => dialogWith("workflow execution already completed") !== null, "the error in the dialog");
    expect(wf.terminate).toHaveBeenCalledTimes(1);
    expect(dialogWith("Terminate fulfilment-long-running?")).not.toBeNull();
  });

  test("a closed workflow cannot be signalled, cancelled or terminated; it can still be reset", async () => {
    setup({ status: "Completed" });
    await waitFor(() => byRole("tab", "Queries") !== null && byRole("button", "Signal") !== null, "the loaded tab");
    for (const name of ["Signal", "Request cancellation"]) expect(isDisabled(byRole("button", name)), name).toBe(true);
    await click(byRole("button", "More actions"));
    await waitFor(() => byRole("menuitem", /^Reset/) !== null, "the overflow menu");
    expect(isDisabled(byRole("menuitem", /^Terminate/))).toBe(true);
    expect(isDisabled(byRole("menuitem", /^Reset/))).toBe(false);
  });
});

describe("Queries (spec §9.3)", () => {
  test("runs a query with arguments and shows the decoded result; suggestions come from the metadata", async () => {
    const { wf } = setup();
    wf.query.mockImplementation(async (input: { queryType: string }) => (input.queryType === "__temporal_workflow_metadata" ? { result: { definition: { queryDefinitions: [{ name: "status" }] } } } : { result: { state: "approved by tester" } }));
    await ready();
    await click(byRole("tab", "Queries"));
    await waitFor(() => document.querySelector("datalist option[value=status]") !== null, "the suggestions");
    expect(document.querySelector("datalist option[value='__stack_trace']")).not.toBeNull();
    const queryType = document.querySelector<HTMLInputElement>("input[list]")!;
    await type(queryType, "status");
    await waitFor(() => editorArea("Arguments") !== null, "the editor");
    await writeCode('["x"]');
    await click(byRole("button", "Run query"));
    await waitFor(() => byText(/approved by tester/) !== null || document.body.textContent?.includes("approved by tester") === true, "the result");
    const ask = wf.query.mock.calls.map((c) => c[0] as unknown as Record<string, unknown>).find((c) => c["queryType"] === "status")!;
    expect(ask).toMatchObject({ connId: "conn-1", namespace: "lab", runId: RUN, args: ["x"] });
  });

  test("a failing query shows its error and keeps the form", async () => {
    const { wf } = setup();
    const unknown = new RpcError("InvalidArgument", "unknown queryType nope", { details: { kind: "Invalid", system: "temporal", message: "unknown queryType nope", retryable: false } });
    wf.query.mockImplementation(async (input: { queryType: string }) => {
      if (input.queryType === "nope") throw unknown;
      return { result: null };
    });
    await ready();
    await click(byRole("tab", "Queries"));
    await type(document.querySelector<HTMLInputElement>("input[list]")!, "nope");
    await click(byRole("button", "Run query"));
    await waitFor(() => byText(/unknown queryType nope/) !== null, "the error");
    expect(document.querySelector<HTMLInputElement>("input[list]")!.value).toBe("nope");
  });
});
