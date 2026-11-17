// Schedules and task queues of the Temporal tool (Mightyconsole spec §9.3, §9.4) against a stub
// client: the list and its rows, one schedule with Pause or Resume, Run now and Delete (the typed
// id), and the pollers of a task queue.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { ScheduleDetail, ScheduleSummary, TaskQueueDescription } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { ScheduleTab, SchedulesTab } from "@/tools/temporal/SchedulesTab";
import { TaskQueueTab } from "@/tools/temporal/TaskQueueTab";
import { profile as schema } from "@/tools/temporal/profile";
import type { TabProps, TabRecord } from "@/tools/types";
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
  info: { actionCount: 12, createTime: "2026-11-17T18:00:00Z" },
});

const isDisabled = (el: HTMLElement | null) => el !== null && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"));

function props(client: unknown, tab: Partial<TabRecord> & { kind: string; params: Record<string, unknown> }): TabProps & { openTab: ReturnType<typeof vi.fn> } {
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
    expect(byText("2 schedules · lab · lab")).not.toBeNull();
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

describe("Schedule", () => {
  function setup(initial: Partial<ScheduleSummary> = {}, fail?: unknown) {
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

  test("shows the spec, the upcoming and recent runs and the details", async () => {
    const { container } = setup();
    await waitFor(() => byText("Upcoming runs") !== null, "the detail");
    expect(byText("Active")).not.toBeNull();
    expect(container.querySelectorAll("ul[aria-label='Upcoming runs'] li")).toHaveLength(2);
    expect(container.querySelector("table[aria-label='Recent runs']")!.textContent).toContain("Completed");
    expect(container.textContent).toContain("12");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Pause asks, sends the note, and then offers Resume", async () => {
    const { schedules } = setup();
    await waitFor(() => byText("Upcoming runs") !== null, "the detail");
    await click(byRole("button", "Pause"));
    await waitFor(() => dialogWith("Pause every-minute?") !== null, "the dialog");
    await type(field("Pause every-minute?", "Note"), "pausing");
    await click(inDialog("Pause every-minute?", "Pause"));
    await waitFor(() => schedules.pause.mock.calls.length === 1, "the call");
    expect(schedules.pause.mock.calls[0]![0]).toEqual({ connId: "conn-1", namespace: "lab", scheduleId: "every-minute", note: "pausing", overlap: null });
    await waitFor(() => byRole("button", "Resume") !== null, "Resume");
    expect(byText("Paused")).not.toBeNull();
    await click(byRole("button", "Resume"));
    await waitFor(() => dialogWith("Resume every-minute?") !== null, "the resume dialog");
    await click(inDialog("Resume every-minute?", "Resume"));
    await waitFor(() => schedules.unpause.mock.calls.length === 1, "the unpause");
    expect(schedules.unpause.mock.calls[0]![0]).toMatchObject({ note: null });
  });

  test("Run now sends the schedule's own overlap policy unless told otherwise", async () => {
    const { schedules } = setup();
    await waitFor(() => byText("Upcoming runs") !== null, "the detail");
    await click(byRole("button", "Run now"));
    await waitFor(() => dialogWith("Run every-minute now?") !== null, "the dialog");
    expect(dialogWith("Run every-minute now?")!.textContent).toContain("The schedule's own policy");
    await click(inDialog("Run every-minute now?", "Run now"));
    await waitFor(() => schedules.trigger.mock.calls.length === 1, "the call");
    expect(schedules.trigger.mock.calls[0]![0]).toEqual({ connId: "conn-1", namespace: "lab", scheduleId: "every-minute", note: null, overlap: null });
  });

  test("Delete needs the typed id, and the tab says it is gone afterwards", async () => {
    const { schedules } = setup();
    await waitFor(() => byText("Upcoming runs") !== null, "the detail");
    await click(byRole("button", "Delete"));
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
    await waitFor(() => byText("Upcoming runs") !== null, "the detail");
    await click(byRole("button", "Pause"));
    await waitFor(() => dialogWith("Pause every-minute?") !== null, "the dialog");
    await click(inDialog("Pause every-minute?", "Pause"));
    await waitFor(() => dialogWith("not allowed to change schedules") !== null, "the error");
    expect(schedules.pause).toHaveBeenCalledTimes(1);
  });

  test("a schedule that does not exist is said so", async () => {
    const missing = new RpcError("NotFound", "schedule not found", { details: { kind: "NotFound", system: "temporal", message: "schedule not found", retryable: false } });
    const p = props({ temporal: { schedules: { describe: () => Promise.reject(missing) } } }, { kind: "temporal.schedule", params: { namespace: "lab", scheduleId: "gone" } });
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
