// The workflow tab of the Temporal tool (Mightyconsole spec §9.3) against a stub client: the
// header, the Timeline, the History table with its detail and filter, input and result, the
// pending activities, the stack trace, and the history followed live until the run closes.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { EventCategory, HistoryEvent, WorkflowDetail } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { WorkflowTab } from "@/tools/temporal/WorkflowTab";
import { splitLines } from "@/tools/temporal/useWorkflow";
import { profile as schema } from "@/tools/temporal/profile";
import type { LiveState, TabProps, TabRecord } from "@/tools/types";
import { axeViolations, byRole, byText, cleanup, click, render, settle, waitFor } from "./support/render";

afterEach(cleanup);

const T0 = Date.parse("2026-11-18T01:00:00Z");
const ev = (eventId: number, eventType: string, atMs: number, category: EventCategory, attributes: Record<string, unknown> = {}): HistoryEvent => ({
  eventId,
  eventTime: new Date(T0 + atMs).toISOString(),
  eventType,
  category,
  attributes,
});

const events: HistoryEvent[] = [
  ev(1, "WorkflowExecutionStarted", 0, "Workflow", { workflowType: { name: "Fulfilment" }, taskQueue: { name: "lab" }, input: ["ord-long"] }),
  ev(2, "WorkflowTaskScheduled", 1, "WorkflowTask", { taskQueue: { name: "lab" } }),
  ev(3, "ActivityTaskScheduled", 500, "Activity", { activityType: { name: "charge" }, activityId: "1" }),
  ev(4, "WorkflowExecutionSignaled", 800, "Signal", { signalName: "approve", input: ["me"] }),
];

const detail = (patch: Partial<WorkflowDetail> = {}, status: WorkflowDetail["workflow"]["status"] = "Running"): WorkflowDetail => ({
  workflow: { workflowId: "fulfilment-long-running", runId: "0190aaaa-bbbb-cccc-dddd-000000000001", workflowType: "Fulfilment", status, startTime: new Date(T0).toISOString(), taskQueue: "lab", historyLength: events.length },
  executionConfig: {},
  pendingActivities: [],
  pendingChildren: [],
  memo: {},
  searchAttributes: {},
  autoResetPoints: [],
  ...patch,
});

