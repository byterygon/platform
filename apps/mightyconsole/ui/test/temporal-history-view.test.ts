// The History view's reading of a history (TSK-91 mockup frame temporal-history): folded workflow
// tasks, pairs, summaries as the mockup writes them, counts, the search and the CLI's JSON shape.
import { describe, expect, test } from "vitest";
import type { EventCategory, HistoryEvent } from "@/gen/api";
import { clockText } from "@/tools/temporal/history";
import { categoryCounts, groupSummary, historyJson, historyRows, historySummary, isFailure, pairsOf, sinceStart, summaryContext } from "@/tools/temporal/history-view";

const T0 = Date.parse("2026-11-18T09:42:07.112Z");
let id = 0;
const ev = (eventType: string, atMs: number, category: EventCategory, attributes: Record<string, unknown> = {}): HistoryEvent => ({ eventId: ++id, eventTime: new Date(T0 + atMs).toISOString(), eventType, category, attributes });

function order(): HistoryEvent[] {
  id = 0;
  return [
    ev("WorkflowExecutionStarted", 0, "Workflow", { workflowType: { name: "OrderWorkflow" }, taskQueue: { name: "orders" }, input: [{ orderId: "48213" }] }), // 1
    ev("WorkflowTaskScheduled", 2, "WorkflowTask"), // 2
    ev("WorkflowTaskStarted", 40, "WorkflowTask", { identity: "orders-7f9c@host-3" }), // 3
    ev("WorkflowTaskCompleted", 78, "WorkflowTask"), // 4
    ev("ActivityTaskScheduled", 77, "Activity", { activityType: { name: "ReserveInventory" }, activityId: "5" }), // 5
    ev("ActivityTaskStarted", 90, "Activity", { scheduledEventId: 5, attempt: 1 }), // 6
    ev("ActivityTaskCompleted", 1760, "Activity", { scheduledEventId: 5, startedEventId: 6, result: ["ok"] }), // 7
    ev("TimerStarted", 1840, "Timer", { timerId: "payment-window", startToFireTimeout: "1800s" }), // 8
    ev("ActivityTaskScheduled", 1840, "Activity", { activityType: { name: "ChargePayment" }, activityId: "12" }), // 9
    ev("WorkflowExecutionSignaled", 82_892, "Signal", { signalName: "customerConfirmed", input: [true] }), // 10
    ev("ActivityTaskScheduled", 82_960, "Activity", { activityType: { name: "SendReceipt" }, activityId: "18" }), // 11
    ev("ActivityTaskStarted", 82_976, "Activity", { scheduledEventId: 11, attempt: 2 }), // 12
    ev("ActivityTaskFailed", 94_790, "Activity", { scheduledEventId: 11, startedEventId: 12, failure: { message: "relay refused the connection", applicationFailureInfo: { type: "SmtpUnavailable", nonRetryable: true } } }), // 13
  ];
}

const pending = [{ activityId: "12", attempt: 3, maximumAttempts: 5 }];

describe("History view", () => {
  test("summaries read as the mockup writes them", () => {
    const events = order();
    const ctx = summaryContext(events, pending);
    const s = (n: number) => historySummary(events[n - 1]!, ctx);
    expect(s(1)).toBe("OrderWorkflow · task queue orders · input 1 payload");
    expect(s(5)).toBe("ReserveInventory");
    expect(s(7)).toBe("ReserveInventory · 1.68 s · result 1 payload");
    expect(s(8)).toBe(`payment-window · 30m · fires ${clockText(T0 + 1840 + 1_800_000)}`);
    expect(s(9)).toBe("ChargePayment · pending, attempt 3 of 5");
    expect(s(10)).toBe("customerConfirmed · 1 payload");
    expect(s(12)).toBe("SendReceipt · attempt 2");
    expect(s(13)).toBe("SendReceipt · SmtpUnavailable · non-retryable");
  });

  test("each Scheduled points to its close and back; Started points to the close too", () => {
    const pairs = pairsOf(order());
    expect(pairs.get(5)).toEqual({ to: 7, direction: "next" });
    expect(pairs.get(7)).toEqual({ to: 5, direction: "previous" });
    expect(pairs.get(11)).toEqual({ to: 13, direction: "next" });
    expect(pairs.get(12)).toEqual({ to: 13, direction: "next" });
    expect(pairs.get(13)).toEqual({ to: 11, direction: "previous" });
    // An open activity and a timer that has not fired have no pair yet.
    expect(pairs.has(9)).toBe(false);
    expect(pairs.has(8)).toBe(false);
  });

  test("workflow tasks fold into one row, open on request; a search or a category shows events flat", () => {
    const events = order();
    const ctx = summaryContext(events, pending);
    const base = { category: "All" as const, fold: true, expanded: new Set<number>(), query: "", ctx };
    const rows = historyRows(events, base);
    expect(rows.map((r) => (r.kind === "group" ? `g${r.first}-${r.last}` : r.event.eventId))).toEqual([1, "g2-4", 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    const group = rows[1]!;
    expect(group.kind === "group" && groupSummary(group.events)).toBe("3 events · 76 ms · worker orders-7f9c@host-3");
    expect(historyRows(events, { ...base, expanded: new Set([2]) }).length).toBe(rows.length + 3);
    expect(historyRows(events, { ...base, fold: false }).length).toBe(13);
    expect(historyRows(events, { ...base, category: "Activity" }).map((r) => (r.kind === "event" ? r.event.eventId : 0))).toEqual([5, 6, 7, 9, 11, 12, 13]);
    // The search reads types, summaries and the decoded attributes.
    expect(historyRows(events, { ...base, query: "48213" }).map((r) => (r.kind === "event" ? r.event.eventId : 0))).toEqual([1]);
    expect(historyRows(events, { ...base, query: "smtpunavailable" }).map((r) => (r.kind === "event" ? r.event.eventId : 0))).toEqual([13]);
  });

  test("counts, failures and the time since the start", () => {
    const events = order();
    expect(categoryCounts(events)).toMatchObject({ All: 13, Workflow: 1, WorkflowTask: 3, Activity: 7, Timer: 1, Signal: 1, Marker: 0 });
    expect(events.filter(isFailure).map((e) => e.eventId)).toEqual([13]);
    expect(sinceStart(T0, T0)).toBe("+0 ms");
    expect(sinceStart(T0 + 1760, T0)).toBe("+1.76 s");
    expect(sinceStart(T0 + 82_892, T0)).toBe("+1m 23s");
  });

  test("the download is the CLI's shape: { events } with each type's attributes under its own key", () => {
    const json = JSON.parse(historyJson(order().slice(0, 1))) as { events: Record<string, unknown>[] };
    expect(json.events[0]).toMatchObject({ eventId: "1", eventType: "WorkflowExecutionStarted", workflowExecutionStartedEventAttributes: { taskQueue: { name: "orders" } } });
  });
});
