// The workflow tab of the Temporal tool (Mightyconsole spec §9.3) against a stub client: the
// header, the Timeline, the History table with its detail and filter, input and result, the
// pending activities, the stack trace, and the history followed live until the run closes.
import { RpcError } from "@byterygon/ambidex";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { EventCategory, HistoryEvent, WorkflowDetail } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { WorkflowTab } from "@/tools/temporal/WorkflowTab";
import { splitLines } from "@/tools/temporal/useWorkflow";
import { profile as schema } from "@/tools/temporal/profile";
import type { LiveState, TabProps, TabView } from "@/tools/types";
import { axeViolations, byRole, byText, cleanup, click, render, settle, type, waitFor } from "./support/render";

afterEach(cleanup);

const T0 = Date.parse("2026-11-18T01:00:00Z");
const ev = (eventId: number, eventType: string, atMs: number, category: EventCategory, attributes: Record<string, unknown> = {}): HistoryEvent => ({
  eventId,
  eventTime: new Date(T0 + atMs).toISOString(),
  eventType,
  category,
  attributes,
  size: 0,
});

const events: HistoryEvent[] = [
  { ...ev(1, "WorkflowExecutionStarted", 0, "Workflow", { workflowType: { name: "Fulfilment" }, taskQueue: { name: "lab" }, input: ["ord-long"] }), encodings: ["json/plain"] },
  ev(2, "WorkflowTaskScheduled", 1, "WorkflowTask", { taskQueue: { name: "lab" } }),
  ev(3, "ActivityTaskScheduled", 500, "Activity", { activityType: { name: "charge" }, activityId: "1" }),
  ev(4, "WorkflowExecutionSignaled", 800, "Signal", { signalName: "approve", input: ["me"] }),
];