/** A followHistory call the test feeds by hand. */
function fakeStream() {
  const queue: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let cancelled = false;
  let resolve!: (v: { closed: boolean }) => void;
  const result = new Promise<{ closed: boolean }>((r) => (resolve = r));
  result.catch(() => {});
  const encoder = new TextEncoder();
  return {
    call: {
      result,
      cancel: () => {
        cancelled = true;
        wake?.();
      },
      async *chunks() {
        for (;;) {
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          if (finished || cancelled) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    },
    push(event: HistoryEvent) {
      queue.push(encoder.encode(`${JSON.stringify(event)}\n`));
      wake?.();
    },
    end(closed = true) {
      finished = true;
      resolve({ closed });
      wake?.();
    },
    get cancelled() {
      return cancelled;
    },
  };
}

interface Options {
  detail?: WorkflowDetail;
  events?: HistoryEvent[];
  query?: () => Promise<{ result: unknown }>;
  connId?: string | null;
}

function setup(options: Options = {}) {
  const stream = fakeStream();
  const describe = vi.fn(async (_input: unknown) => options.detail ?? detail());
  const history = vi.fn(async (_input: unknown) => ({ events: options.events ?? events }));
  const followHistory = vi.fn((_input: unknown, _options?: unknown) => stream.call);
  const query = vi.fn((_input: unknown) => (options.query ?? (async () => ({ result: "goroutine 1 [running]:\nwait_condition" })))());
  const client = { temporal: { workflows: { describe, history, followHistory, query } } } as unknown as MightyClient;
  const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const tab: TabRecord = { id: "t2", tool: "temporal", profileId: "01T", kind: "temporal.workflow", params: { namespace: "lab", workflowId: "fulfilment-long-running" }, title: "fulfilment-long-running", pinned: false };
  const lives: (LiveState | null)[] = [];
  const props: TabProps = {
    tab,
    profile,
    connId: options.connId === undefined ? "conn-1" : options.connId,
    client,
    active: true,
    useTabActions: () => {},
    onLive: (l) => lives.push(l),
    note: describeError,
    openTab: vi.fn(),
  };
  const view = render(<WorkflowTab {...props} />);
  return { describe, history, followHistory, query, stream, lives, openTab: props.openTab as ReturnType<typeof vi.fn>, ...view };
}

const tabButton = (name: string) => byRole("tab", name);

describe("splitLines", () => {
  test("keeps a partial line for the next chunk and drops blanks", () => {
    expect(splitLines("", '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], carry: '{"b"' });
    expect(splitLines('{"b"', ":2}\n\n")).toEqual({ lines: ['{"b":2}'], carry: "" });
  });
});

describe("Workflow tab (spec §9.3)", () => {
  test("shows the header and the Timeline, and follows an open run from its last event", async () => {
    const { describe: d, history, followHistory, container } = setup();
    await waitFor(() => byText("Fulfilment") !== null && container.querySelector('[data-slot="timeline"]') !== null, "the header and timeline");
    expect(d).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", workflowId: "fulfilment-long-running", runId: null });
    // The history is read for the run describe found, so the two cannot disagree.
    expect(history.mock.calls[0]![0]).toMatchObject({ runId: "0190aaaa-bbbb-cccc-dddd-000000000001", pageSize: 1000 });
    expect(byText("Running")).not.toBeNull();
    expect(byText("4 events")).not.toBeNull();
    await waitFor(() => followHistory.mock.calls.length === 1, "the follow");
    expect(followHistory.mock.calls[0]![0]).toMatchObject({ fromEventId: 4, workflowId: "fulfilment-long-running", runId: "0190aaaa-bbbb-cccc-dddd-000000000001" });
    expect(byText("Live")).not.toBeNull();
    const items = Array.from(container.querySelectorAll('[data-slot="timeline-item"]')).map((i) => i.getAttribute("aria-label"));
    expect(items.some((l) => l?.startsWith("Fulfilment, running"))).toBe(true);
    expect(items.some((l) => l?.startsWith("charge, running"))).toBe(true);
    expect(items.some((l) => l?.startsWith("Signal approve"))).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("events that arrive are added once, the run closing ends the follow", async () => {
    const { stream, describe: d, lives } = setup();
    await waitFor(() => byText("4 events") !== null, "the first load");
    const before = d.mock.calls.length;
    stream.push(ev(5, "ActivityTaskCompleted", 900, "Activity", { scheduledEventId: 3, result: ["charged"] }));
    stream.push(ev(5, "ActivityTaskCompleted", 900, "Activity", { scheduledEventId: 3 })); // a repeat
    await waitFor(() => byText("5 events") !== null, "the new event");
    stream.push(ev(6, "WorkflowExecutionCompleted", 1000, "Workflow", { result: ["done"] }));
    stream.end();
    await waitFor(() => byText("6 events") !== null && lives.some((l) => l?.status === "ended"), "the end");
    expect(byText("Live")).toBeNull();
    // The pending work and the status are asked again after the events.
    await waitFor(() => d.mock.calls.length > before, "a fresh describe");
  });

  test("History: a table of events, a category filter, and the attributes of the chosen row", async () => {
    const { container } = setup();
    await waitFor(() => tabButton("History") !== null, "the tabs");
    await click(tabButton("History"));
    await waitFor(() => container.querySelectorAll("table[aria-label='History events'] tbody tr:not([data-spacer])").length === 4, "four rows");
    const rows = () => Array.from(container.querySelectorAll("table[aria-label='History events'] tbody tr:not([data-spacer])"));
    expect(rows()[2]!.textContent).toContain("ActivityTaskScheduled");
    expect(rows()[2]!.textContent).toContain("charge id 1");
    expect(byText("Select an event.")).not.toBeNull();
    await click(rows()[0]!);
    await waitFor(() => byRole("tree", /Attributes of event 1/) !== null || container.querySelector("[role=tree]") !== null, "the attributes");
    expect(container.textContent).toContain("#1 WorkflowExecutionStarted");
  });

  test("Input and result: the input, and a running workflow has no result yet", async () => {
    const { container } = setup();
    await waitFor(() => tabButton("Input and result") !== null, "the tabs");
    await click(tabButton("Input and result"));
    await waitFor(() => byText("The workflow is still running.") !== null, "the empty result");
    expect(container.textContent).toContain("Input");
  });

  test("a failed workflow shows its failure chain with the stack", async () => {
    const failed = [...events, ev(5, "WorkflowExecutionFailed", 1000, "Workflow", { failure: { message: "Workflow failed", cause: { message: "order ord-bad was rejected", applicationFailureInfo: { type: "Rejected" }, stackTrace: "at charge()" } } })];
    setup({ events: failed, detail: detail({}, "Failed") });
    await waitFor(() => tabButton("Input and result") !== null, "the tabs");
    await click(tabButton("Input and result"));
    await waitFor(() => byText("Failure") !== null, "the failure");
    expect(document.body.textContent).toContain("order ord-bad was rejected");
    expect(document.body.textContent).toContain("Rejected");
    expect(document.body.textContent).toContain("at charge()");
  });

  test("Pending: activities with their state, attempt and last failure; children open their own tab", async () => {
    const pending = detail({
      pendingActivities: [{ activityId: "1", activityType: { name: "flaky" }, state: "PENDING_ACTIVITY_STATE_SCHEDULED", attempt: 4, maximumAttempts: 0, lastFailure: { message: "the payment provider is down" } }],
      pendingChildren: [{ workflowId: "child-1", runId: "abcdef12-0000", workflowTypeName: "Completed", parentClosePolicy: "PARENT_CLOSE_POLICY_TERMINATE" }],
    });
    const { openTab } = setup({ detail: pending });
    await waitFor(() => tabButton("Pending") !== null, "the tabs");
    await click(tabButton("Pending"));
    await waitFor(() => byText("flaky") !== null, "the pending activity");
    const row = byText("flaky")!.closest("tr")!;
    expect(row.textContent).toContain("Scheduled");
    expect(row.textContent).toContain("4");
    expect(row.textContent).toContain("the payment provider is down");
    await click(byRole("button", "child-1"));
    expect(openTab).toHaveBeenCalledWith({ kind: "temporal.workflow", params: { namespace: "lab", workflowId: "child-1", runId: "abcdef12-0000" }, title: "child-1" });
  });

  test("Stack trace: asked of the worker when the tab is shown", async () => {
    const { query } = setup();
    await waitFor(() => tabButton("Stack trace") !== null, "the tabs");
    await click(tabButton("Stack trace"));
    await waitFor(() => query.mock.calls.length === 1, "the query");
    expect(query.mock.calls[0]![0]).toMatchObject({ queryType: "__stack_trace", workflowId: "fulfilment-long-running" });
    await waitFor(() => document.body.textContent?.includes("wait_condition") === true, "the stack");
  });

  test("Stack trace: no worker is said in words, not as a failure", async () => {
    const timeout = new RpcError("Unavailable", "the Temporal frontend did not answer in time", { details: { kind: "Connect", system: "temporal", message: "x", retryable: true } });
    setup({ query: () => Promise.reject(timeout) });
    await waitFor(() => tabButton("Stack trace") !== null, "the tabs");
    await click(tabButton("Stack trace"));
    await waitFor(() => byText(/No worker answered/) !== null, "the message");
  });

  test("a closed workflow has no stream and no stack trace", async () => {
    const closed = [...events, ev(5, "WorkflowExecutionCompleted", 1000, "Workflow", { result: ["done"] })];
    const { followHistory, query } = setup({ events: closed, detail: detail({}, "Completed") });
    await waitFor(() => tabButton("Stack trace") !== null, "the tabs");
    await click(tabButton("Stack trace"));
    await waitFor(() => byText(/not running/) !== null, "the note");
    expect(followHistory).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  test("an error replaces the content with Retry", async () => {
    const missing = new RpcError("NotFound", "workflow not found", { details: { kind: "NotFound", system: "temporal", message: "workflow not found", retryable: false } });
    const stream = fakeStream();
    const client = { temporal: { workflows: { describe: () => Promise.reject(missing), history: vi.fn(), followHistory: () => stream.call, query: vi.fn() } } } as unknown as MightyClient;
    const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
    const tab: TabRecord = { id: "t", tool: "temporal", profileId: "01T", kind: "temporal.workflow", params: { namespace: "lab", workflowId: "gone" }, title: "gone", pinned: false };
    render(<WorkflowTab tab={tab} profile={profile} connId="c" client={client} active useTabActions={() => {}} onLive={() => {}} note={describeError} openTab={() => {}} />);
    await waitFor(() => byText("workflow not found") !== null, "the error");
    expect(byRole("button", "Retry") ?? byRole("button", "Refresh")).not.toBeNull();
  });

  test("closing the tab stops the stream", async () => {
    const { stream, unmount } = setup();
    await waitFor(() => byText("Live") !== null, "the follow");
    unmount();
    await settle(2);
    expect(stream.cancelled).toBe(true);
  });
});
