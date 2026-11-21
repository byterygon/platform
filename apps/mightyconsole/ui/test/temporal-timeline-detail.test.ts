// The Timeline's details pane (Mightyconsole spec §9.3, TSK-100): what a selected item stands for,
// read from its own events, as the mockup frame `temporal-timeline` shows it.
import { describe, expect, test } from "vitest";
import type { EventCategory, HistoryEvent } from "@/gen/api";
import { buildTimeline, clockText } from "@/tools/temporal/history";
import { failureText, itemDetail, retryWords } from "@/tools/temporal/timeline-detail";

const T0 = Date.parse("2026-11-18T10:42:07.112Z");
let id = 0;
const ev = (eventType: string, atMs: number, attributes: Record<string, unknown> = {}, category: EventCategory = "Other"): HistoryEvent => ({
  eventId: ++id,
  eventTime: new Date(T0 + atMs).toISOString(),
  eventType,
  category,
  attributes,
  size: 0,
});

const smtpFailure = {
  message: "SmtpUnavailable",
  stackTrace: "at sendMail (notify/smtp.ts:52:13)\nat run (notify/index.ts:9:3)",
  applicationFailureInfo: { type: "ApplicationError", nonRetryable: true },
  cause: { message: "relay smtp-1:587 refused the connection" },
};

function history(): HistoryEvent[] {
  id = 0;
  return [
    ev("WorkflowExecutionStarted", 0, { workflowType: { name: "OrderWorkflow" }, taskQueue: { name: "orders" } }, "Workflow"), // 1
    ev("ActivityTaskScheduled", 72_960, { activityType: { name: "SendReceipt" }, activityId: "18", taskQueue: { name: "notifications" }, retryPolicy: { initialInterval: "1s", backoffCoefficient: 2, maximumAttempts: 3 }, input: [{ orderId: "48213" }] }, "Activity"), // 2
    ev("ActivityTaskStarted", 72_976, { scheduledEventId: 2, identity: "notify-6c2a@host-2", attempt: 2 }, "Activity"), // 3
    ev("ActivityTaskFailed", 84_790, { scheduledEventId: 2, startedEventId: 3, failure: smtpFailure }, "Activity"), // 4
    ev("TimerStarted", 1000, { timerId: "payment-window", startToFireTimeout: "1800s" }, "Timer"), // 5
    ev("WorkflowExecutionSignaled", 82_892, { signalName: "customerConfirmed", input: [{}], identity: "support-ticket-771" }, "Signal"), // 6
    ev("StartChildWorkflowExecutionInitiated", 90_000, { workflowType: { name: "ReceiptWorkflow" }, workflowId: "receipt-48213", taskQueue: { name: "orders" } }, "ChildWorkflow"), // 7
    ev("ChildWorkflowExecutionStarted", 90_050, { initiatedEventId: 7, workflowExecution: { workflowId: "receipt-48213", runId: "run-c1" } }, "ChildWorkflow"), // 8
    ev("ActivityTaskScheduled", 95_000, { activityType: { name: "ChargePayment" }, activityId: "12" }, "Activity"), // 9
  ];
}

describe("retryWords and failureText", () => {
  test("a policy reads as the mockup writes it", () => {
    expect(retryWords({ initialInterval: "1s", backoffCoefficient: 2, maximumAttempts: 3 })).toBe("3 attempts · backoff 2 × from 1 s");
    expect(retryWords({ maximumAttempts: 0, maximumInterval: "100s", nonRetryableErrorTypes: ["Invalid"] })).toBe("unlimited attempts · at most 1m 40s apart · not retried: Invalid");
    expect(retryWords(undefined)).toBe("");
  });

  test("a failure chain with its stacks, the first marked non-retryable", () => {
    expect(failureText(smtpFailure)).toBe("ApplicationError: SmtpUnavailable (non-retryable)\n  at sendMail (notify/smtp.ts:52:13)\n  at run (notify/index.ts:9:3)\nCaused by: relay smtp-1:587 refused the connection");
  });
});

