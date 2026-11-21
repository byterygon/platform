// A workflow's history read for the screens (Mightyconsole spec §9.3): Timeline lanes and items,
// summaries, input and result, the failure chain.
import { describe, expect, test } from "vitest";
import type { EventCategory, HistoryEvent } from "@/gen/api";
import { buildTimeline, clockText, eventSummary, eventTitle, failureChain, inputAndResult, isClosed, itemEventId, spanText } from "@/tools/temporal/history";

let id = 0;
const T0 = Date.parse("2026-11-18T01:00:00Z");
const ev = (eventType: string, atMs: number, attributes: Record<string, unknown> = {}, category: EventCategory = "Other"): HistoryEvent => ({
  eventId: ++id,
  eventTime: new Date(T0 + atMs).toISOString(),
  eventType,
  category,
  attributes,
  size: 0,
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
  test("one lane per thing, in the order of its first event, with its kind and first event", () => {
    const { lanes, counts } = buildTimeline(history(), { workflowId: "order-1", now: T0 + 3000 });
    expect(lanes.map((l) => [l.label, l.detail, l.kind])).toEqual([
      ["order-1", "workflow", "workflow"],
      ["Workflow tasks", "1 task", "workflowTask"],
      ["charge", "activity 3", "activity"],
      ["t1", "timer 6", "timer"],
      ["approve", "signal 7", "signal"],
      ["n-1", "child 9", "child"],
      ["ship", "activity 11", "activity"],
    ]);
    expect(counts).toMatchObject({ activity: 2, timer: 1, signal: 1, child: 1, workflowTask: 1, marker: 0, update: 0 });
  });

  test("items are shaped and captioned by kind; open ones run to now", () => {
    const { items, info } = buildTimeline(history(), { workflowId: "order-1", now: T0 + 3000 });
    const by = (label: string) => items.find((i) => i.label === label)!;
    expect(by("order-1")).toMatchObject({ status: "running", end: null, caption: "Running · 3 s" });
    expect(by("Workflow task 2")).toMatchObject({ shape: "tick" });
    expect(by("charge")).toMatchObject({ status: "success", caption: "800 ms" });
    expect(info.get(by("charge").id)).toMatchObject({ state: "Completed", attempt: 3, firstEventId: 3, lastEventId: 5 });
    expect(by("Timer t1")).toMatchObject({ shape: "dashed", status: "neutral", caption: "Canceled after 150 ms" });
    expect(by("Signal approve")).toMatchObject({ shape: "diamond", start: T0 + 1000, end: T0 + 1000, caption: `${clockText(T0 + 1000, true)} · 1 payload` });
    expect(by("n-1")).toMatchObject({ status: "success", caption: "Completed · 700 ms" });
    expect(by("ship")).toMatchObject({ status: "running", end: null, caption: "Scheduled · 1 s so far" });
  });

  test("an open activity past its first attempt is drawn retrying, with its attempt and last failure", () => {
    const pending = [{ activityId: "7", attempt: 3, maximumAttempts: 5, state: "PENDING_ACTIVITY_STATE_SCHEDULED", lastFailure: { message: "the payment provider is down", applicationFailureInfo: { type: "ProviderDown" } } }];
    id = 0;
    const events = [ev("WorkflowExecutionStarted", 0), ev("ActivityTaskScheduled", 10, { activityType: { name: "ChargePayment" }, activityId: "7" })];
    const { items, info } = buildTimeline(events, { pending, now: T0 + 122_010 });
    const charge = items.find((i) => i.label === "ChargePayment")!;
    expect(charge).toMatchObject({ shape: "hatched", status: "warning", caption: "Retrying · attempt 3 of 5 · 2m 2s so far" });
    expect(info.get(charge.id)!.failure).toEqual({ type: "ProviderDown", message: "the payment provider is down", nonRetryable: false });
  });

  test("a closing event ends the workflow's bar with its status", () => {
    const closed = (type: string) => {
      const events = history();
      events.push(ev(type, 3000, {}, "Workflow"));
      return buildTimeline(events).items.find((i) => i.laneId === "workflow")!;
    };
    expect(closed("WorkflowExecutionCompleted")).toMatchObject({ status: "success", end: T0 + 3000, caption: "Completed · 3 s" });
    expect(closed("WorkflowExecutionFailed").status).toBe("danger");
    expect(closed("WorkflowExecutionTimedOut").status).toBe("warning");
    expect(closed("WorkflowExecutionCanceled").status).toBe("neutral");
    expect(closed("WorkflowExecutionContinuedAsNew").status).toBe("info");
  });

  test("a failed or timed out activity says so, with the failure for the strip", () => {
    id = 0;
    const events = [
      ev("WorkflowExecutionStarted", 0, { workflowType: { name: "W" } }),
      ev("ActivityTaskScheduled", 10, { activityType: { name: "a" } }),
      ev("ActivityTaskFailed", 11_810, { scheduledEventId: 2, failure: { message: "relay refused the connection", applicationFailureInfo: { type: "SmtpUnavailable", nonRetryable: true } } }),
      ev("ActivityTaskScheduled", 12_000, { activityType: { name: "b" } }),
      ev("ActivityTaskTimedOut", 12_040, { scheduledEventId: 4 }),
    ];
    const { lanes, items, info } = buildTimeline(events);
    const acts = items.filter((i) => i.laneId.startsWith("activity:"));
    expect(acts.map((i) => [i.status, i.caption])).toEqual([["danger", "Failed · 11.8 s"], ["warning", "Timed out · 40 ms"]]);
    expect(info.get(acts[0]!.id)!.failure).toEqual({ type: "SmtpUnavailable", message: "relay refused the connection", nonRetryable: true });
    expect(lanes.map((l) => l.kind)).toEqual(["workflow", "activity", "activity"]);
  });

  test("signals and markers share a lane by name and count every event", () => {
    id = 0;
    const events = [
      ev("WorkflowExecutionStarted", 0),
      ev("WorkflowExecutionSignaled", 10, { signalName: "poke", input: [] }),
      ev("WorkflowExecutionSignaled", 20, { signalName: "poke", input: [1, 2] }),
      ev("MarkerRecorded", 30, { markerName: "SideEffect" }),
    ];
    const { lanes, items, counts } = buildTimeline(events);
    expect(lanes.map((l) => [l.label, l.detail])).toEqual([["Workflow", "workflow"], ["poke", "2 signals"], ["SideEffect", "marker 4"]]);
    expect(items.filter((i) => i.shape === "diamond").map((i) => i.caption?.split(" · ")[1])).toEqual(["0 payloads", "2 payloads"]);
    expect(items.find((i) => i.shape === "pin")).toMatchObject({ label: "Marker SideEffect" });
    expect(counts).toMatchObject({ signal: 2, marker: 1 });
  });

  test("an empty history has no lanes", () => {
    const { lanes, items } = buildTimeline([]);
    expect(lanes).toEqual([]);
    expect(items).toEqual([]);
  });

  test("durations read as the mockup writes them", () => {
    expect(spanText(850)).toBe("850 ms");
    expect(spanText(1670)).toBe("1.67 s");
    expect(spanText(11_800)).toBe("11.8 s");
    expect(spanText(724_000)).toBe("12m 4s");
    expect(spanText(1_800_000)).toBe("30m");
    expect(spanText(7_500_000)).toBe("2h 5m");
    expect(spanText(-1)).toBe("");
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
