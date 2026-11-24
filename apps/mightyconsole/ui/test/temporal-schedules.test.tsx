// Schedules and task queues of the Temporal tool (Mightyconsole spec §9.3, §9.4) against a stub
// client: the list and its rows, one schedule with Pause or Resume, Run now and Delete (the typed
// id), and the pollers of a task queue.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { ScheduleDetail, ScheduleRunsOutput, ScheduleSummary, TaskQueueDescription } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { FOLLOW_EVERY_MS, ScheduleTab } from "@/tools/temporal/ScheduleTab";
import { SchedulesTab } from "@/tools/temporal/SchedulesTab";
import { TaskQueueTab } from "@/tools/temporal/TaskQueueTab";
import { profile as schema } from "@/tools/temporal/profile";
import type { TabProps, TabView } from "@/tools/types";
import { axeViolations, byRole, byText, cleanup, click, dialogWith, render, settle, type, waitFor } from "./support/render";

afterEach(cleanup);

const summary = (patch: Partial<ScheduleSummary> = {}): ScheduleSummary => ({
  scheduleId: "every-minute",
  workflowType: "Completed",
  spec: "Every 1 minute",
  paused: false,
  notes: "",
  nextRuns: ["2026-11-18T01:01:00Z", "2026-11-18T01:02:00Z"],
  recentActions: [{ scheduledTime: "2026-11-18T01:00:00Z", actualTime: "2026-11-18T01:00:00Z", workflowId: "scheduled-2026-11-18T01:00:00Z", runId: "run-1", status: "Completed" }],
  ...patch,
});

const detail = (patch: Partial<ScheduleSummary> = {}): ScheduleDetail => ({
  summary: summary(patch),
  spec: { interval: [{ interval: "60s" }] },
  action: { startWorkflow: { workflowType: { name: "Completed" }, input: ["ord-scheduled"] } },
  policies: { overlapPolicy: "SCHEDULE_OVERLAP_POLICY_SKIP" },
  state: {},
  info: { actionCount: "12", overlapSkipped: "3", missedCatchupWindow: "1", createTime: "2026-11-17T18:00:00Z" },
  form: {
    spec: { calendars: [], intervals: [{ every: "1m" }], cronStrings: [] },
    action: { workflowType: "Completed", taskQueue: "lab", workflowId: "scheduled", args: ["ord-scheduled"] },
    policies: { overlap: "skip", pauseOnFailure: false },
    state: { paused: summary(patch).paused, notes: "" },
  },
  conflictToken: "dG9rZW4=",
});

const isDisabled = (el: HTMLElement | null) => el !== null && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"));

function props(client: unknown, tab: Partial<TabView> & { kind: string; params: Record<string, unknown> }): TabProps & { openTab: ReturnType<typeof vi.fn> } {
  const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const openTab = vi.fn();
  return { tab: { id: "t", tool: "temporal", profileId: "01T", title: "t", pinned: false, ...tab }, profile, connId: "conn-1", client: client as MightyClient, active: true, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab };
}

describe("Schedules list", () => {
  test("lists schedules with spec, state, next run and last action; a row opens its tab", async () => {
    const list = vi.fn(async (_input: unknown) => [summary(), summary({ scheduleId: "nightly", paused: true, spec: "Cron 0 3 * * *", nextRuns: [], recentActions: [] })]);
    const p = props({ temporal: { schedules: { list } } }, { kind: "temporal.schedules", params: { namespace: "lab" } });
    const { container } = render(<SchedulesTab {...p} />);
    await waitFor(() => byText("nightly") !== null, "the rows");
    expect(list).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", query: null });
    const rows = Array.from(container.querySelectorAll("tbody tr")).map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Every 1 minute");
    expect(rows[0]).toContain("Active");
    expect(rows[0]).toContain("Completed");
    expect(rows[1]).toContain("Paused");
    expect(rows[1]).toContain("Cron 0 3 * * *");
    expect(byText("lab · namespace lab · 2 schedules")).not.toBeNull();
    await click(byRole("button", "every-minute"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "temporal.schedule", params: { namespace: "lab", scheduleId: "every-minute" }, title: "every-minute" });
    expect(await axeViolations(container)).toEqual([]);
  });

  test("none says so, and an error replaces the list", async () => {
    const empty = props({ temporal: { schedules: { list: async () => [] } } }, { kind: "temporal.schedules", params: { namespace: "lab" } });
    render(<SchedulesTab {...empty} />);
    await waitFor(() => byText("No schedules in lab.") !== null, "the empty line");
    cleanup();
    const denied = new RpcError("PermissionDenied", "schedules are not enabled", { details: { kind: "Forbidden", system: "temporal", message: "schedules are not enabled", retryable: false } });
    const bad = props({ temporal: { schedules: { list: () => Promise.reject(denied) } } }, { kind: "temporal.schedules", params: { namespace: "lab" } });
    render(<SchedulesTab {...bad} />);
    await waitFor(() => byText("schedules are not enabled") !== null, "the error");
  });
});