describe("itemDetail", () => {
  const events = history();
  const byId = new Map(events.map((e) => [e.eventId, e]));
  const now = T0 + 120_000;
  const data = buildTimeline(events, { workflowId: "order-48213", now });
  const of = (eventId: number) => data.info.get(data.itemOfEvent.get(eventId)!)!;

  test("every event of an item is listed, and an event leads to its item", () => {
    expect(of(2).eventIds).toEqual([2, 3, 4]);
    expect(data.itemOfEvent.get(4)).toBe("e2");
    expect(of(8).eventIds).toEqual([7, 8]);
    expect(of(1).kind).toBe("workflow");
  });

  test("a failed activity: its times with the wait, the worker, the retry policy and the failure", () => {
    const d = itemDetail(of(2), byId, [], now);
    expect(d.title).toBe("SendReceipt · activity 2");
    expect(d.copy).toEqual({ value: "18", what: "activity ID" });
    expect(d.context).toEqual(["task queue notifications", "attempt 2 of 3", "non-retryable"]);
    expect(d.facts.map((f) => [f.label, f.value])).toEqual([
      ["Scheduled", clockText(T0 + 72_960, true)],
      ["Started", `${clockText(T0 + 72_976, true)} · waited 16 ms`],
      ["Failed", `${clockText(T0 + 84_790, true)} · ran 11.8 s`],
      ["Worker", "notify-6c2a@host-2"],
      ["Retry policy", "3 attempts · backoff 2 × from 1 s"],
    ]);
    expect(d.facts.find((f) => f.label === "Worker")?.copy).toEqual({ value: "notify-6c2a@host-2", what: "worker identity" });
    expect(d.failure?.summary).toBe("ApplicationError: SmtpUnavailable");
    expect(d.failure?.text).toContain("Caused by: relay smtp-1:587");
    expect(d.events.map((e) => e.eventType)).toEqual(["ActivityTaskScheduled", "ActivityTaskStarted", "ActivityTaskFailed"]);
  });

  test("an open activity retrying: the pending attempt, last worker, next attempt and last failure", () => {
    const pending = [{ activityId: "12", attempt: 3, maximumAttempts: 5, lastStartedTime: new Date(T0 + 100_000).toISOString(), nextAttemptScheduleTime: new Date(T0 + 130_000).toISOString(), lastWorkerIdentity: "pay-1@host-3", lastFailure: { message: "the payment provider is down" } }];
    const data2 = buildTimeline(events, { pending, now });
    const d = itemDetail(data2.info.get("e9")!, byId, pending, now);
    expect(d.context).toEqual(["attempt 3 of 5"]);
    expect(Object.fromEntries(d.facts.map((f) => [f.label, f.value]))).toMatchObject({
      "Last started": `${clockText(T0 + 100_000, true)} · attempt 3`,
      "So far": "Retrying · 25 s",
      "Next attempt": `${clockText(T0 + 130_000, true)} · in 10 s`,
      Worker: "pay-1@host-3",
    });
    expect(d.failure?.text).toBe("the payment provider is down");
  });

  test("a waiting timer says when it fires; a signal who sent it; a child its run", () => {
    const timer = itemDetail(of(5), byId, [], now);
    expect(timer.copy).toEqual({ value: "payment-window", what: "timer ID" });
    expect(timer.context).toEqual(["30m timer"]);
    expect(timer.facts.find((f) => f.label === "Fires")?.value).toBe(`${clockText(T0 + 1000 + 1_800_000, true)} · in 28m 1s`);
    const signal = itemDetail(of(6), byId, [], now);
    expect(signal.context).toEqual(["1 payload"]);
    expect(signal.facts.map((f) => f.label)).toEqual(["Received", "Sent by"]);
    const child = itemDetail(of(7), byId, [], now);
    expect(child.copy).toEqual({ value: "receipt-48213", what: "workflow ID" });
    expect(child.workflow).toEqual({ workflowId: "receipt-48213", runId: "run-c1" });
    expect(child.facts.map((f) => f.label)).toEqual(["Initiated", "Started", "So far", "Run ID"]);
  });
});
