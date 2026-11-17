// A workflow's history read for the screens (Mightyconsole spec §9.3): Timeline lanes and items,
// summaries, input and result, the failure chain.
import { describe, expect, test } from "vitest";
import type { EventCategory, HistoryEvent } from "@/gen/api";
import { buildTimeline, eventSummary, eventTitle, failureChain, inputAndResult, isClosed, itemEventId } from "@/tools/temporal/history";

let id = 0;
const T0 = Date.parse("2026-11-18T01:00:00Z");
const ev = (eventType: string, atMs: number, attributes: Record<string, unknown> = {}, category: EventCategory = "Other"): HistoryEvent => ({
  eventId: ++id,
  eventTime: new Date(T0 + atMs).toISOString(),
  eventType,
  category,
  attributes,
});

function history(): HistoryEvent[] {
  id = 0;
  return [
    ev("WorkflowExecutionStarted", 0, { workflowType: { name: "Order" }, taskQueue: { name: "orders" }, input: ["o-1"] }, "Workflow"), // 1
    ev("WorkflowTaskScheduled", 1, {}, "WorkflowTask"), // 2
    ev("ActivityTaskScheduled", 100, { activityType: { name: "charge" }, activityId: "1" }, "Activity"), // 3
    ev("ActivityTaskStarted", 120, { scheduledEventId: 3, attempt: 3 }, "Activity"), // 4
    ev("ActivityTaskCompleted", 900, { scheduledEventId: 3, startedEventId: 4, result: ["ok"] }, "Activity"), // 5
    ev("TimerStarted", 950, { timerId: "t1", startToFireTimeout: "5s" }, "Timer"), // 6
    ev("WorkflowExecutionSignaled", 1000, { signalName: "approve", input: ["me"] }, "Signal"), // 7
    ev("TimerCanceled", 1100, { timerId: "t1", startedEventId: 6 }, "Timer"), // 8
    ev("StartChildWorkflowExecutionInitiated", 1200, { workflowType: { name: "Notify" }, workflowId: "n-1" }, "ChildWorkflow"), // 9
    ev("ChildWorkflowExecutionCompleted", 1900, { initiatedEventId: 9, result: [] }, "ChildWorkflow"), // 10
    ev("ActivityTaskScheduled", 2000, { activityType: { name: "ship" } }, "Activity"), // 11
  ];
}

describe("buildTimeline", () => {
  test("pairs activities, timers and children with their ends; the rest stay open", () => {
    const { lanes, items } = buildTimeline(history());
    expect(lanes.map((l) => l.id)).toEqual(["workflow", "activities", "timers", "children", "signals"]);
    const by = (label: string) => items.find((i) => i.label.startsWith(label))!;
    const charge = by("charge");
    expect(charge).toMatchObject({ laneId: "activities", status: "success", label: "charge (attempt 3)" });
    expect(charge.end! - charge.start).toBe(800);
    expect(by("Timer t1")).toMatchObject({ status: "neutral", laneId: "timers" });
    expect(by("Notify")).toMatchObject({ status: "success", laneId: "children" });
    expect(by("ship")).toMatchObject({ status: "running", end: null });
    expect(by("Signal approve")).toMatchObject({ laneId: "signals", start: T0 + 1000, end: T0 + 1000 });
    expect(by("Order")).toMatchObject({ status: "running", end: null });
  });

  test("a closing event ends the workflow's bar with its status", () => {
    const closed = (type: string) => {
      const events = history();
      events.push(ev(type, 3000, {}, "Workflow"));
      return buildTimeline(events).items.find((i) => i.laneId === "workflow")!;
    };
    expect(closed("WorkflowExecutionCompleted")).toMatchObject({ status: "success", end: T0 + 3000 });
    expect(closed("WorkflowExecutionFailed").status).toBe("danger");
    expect(closed("WorkflowExecutionTimedOut").status).toBe("warning");
    expect(closed("WorkflowExecutionCanceled").status).toBe("neutral");
    expect(closed("WorkflowExecutionContinuedAsNew").status).toBe("info");
  });

  test("a failed or timed out activity says so; lanes without items are left out", () => {
    id = 0;
    const events = [
      ev("WorkflowExecutionStarted", 0, { workflowType: { name: "W" } }),
      ev("ActivityTaskScheduled", 10, { activityType: { name: "a" } }),
      ev("ActivityTaskFailed", 20, { scheduledEventId: 2, failure: { message: "boom" } }),
      ev("ActivityTaskScheduled", 30, { activityType: { name: "b" } }),
      ev("ActivityTaskTimedOut", 40, { scheduledEventId: 4 }),
    ];
    const { lanes, items } = buildTimeline(events);
    expect(items.filter((i) => i.laneId === "activities").map((i) => i.status)).toEqual(["danger", "warning"]);
    expect(lanes.map((l) => l.id)).toEqual(["workflow", "activities"]);
  });

  test("an empty history has no lanes", () => {
    expect(buildTimeline([])).toEqual({ lanes: [], items: [] });
  });

  test("an item names its event", () => {
    expect(itemEventId("e12")).toBe(12);
    expect(itemEventId("nope")).toBeNull();
  });
});