describe("Schedule (DOC-21 §9.3, TSK-104)", () => {
  const RUNS: ScheduleRunsOutput = {
    query: 'TemporalScheduledById = "every-minute"',
    runs: [
      { scheduledTime: "2026-11-18T01:02:00Z", startTime: "2026-11-18T01:02:00.412Z", workflowId: "scheduled-2026-11-18T01:02:00Z", runId: "run-2", status: "Running" },
      { scheduledTime: "2026-11-18T01:01:00Z", skipped: "Skipped: the previous run was still running (overlap Skip)" },
      { scheduledTime: "2026-11-18T01:00:00Z", startTime: "2026-11-18T01:00:00.388Z", closeTime: "2026-11-18T01:00:01Z", workflowId: "scheduled-2026-11-18T01:00:00Z", runId: "run-1", status: "Failed", durationMs: 612 },
    ],
    nextPageToken: "1794000000:dG9r",
  };
  function setup(initial: Partial<ScheduleSummary> = {}, fail?: unknown, runsImpl?: (input: { nextPageToken?: string | null }) => Promise<ScheduleRunsOutput>) {
    let current = detail(initial);
    const write = (apply: (d: ScheduleDetail) => ScheduleDetail) =>
      vi.fn(async (_input: unknown) => {
        if (fail) throw fail;
        current = apply(current);
        return {};
      });
    const schedules = {
      describe: vi.fn(async (_input: unknown) => current),
      pause: write((d) => ({ ...d, summary: { ...d.summary, paused: true, notes: "pausing" } })),
      unpause: write((d) => ({ ...d, summary: { ...d.summary, paused: false } })),
      trigger: write((d) => d),
      delete: write((d) => d),
      backfill: write((d) => d),
      runs: vi.fn(runsImpl ?? (async (input: { nextPageToken?: string | null }) => (input.nextPageToken ? { ...RUNS, runs: RUNS.runs.slice(2), nextPageToken: undefined } : RUNS))),
      matchingTimes: vi.fn(async (input: { endTime?: string | null }) => (input.endTime ? { times: ["2026-11-18T00:10:00Z", "2026-11-18T00:20:00Z", "2026-11-18T00:30:00Z"], truncated: false } : { times: ["2026-11-18T01:03:00Z", "2026-11-18T01:04:00Z", "2026-11-18T01:05:00Z", "2026-11-18T01:06:00Z", "2026-11-18T01:07:00Z", "2026-11-18T01:08:00Z"], truncated: true })),
    };
    const p = props({ temporal: { schedules } }, { kind: "temporal.schedule", params: { namespace: "lab", scheduleId: "every-minute" } });
    const view = render(<ScheduleTab {...p} />);
    return { schedules, openTab: p.openTab, ...view };
  }
  const field = (dialogText: string, label: string): HTMLInputElement => {
    const d = dialogWith(dialogText)!;
    for (const l of d.querySelectorAll<HTMLLabelElement>("label")) if (l.textContent?.includes(label)) return (l.querySelector("input") ?? l.parentElement!.querySelector("input")) as HTMLInputElement;
    throw new Error(`no field ${label}`);
  };
  const inDialog = (dialogText: string, name: string) => byRole("button", name, dialogWith(dialogText)!);
  const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((m) => m.textContent?.includes(name)) ?? null;
  const ready = () => waitFor(() => document.querySelector("ul[aria-label='Upcoming runs']") !== null && byText("scheduled-2026-11-18T01:02:00Z") !== null, "the detail");

  test("the header, the facts, the runs with a skipped time, the server's next times and the action", async () => {
    const { container, schedules } = setup();
    await ready();
    expect(byText("Active")).not.toBeNull();
    expect(container.textContent).toContain("starts Completed on task queue lab");
    expect(container.textContent).toContain("Every 1 minute · UTC");
    expect(container.textContent).toContain("12 · 3 skipped · 1 missed");
    // The side: the next five times from ListScheduleMatchingTimes.
    expect(schedules.matchingTimes.mock.calls[0]![0]).toMatchObject({ connId: "conn-1", namespace: "lab", scheduleId: "every-minute", endTime: null, limit: 20 });
    const upcoming = [...container.querySelectorAll<HTMLElement>("ul[aria-label='Upcoming runs'] li")].map((li) => li.dataset.at);
    expect(upcoming).toEqual(["2026-11-18T01:03:00Z", "2026-11-18T01:04:00Z", "2026-11-18T01:05:00Z", "2026-11-18T01:06:00Z", "2026-11-18T01:07:00Z"]);
    const table = container.querySelector("table[aria-label='Runs of the schedule']")!;
    expect(table.textContent).toContain("Next run, in");
    expect(table.textContent).toContain("Skipped: the previous run was still running (overlap Skip)");
    expect(table.textContent).toContain("612 ms");
    expect(container.textContent).toContain('TemporalScheduledById = "every-minute"');
    expect(byText('"ord-scheduled"')).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("runs page by token and open their workflow", async () => {
    const { schedules, openTab } = setup();
    await ready();
    await click(byRole("button", "Next page"));
    await waitFor(() => schedules.runs.mock.calls.length === 2, "page 2");
    expect(schedules.runs.mock.calls[1]![0]).toMatchObject({ pageSize: 20, nextPageToken: "1794000000:dG9r" });
    await waitFor(() => byText("Page 2") !== null, "page 2 shown");
    await click(byRole("button", "scheduled-2026-11-18T01:00:00Z"));
    expect(openTab).toHaveBeenCalledWith({ kind: "temporal.workflow", params: { namespace: "lab", workflowId: "scheduled-2026-11-18T01:00:00Z", runId: "run-1" }, title: "scheduled-2026-11-18T01:00:00Z" });
    await click(byRole("button", "Previous page"));
    await waitFor(() => byText("Page 1") !== null, "back to page 1");
  });

  test("Pause… asks, sends the note, and then offers Unpause…", async () => {
    const { schedules } = setup();
    await ready();
    await click(byRole("button", "Pause…"));
    await waitFor(() => dialogWith("Pause every-minute?") !== null, "the dialog");
    await type(field("Pause every-minute?", "Note"), "pausing");
    await click(inDialog("Pause every-minute?", "Pause"));
    await waitFor(() => schedules.pause.mock.calls.length === 1, "the call");
    expect(schedules.pause.mock.calls[0]![0]).toEqual({ connId: "conn-1", namespace: "lab", scheduleId: "every-minute", note: "pausing", overlap: null });
    await waitFor(() => byRole("button", "Unpause…") !== null, "Unpause");
    expect(byText("Paused")).not.toBeNull();
    await click(byRole("button", "Unpause…"));
    await waitFor(() => dialogWith("Unpause every-minute?") !== null, "the unpause dialog");
    await click(inDialog("Unpause every-minute?", "Unpause"));
    await waitFor(() => schedules.unpause.mock.calls.length === 1, "the unpause");
    expect(schedules.unpause.mock.calls[0]![0]).toMatchObject({ note: null });
  });

  test("Trigger now sends the schedule's own overlap policy unless told otherwise", async () => {
    const { schedules } = setup();
    await ready();
    await click(byRole("button", "Trigger now"));
    await waitFor(() => dialogWith("Trigger every-minute now?") !== null, "the dialog");
    expect(dialogWith("Trigger every-minute now?")!.textContent).toContain("The schedule's own policy");
    await click(inDialog("Trigger every-minute now?", "Trigger now"));
    await waitFor(() => schedules.trigger.mock.calls.length === 1, "the call");
    expect(schedules.trigger.mock.calls[0]![0]).toEqual({ connId: "conn-1", namespace: "lab", scheduleId: "every-minute", note: null, overlap: null });
  });

  test("after Trigger now, Runs follows the schedule until its action count moves, then stops (TSK-132)", async () => {
    const { schedules } = setup();
    await ready();
    // Temporal takes the trigger a moment before it counts the action: the reload that follows the
    // trigger still sees 12, the next describe sees 13.
    let described = 0;
    schedules.describe.mockImplementation(async () => {
      described += 1;
      const d = detail();
      return described < 2 ? d : { ...d, info: { ...d.info, actionCount: "13" } };
    });
    const runsBefore = schedules.runs.mock.calls.length;
    await click(byRole("button", "Trigger now"));
    await waitFor(() => dialogWith("Trigger every-minute now?") !== null, "the dialog");
    await click(inDialog("Trigger every-minute now?", "Trigger now"));
    await waitFor(() => described >= 2, "the second describe, after the first showed nothing new", 5000);
    await waitFor(() => schedules.runs.mock.calls.length >= runsBefore + 2, "Runs reloaded once the count moved", 5000);
    const settled = schedules.describe.mock.calls.length;
    await new Promise((r) => setTimeout(r, FOLLOW_EVERY_MS * 2));
    expect(schedules.describe.mock.calls.length).toBe(settled);
  });

  test("Runs asks again when Temporal says the query buffer is full, instead of showing the error (TSK-132)", async () => {
    const busy = new RpcError("ResourceExhausted", "consistent query buffer is full", { details: { kind: "Remote", system: "temporal", message: "consistent query buffer is full", retryable: true, remote: { code: "ResourceExhausted" } } });
    let calls = 0;
    const { container } = setup({}, undefined, async () => {
      calls += 1;
      if (calls <= 2) throw busy;
      return RUNS;
    });
    await waitFor(() => byText("scheduled-2026-11-18T01:02:00Z") !== null, "the runs after two refusals", 8000);
    expect(calls).toBe(3);
    expect(container.textContent).not.toContain("consistent query buffer is full");
  });

  test("the schedule's own describe asks again too, so a new schedule opens instead of showing the error (TSK-132)", async () => {
    const busy = new RpcError("ResourceExhausted", "consistent query buffer is full", { details: { kind: "Remote", system: "temporal", message: "consistent query buffer is full", retryable: true, remote: { code: "ResourceExhausted" } } });
    const { schedules } = setup();
    await ready();
    cleanup();
    let calls = 0;
    schedules.describe.mockImplementation(async () => {
      calls += 1;
      if (calls <= 1) throw busy;
      return detail();
    });
    const p = props({ temporal: { schedules } }, { kind: "temporal.schedule", params: { namespace: "lab", scheduleId: "every-minute" } });
    const view = render(<ScheduleTab {...p} />);
    await waitFor(() => view.container.textContent?.includes("Computed by the server") ?? false, "the schedule after one refusal", 8000);
    expect(calls).toBe(2);
    expect(view.container.textContent).not.toContain("consistent query buffer is full");
  });

  test("Backfill… names the count the server matched, then sends the range", async () => {
    const { schedules } = setup();
    await ready();
    await click(byRole("button", "More actions"));
    await waitFor(() => menuItem("Backfill") !== null, "the menu");
    await click(menuItem("Backfill"));
    await waitFor(() => dialogWith("Backfill every-minute?") !== null, "the dialog");
    await waitFor(() => dialogWith("Starts 3 runs, one for each time the spec matched.") !== null, "the count");
    const counted = schedules.matchingTimes.mock.calls.find((c) => c[0].endTime)![0] as { startTime: string; endTime: string; limit: number };
    expect(Date.parse(counted.endTime) - Date.parse(counted.startTime)).toBe(3_600_000);
    expect(counted.limit).toBe(1000);
    await click(inDialog("Backfill every-minute?", "Start 3 runs"));
    await waitFor(() => schedules.backfill.mock.calls.length === 1, "the call");
    expect(schedules.backfill.mock.calls[0]![0]).toMatchObject({ connId: "conn-1", namespace: "lab", scheduleId: "every-minute", startTime: counted.startTime, endTime: counted.endTime, overlap: null });
  });

  test("Delete… needs the typed id, and the tab says it is gone afterwards", async () => {
    const { schedules } = setup();
    await ready();
    await click(byRole("button", "More actions"));
    await waitFor(() => menuItem("Delete") !== null, "the menu");
    await click(menuItem("Delete"));
    await waitFor(() => dialogWith("Delete every-minute?") !== null, "the dialog");
    expect(isDisabled(inDialog("Delete every-minute?", "Delete schedule"))).toBe(true);
    await type(field("Delete every-minute?", "Type every-minute"), "every-minut");
    expect(isDisabled(inDialog("Delete every-minute?", "Delete schedule"))).toBe(true);
    await type(field("Delete every-minute?", "Type every-minute"), "every-minute");
    await click(inDialog("Delete every-minute?", "Delete schedule"));
    await waitFor(() => schedules.delete.mock.calls.length === 1, "the call");
    await waitFor(() => byText("every-minute was deleted. Close this tab.") !== null, "the gone note");
  });

  test("a failure stays in the dialog", async () => {
    const denied = new RpcError("PermissionDenied", "not allowed to change schedules", { details: { kind: "Forbidden", system: "temporal", message: "not allowed to change schedules", retryable: false } });
    const { schedules } = setup({}, denied);
    await ready();
    await click(byRole("button", "Pause…"));
    await waitFor(() => dialogWith("Pause every-minute?") !== null, "the dialog");
    await click(inDialog("Pause every-minute?", "Pause"));
    await waitFor(() => dialogWith("not allowed to change schedules") !== null, "the error");
    expect(schedules.pause).toHaveBeenCalledTimes(1);
  });

  test("a schedule that does not exist is said so", async () => {
    const missing = new RpcError("NotFound", "schedule not found", { details: { kind: "NotFound", system: "temporal", message: "schedule not found", retryable: false } });
    const p = props({ temporal: { schedules: { describe: () => Promise.reject(missing), runs: () => Promise.reject(missing), matchingTimes: () => Promise.reject(missing) } } }, { kind: "temporal.schedule", params: { namespace: "lab", scheduleId: "gone" } });
    render(<ScheduleTab {...p} />);
    await waitFor(() => byText("schedule not found") !== null, "the error");
  });
});

describe("Task queue", () => {
  const description = (patch: Partial<TaskQueueDescription> = {}): TaskQueueDescription => ({
    workflowPollers: [{ identity: "12@worker-a", lastAccessTime: "2026-11-18T01:00:00Z", ratePerSecond: 100000 }],
    activityPollers: [],
    workflowBacklog: 0,
    activityBacklog: 7,
    ...patch,
  });

  test("shows the pollers of each kind, and says when no worker polls", async () => {
    const describeQueue = vi.fn(async (_input: unknown) => description());
    const p = props({ temporal: { taskQueues: { describe: describeQueue } } }, { kind: "temporal.taskQueue", params: { namespace: "lab", name: "lab" } });
    const { container } = render(<TaskQueueTab {...p} />);
    await waitFor(() => byText("12@worker-a") !== null, "the poller");
    expect(describeQueue).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", taskQueue: "lab" });
    expect(byText("No worker is polling this task queue.")).not.toBeNull();
    expect(byText("7 waiting")).not.toBeNull();
    expect(container.textContent).toContain("Workflow pollers (1)");
    expect(container.textContent).toContain("Activity pollers (0)");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("without a name it asks for one and opens that queue", async () => {
    const p = props({ temporal: { taskQueues: { describe: vi.fn() } } }, { kind: "temporal.taskQueue", params: { namespace: "lab", name: "" } });
    render(<TaskQueueTab {...p} />);
    expect(isDisabled(byRole("button", "Look up"))).toBe(true);
    await type(document.querySelector<HTMLInputElement>("input")!, "orders");
    await click(byRole("button", "Look up"));
    await settle(1);
    expect(p.openTab).toHaveBeenCalledWith({ kind: "temporal.taskQueue", params: { namespace: "lab", name: "orders" }, title: "orders" });
  });
});