const detail = (patch: Partial<WorkflowDetail> = {}, status: WorkflowDetail["workflow"]["status"] = "Running"): WorkflowDetail => ({
  historySizeBytes: 2048,
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
  const rawEvent = vi.fn(async (_input: unknown) => ({ attributes: { input: { payloads: [{ metadata: { encoding: "anNvbi9wbGFpbg==" }, data: "Im9yZC1sb25nIg==" }] } } }));
  const client = { temporal: { workflows: { describe, history, followHistory, query, rawEvent } } } as unknown as MightyClient;
  const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const tab: TabView = { id: "t2", tool: "temporal", profileId: "01T", kind: "temporal.workflow", params: { namespace: "lab", workflowId: "fulfilment-long-running" }, title: "fulfilment-long-running", pinned: false };
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

/** A view's tab; History and Pending carry their counts ("History 4"). */
const tabButton = (name: string) => byRole("tab", new RegExp(`^${name}( \\d+)?$`));

describe("splitLines", () => {
  test("keeps a partial line for the next chunk and drops blanks", () => {
    expect(splitLines("", '{"a":1}\n{"b"')).toEqual({ lines: ['{"a":1}'], carry: '{"b"' });
    expect(splitLines('{"b"', ":2}\n\n")).toEqual({ lines: ['{"b":2}'], carry: "" });
  });
});

describe("Workflow tab (spec §9.3)", () => {
  test("shows the header and the Timeline, and follows an open run from its last event", async () => {
    const { describe: d, history, followHistory, container } = setup();
    await waitFor(() => byText("fulfilment-long-running") !== null && container.querySelector('[data-slot="timeline"]') !== null, "the header and timeline");
    expect(d).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", workflowId: "fulfilment-long-running", runId: null });
    // The history is read for the run describe found, so the two cannot disagree.
    expect(history.mock.calls[0]![0]).toMatchObject({ runId: "0190aaaa-bbbb-cccc-dddd-000000000001", pageSize: 1000 });
    expect(byText("Running")).not.toBeNull();
    expect(byText("4 events")).not.toBeNull();
    await waitFor(() => followHistory.mock.calls.length === 1, "the follow");
    expect(followHistory.mock.calls[0]![0]).toMatchObject({ fromEventId: 4, workflowId: "fulfilment-long-running", runId: "0190aaaa-bbbb-cccc-dddd-000000000001" });
    // Followed live: the Timeline keeps now in view ("Following" in its toolbar).
    expect(byText("Following")).not.toBeNull();
    const items = Array.from(container.querySelectorAll('[data-slot="timeline-item"]')).map((i) => i.getAttribute("aria-label"));
    expect(items.some((l) => l?.startsWith("fulfilment-long-running, running"))).toBe(true);
    expect(items.some((l) => l?.startsWith("charge, running"))).toBe(true);
    expect(items.some((l) => l?.startsWith("Signal approve"))).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Timeline: a bar or a diamond opens its details beside the chart, with its own events (TSK-100)", async () => {
    const { container } = setup();
    await waitFor(() => container.querySelector('[data-slot="timeline-item"]') !== null, "the timeline");
    const aside = () => container.querySelector<HTMLElement>('[data-slot="timeline-aside"]')!;
    // Nothing selected: the pane beside the chart says how to pick an item.
    expect(aside().textContent).toContain("Click a bar, a diamond or a pin");
    const mark = (label: string) => Array.from(container.querySelectorAll<HTMLElement>('[data-slot="timeline-item"]')).find((i) => i.getAttribute("aria-label")?.startsWith(label))!;
    await click(mark("charge, running"));
    await waitFor(() => aside().textContent?.includes("charge · activity 3") === true, "the activity's details");
    expect(aside().getAttribute("aria-label")).toBe("charge, activity 3");
    expect(byRole("button", "Copy activity ID", aside())).not.toBeNull();
    expect(aside().textContent).toContain("Scheduled");
    // Its events, the first unfolded to its attributes; the others unfold on a click.
    const events = byRole("region", "Events", aside()) ?? aside().querySelector('[aria-label="Events"]')!;
    const rows = Array.from(events.querySelectorAll<HTMLElement>("button[aria-expanded]"));
    expect(rows.map((b) => b.textContent)).toEqual([expect.stringContaining("ActivityTaskScheduled")]);
    expect(rows[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(aside().querySelector('[aria-label="Attributes of event 3"]')).not.toBeNull();
    await click(rows[0]!);
    expect(aside().querySelector('[aria-label="Attributes of event 3"]')).toBeNull();
    // No strip under the chart and no jump to History.
    expect(byRole("button", /in History$/)).toBeNull();
    expect(container.querySelector('[aria-label="Selected item"]')).toBeNull();
    // A diamond: the signal, received.
    await click(mark("Signal approve"));
    await waitFor(() => aside().textContent?.includes("approve · signal 4") === true, "the signal's details");
    expect(aside().textContent).toContain("Received");
    expect(aside().textContent).toContain("1 payload");
    // No key hint drawn on any button of the tab (DOC-21 §3.4).
    expect(container.querySelectorAll("button kbd").length).toBe(0);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("an event chosen in History selects its item on the Timeline", async () => {
    const withStart = [...events.slice(0, 3), ev(5, "ActivityTaskStarted", 600, "Activity", { scheduledEventId: 3, identity: "worker-1@lab", attempt: 1 }), events[3]!];
    const { container } = setup({ events: withStart });
    await waitFor(() => tabButton("History") !== null, "the tabs");
    await click(tabButton("History"));
    const goTo = await (async () => {
      await waitFor(() => container.querySelector('input[aria-label="Go to event"]') !== null, "Go to");
      return container.querySelector<HTMLInputElement>('input[aria-label="Go to event"]')!;
    })();
    await type(goTo, "5");
    await act(async () => {
      goTo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => container.textContent?.includes("Event 5 · ActivityTaskStarted") === true, "event 5");
    await click(tabButton("Timeline"));
    const aside = () => container.querySelector<HTMLElement>('[data-slot="timeline-aside"]')!;
    await waitFor(() => aside().textContent?.includes("charge · activity 3") === true, "its activity in the pane");
    expect(aside().textContent).toContain("worker-1@lab");
    expect(aside().textContent).toContain("waited 100 ms");
  });

  test("History: an open workflow-task fold shows its events indented under it, with a guide line (TSK-100)", async () => {
    const folded = [events[0]!, ev(2, "WorkflowTaskScheduled", 1, "WorkflowTask"), ev(3, "WorkflowTaskStarted", 5, "WorkflowTask", { scheduledEventId: 2, identity: "w@lab" }), ev(4, "WorkflowTaskCompleted", 40, "WorkflowTask", { scheduledEventId: 2 }), ev(5, "ActivityTaskScheduled", 41, "Activity", { activityType: { name: "charge" }, activityId: "1" })];
    const { container } = setup({ events: folded });
    await waitFor(() => tabButton("History") !== null, "the tabs");
    await click(tabButton("History"));
    const rows = () => Array.from(container.querySelectorAll<HTMLTableRowElement>("table[aria-label='History events'] tbody tr:not([data-spacer])"));
    await waitFor(() => rows().length === 3, "the fold closed");
    const fold = rows()[1]!;
    const chevron = fold.querySelector<HTMLElement>("button[aria-expanded]")!;
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
    expect(chevron.getAttribute("aria-label")).toBe("Unfold events 2–4");
    await click(chevron);
    await waitFor(() => rows().length === 6, "the fold open");
    expect(rows()[1]!.querySelector("button[aria-expanded]")?.getAttribute("aria-expanded")).toBe("true");
    const kids = rows().filter((r) => r.hasAttribute("data-in-fold"));
    expect(kids.map((r) => r.cells[3]?.textContent)).toEqual(["WorkflowTaskScheduled", "WorkflowTaskStarted", "WorkflowTaskCompleted"]);
    expect(rows().indexOf(kids[0]!)).toBe(2);
    expect(kids.every((r) => r.querySelector('[data-slot="fold-guide"]') !== null)).toBe(true);
    // Events outside the fold are not indented.
    expect(rows()[5]!.hasAttribute("data-in-fold")).toBe(false);
    expect(rows()[5]!.querySelector('[data-slot="fold-guide"]')).toBeNull();
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
    expect(byText("Following")).toBeNull();
    // The pending work and the status are asked again after the events.
    await waitFor(() => d.mock.calls.length > before, "a fresh describe");
  });

  test("History: the table with time since start, chips with counts, a search, Go to, and the chosen event's detail", async () => {
    const { container } = setup();
    await waitFor(() => tabButton("History") !== null, "the tabs");
    await click(tabButton("History"));
    const rows = () => Array.from(container.querySelectorAll("table[aria-label='History events'] tbody tr:not([data-spacer])"));
    await waitFor(() => rows().length === 4, "four rows");
    expect(rows()[2]!.textContent).toContain("ActivityTaskScheduled");
    expect(rows()[2]!.textContent).toContain("+500 ms");
    expect(rows()[2]!.textContent).toContain("charge");
    expect(rows()[3]!.textContent).toContain("approve · 1 payload");
    // Chips name each category with its count; an empty one is disabled.
    const chip = (name: RegExp) => byRole("button", name, container.querySelector('[aria-label="Category"]')!);
    expect(chip(/^All 4$/)?.getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^Timers 0$/)?.hasAttribute("disabled") || chip(/^Timers 0$/)?.hasAttribute("data-disabled")).toBe(true);
    await click(chip(/^Signals 1$/));
    await waitFor(() => rows().length === 1, "the signal only");
    await click(chip(/^All 4$/));
    // Find searches the decoded attributes too.
    await type(container.querySelector<HTMLInputElement>('input[aria-label="Find in events"]')!, "ord-long");
    await waitFor(() => rows().length === 1 && rows()[0]!.textContent!.includes("WorkflowExecutionStarted"), "the match");
    await type(container.querySelector<HTMLInputElement>('input[aria-label="Find in events"]')!, "");
    await waitFor(() => rows().length === 4, "all again");
    // Go to selects the event and shows its detail.
    const goTo = container.querySelector<HTMLInputElement>('input[aria-label="Go to event"]')!;
    await type(goTo, "3");
    await act(async () => {
      goTo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => container.textContent?.includes("Event 3 · ActivityTaskScheduled") === true, "the detail");
    expect(container.textContent).toContain("Activity charge:");
    expect(byRole("button", "Copy event")).not.toBeNull();
    // Event 1 as stored: its encoding labelled, the Raw form read from the server.
    await type(goTo, "1");
    await act(async () => {
      goTo.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await waitFor(() => container.textContent?.includes("json/plain · 1 payload") === true, "the payload label");
    await click(byRole("button", "Raw"));
    await waitFor(() => container.textContent?.includes("Im9yZC1sb25nIg==") === true, "the stored payload");
    expect(await axeViolations(container)).toEqual([]);
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
    // Past its first attempt with a failure: retrying, as the mockup says; the split pane shows the chosen one.
    expect(row.textContent).toContain("Retrying");
    expect(document.querySelector("[aria-label=\"Pending activity\"]")?.textContent).toContain("flaky · activity 1");
    expect(document.querySelector("[aria-label=\"Pending activity\"]")?.textContent).toContain("Last failure");
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
    const tab: TabView = { id: "t", tool: "temporal", profileId: "01T", kind: "temporal.workflow", params: { namespace: "lab", workflowId: "gone" }, title: "gone", pinned: false };
    render(<WorkflowTab tab={tab} profile={profile} connId="c" client={client} active useTabActions={() => {}} onLive={() => {}} note={describeError} openTab={() => {}} />);
    await waitFor(() => byText("workflow not found") !== null, "the error");
    expect(byRole("button", "Retry") ?? byRole("button", "Refresh")).not.toBeNull();
  });

  test("closing the tab stops the stream", async () => {
    const { stream, unmount } = setup();
    await waitFor(() => byText("Following") !== null, "the follow");
    unmount();
    await settle(2);
    expect(stream.cancelled).toBe(true);
  });
});