describe("summaries", () => {
  test("say what the event concerns", () => {
    const events = history();
    const summary = (n: number) => eventSummary(events[n - 1]!);
    expect(summary(1)).toBe("Order on orders");
    expect(summary(3)).toBe("charge id 1");
    expect(summary(4)).toBe("attempt 3");
    expect(summary(6)).toBe("t1 fires in 5s");
    expect(summary(7)).toBe("approve");
    expect(summary(9)).toBe("Notify id n-1");
    expect(eventSummary(ev("ActivityTaskFailed", 0, { failure: { message: "boom" } }))).toBe("boom");
    expect(eventSummary(ev("SomethingNew", 0))).toBe("");
  });

  test("titles split the CamelCase type", () => {
    expect(eventTitle("ActivityTaskScheduled")).toBe("Activity task scheduled");
  });
});

describe("input and result", () => {
  test("reads input from the start and the result from the close", () => {
    const events = history();
    events.push(ev("WorkflowExecutionCompleted", 3000, { result: ["done"] }, "Workflow"));
    expect(inputAndResult(events)).toMatchObject({ input: ["o-1"], result: ["done"], closedBy: "WorkflowExecutionCompleted" });
    expect(isClosed(events)).toBe(true);
    expect(isClosed(history())).toBe(false);
  });

  test("a running workflow has an input and no result", () => {
    const out = inputAndResult(history());
    expect(out.input).toEqual(["o-1"]);
    expect("result" in out).toBe(false);
    expect(out.closedBy).toBeUndefined();
  });

  test("a failed one keeps its failure, and the chain is outermost first", () => {
    const failure = { message: "Activity task failed", cause: { message: "order o-1 was rejected", applicationFailureInfo: { type: "Rejected" }, stackTrace: "at x" } };
    const events = [...history(), ev("WorkflowExecutionFailed", 3000, { failure }, "Workflow")];
    const out = inputAndResult(events);
    expect(out.closedBy).toBe("WorkflowExecutionFailed");
    expect(failureChain(out.failure)).toEqual([{ message: "Activity task failed" }, { message: "order o-1 was rejected", type: "Rejected", stackTrace: "at x" }]);
    expect(failureChain(undefined)).toEqual([]);
  });

  test("memo and search attributes come from the start event", () => {
    id = 0;
    const out = inputAndResult([ev("WorkflowExecutionStarted", 0, { input: [], memo: { fields: { note: "hi" } }, searchAttributes: { indexedFields: { CustomKeyword: "x" } } })]);
    expect(out.memo).toEqual({ note: "hi" });
    expect(out.searchAttributes).toEqual({ CustomKeyword: "x" });
  });
});
