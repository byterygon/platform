// TSK-92's Write sheets against a stub client (Mightyconsole spec §9.3, §9.4): Start workflow from
// the Workflows header (suggestions, the queue's workers, Ctrl+Enter, the toast with Open
// workflow, Copy as CLI command, "Start another like this" prefilled), and the schedule sheet
// (create with the next runs computed in the browser, edit with the changes listed first, a
// conflict with Reload). Both are checked with axe.
import { RpcError } from "@byterygon/ambidex";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import { type Notice, NoticeContext } from "@/app/page";
import type { MightyClient } from "@/app/client";
import type { ScheduleDetail, WorkflowRow } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { ScheduleTab, SchedulesTab } from "@/tools/temporal/SchedulesTab";
import { StartWorkflowSheet } from "@/tools/temporal/StartWorkflowSheet";
import { WorkflowsTab } from "@/tools/temporal/WorkflowsTab";
import { requestSheet } from "@/tools/temporal/sheet-parts";
import { profile as schema } from "@/tools/temporal/profile";
import type { TabProps, TabRecord } from "@/tools/types";
import { axeViolations, byRole, byText, cleanup, click, dialogWith, editorArea, key, render, settle, type, waitFor } from "./support/render";

const clipboard = vi.fn(async (_text: string) => undefined);
beforeEach(() => {
  clipboard.mockClear();
  Object.defineProperty(navigator, "clipboard", { value: { writeText: clipboard }, configurable: true });
});
afterEach(cleanup);

const row = (patch: Partial<WorkflowRow> = {}): WorkflowRow => ({ workflowId: "ord-1", runId: "run-1", workflowType: "Order", status: "Completed", startTime: "2026-11-18T00:00:00Z", taskQueue: "lab-queue", historyLength: 11, ...patch });

function props(client: unknown, tab: Partial<TabRecord> & { kind: string; params: Record<string, unknown> }): TabProps & { openTab: ReturnType<typeof vi.fn> } {
  const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  profile.fields["address"] = "127.0.0.1:7233";
  const openTab = vi.fn();
  return { tab: { id: "t", tool: "temporal", profileId: "01T", title: "t", pinned: false, ...tab }, profile, connId: "conn-1", client: client as MightyClient, active: true, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab };
}

function withNotices(ui: ReactNode) {
  const notices: Notice[] = [];
  const out = render(<NoticeContext value={(n) => notices.push(n)}>{ui}</NoticeContext>);
  return { ...out, notices };
}

/** The input labelled `label` inside the open sheet. */
function input(sheet: HTMLElement, label: string): HTMLInputElement {
  for (const l of sheet.querySelectorAll<HTMLLabelElement>("label")) {
    if (l.textContent?.replace("*", "").trim() === label) {
      const found = (l.htmlFor ? sheet.querySelector<HTMLInputElement>(`#${CSS.escape(l.htmlFor)}`) : null) ?? l.parentElement?.querySelector("input");
      if (found) return found as HTMLInputElement;
    }
  }
  throw new Error(`no field ${label}`);
}

/** The open sheet of a form, by the form's id. */
const sheetOf = (formId: string) => document.getElementById(formId)?.closest<HTMLElement>("[role=dialog]") ?? null;
const isDisabled = (el: HTMLElement | null) => el !== null && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"));

function workflowsClient() {
  const start = vi.fn(async (_input: unknown) => ({ runId: "run-new", started: true }));
  const describe = vi.fn(async (_input: unknown) => ({ workflowPollers: [{ identity: "w1@host", ratePerSecond: 0 }, { identity: "w1@host", ratePerSecond: 0 }, { identity: "w2@host", ratePerSecond: 0 }], activityPollers: [] }));
  const client = {
    temporal: {
      workflows: { list: async () => ({ executions: [row(), row({ workflowId: "pay-1", workflowType: "Payment", taskQueue: "payments" })] }), count: async () => ({ count: 2 }), start },
      namespaces: { list: async () => [], searchAttributes: async () => ({ attributes: [] }) },
      taskQueues: { describe },
    },
  };
  return { client, start, describe };
}

describe("Start workflow", () => {
  test("from the header: suggestions, the queue's workers, Ctrl+Enter and the toast that opens the run", async () => {
    const { client, start, describe: describeQueue } = workflowsClient();
    const p = props(client, { kind: "temporal.workflows", params: { namespace: "lab", query: "" } });
    const { notices } = withNotices(<WorkflowsTab {...p} />);
    await waitFor(() => byText("pay-1") !== null, "the rows");
    await click(byRole("button", "Start workflow"));
    await waitFor(() => sheetOf("start-workflow") !== null, "the sheet");
    const sheet = sheetOf("start-workflow")!;
    expect([...sheet.querySelectorAll("datalist option")].map((o) => o.getAttribute("value"))).toEqual(["Order", "Payment", "lab-queue", "payments"]);

    await type(input(sheet, "Workflow type"), "Order");
    await type(input(sheet, "Task queue"), "lab-queue");
    await waitFor(() => byText("2 workers polling") !== null, "the queue hint", 2000);
    expect(describeQueue).toHaveBeenLastCalledWith({ connId: "conn-1", namespace: "lab", taskQueue: "lab-queue" });
    await type(input(sheet, "Workflow ID"), "ord-from-sheet");
    await waitFor(() => editorArea("Input") !== null, "the input editor");
    await type(editorArea("Input")!, '["ord-9", {"rush": true}]');
    await settle(2);
    expect(await axeViolations(sheet)).toEqual([]);

    await key("Enter", { ctrlKey: true }, input(sheet, "Workflow ID"));
    await waitFor(() => start.mock.calls.length === 1, "the start");
    expect(start.mock.calls[0]![0]).toEqual({ connId: "conn-1", namespace: "lab", workflowType: "Order", taskQueue: "lab-queue", workflowId: "ord-from-sheet", args: ["ord-9", { rush: true }] });
    await waitFor(() => sheetOf("start-workflow") === null, "the sheet to close");
    expect(notices[0]?.title).toBe("Started ord-from-sheet");
    notices[0]!.action!.onClick();
    expect(p.openTab).toHaveBeenCalledWith({ kind: "temporal.workflow", params: { namespace: "lab", workflowId: "ord-from-sheet", runId: "run-new" }, title: "ord-from-sheet" });
  });

  test("the folded sections show their values and go into the request; the CLI command is the same request", async () => {
    const { client, start } = workflowsClient();
    const p = props(client, { kind: "temporal.workflows", params: { namespace: "lab", query: "" } });
    withNotices(<WorkflowsTab {...p} />);
    await waitFor(() => byText("pay-1") !== null, "the rows");
    await click(byRole("button", "Start workflow"));
    await waitFor(() => sheetOf("start-workflow") !== null, "the sheet");
    const sheet = sheetOf("start-workflow")!;
    expect(isDisabled(byRole("button", "Copy as CLI command", sheet))).toBe(true);
    await type(input(sheet, "Workflow type"), "Payment");
    await type(input(sheet, "Task queue"), "payments");
    await type(input(sheet, "Workflow ID"), "pay-it's");
    await type(input(sheet, "Execution"), "1h");
    await type(input(sheet, "Maximum attempts"), "3");
    await type(input(sheet, "Start delay"), "soon");
    expect(byText("execution 1h · run none · task 10s · retry 3 attempts")).not.toBeNull();
    expect(sheet.textContent).toContain("This writes to lab.");
    await click(byRole("button", /^Start workflow/, sheet));
    expect(start).not.toHaveBeenCalled();
    expect(byText("Start delay: a duration such as 30s, 5m, 1h30m or 2d.")).not.toBeNull();
    await type(input(sheet, "Start delay"), "30s");
    await click(byRole("button", "Copy as CLI command", sheet));
    await waitFor(() => clipboard.mock.calls.length === 1, "the copy");
    expect(clipboard.mock.calls[0]![0]).toBe(
      `temporal workflow start --address 127.0.0.1:7233 --namespace lab --type Payment --task-queue payments --workflow-id 'pay-it'\\''s' --execution-timeout 1h --start-delay 30s # retry policy {"maximumAttempts":3} has no CLI flag`,
    );
    await click(byRole("button", /^Start workflow/, sheet));
    await waitFor(() => start.mock.calls.length === 1, "the start");
    expect(start.mock.calls[0]![0]).toEqual({ connId: "conn-1", namespace: "lab", workflowType: "Payment", taskQueue: "payments", workflowId: "pay-it's", args: [], executionTimeout: "1h", retryPolicy: { maximumAttempts: 3 }, startDelay: "30s" });
  });

  test("a refused start stays open with the server's error; a palette request opens the sheet", async () => {
    const { client, start } = workflowsClient();
    start.mockRejectedValueOnce(new RpcError("FailedPrecondition", "workflow already started", { details: { kind: "AlreadyExists", system: "temporal", message: "Workflow execution is already running.", retryable: false } }));
    const p = props(client, { kind: "temporal.workflows", params: { namespace: "lab", query: "" } });
    requestSheet("01T", "startWorkflow");
    withNotices(<WorkflowsTab {...p} />);
    await waitFor(() => sheetOf("start-workflow") !== null, "the sheet the palette asked for");
    const sheet = sheetOf("start-workflow")!;
    await type(input(sheet, "Workflow type"), "Order");
    await type(input(sheet, "Task queue"), "lab-queue");
    await click(byRole("button", /^Start workflow/, sheet));
    await waitFor(() => byText("Workflow execution is already running.") !== null || byText(/already/) !== null, "the error");
    expect(sheetOf("start-workflow")).not.toBeNull();
  });

  test("Start another like this fills the type, queue and input", async () => {
    const client = { temporal: { taskQueues: { describe: async () => ({ workflowPollers: [], activityPollers: [] }) } } };
    const p = props(client, { kind: "temporal.workflow", params: {} });
    withNotices(<StartWorkflowSheet open onOpenChange={() => {}} client={client as never} connId="conn-1" profile={p.profile} namespace="lab" prefill={{ workflowType: "Order", taskQueue: "lab-queue", args: ["ord-1"], memo: { owner: "ops" } }} note={describeError} onOpenWorkflow={() => {}} />);
    await waitFor(() => sheetOf("start-workflow") !== null, "the sheet");
    const sheet = sheetOf("start-workflow")!;
    expect(input(sheet, "Workflow type").value).toBe("Order");
    expect(input(sheet, "Task queue").value).toBe("lab-queue");
    expect(input(sheet, "Workflow ID").value).toMatch(/^Order-[0-9a-z]+$/);
    await waitFor(() => editorArea("Input") !== null, "the input editor");
    expect(JSON.parse(editorArea("Input")!.value)).toEqual(["ord-1"]);
    await waitFor(() => byText("No worker is polling this task queue.") !== null, "the queue hint", 2000);
    expect(byText("owner")).not.toBeNull();
    expect(byText("If a run with this ID is open: Fail (ID conflict policy). Reuse after close: allowed.")).not.toBeNull();
    const before = input(sheet, "Workflow ID").value;
    await click(byRole("button", "New random ID", sheet));
    expect(input(sheet, "Workflow ID").value).not.toBe(before);
  });
});

// --- Schedules ----------------------------------------------------------------------------------

const detail = (): ScheduleDetail => ({
  summary: { scheduleId: "nightly", workflowType: "Report", spec: "Calendar", paused: false, notes: "", nextRuns: [], recentActions: [] },
  spec: {},
  action: {},
  policies: {},
  state: {},
  info: {},
  form: {
    spec: { calendars: [{ second: "0", minute: "30", hour: "4", dayOfWeek: "1-5" }], intervals: [], cronStrings: [], timezone: "Europe/Berlin" },
    action: { workflowType: "Report", taskQueue: "lab", workflowId: "report", args: ["daily"] },
    policies: { overlap: "skip", pauseOnFailure: false },
    state: { paused: false, notes: "" },
  },
  conflictToken: "dG9rZW4tMQ==",
});

describe("Create schedule", () => {
  test("a calendar spec with its next runs in the browser, then the create request", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-18T10:00:00Z") });
    try {
      const create = vi.fn(async (_input: unknown) => ({}));
      const client = { temporal: { taskQueues: { describe: async () => ({ workflowPollers: [], activityPollers: [] }) }, schedules: { list: async () => [], create } } };
      const p = props(client, { kind: "temporal.schedules", params: { namespace: "lab" } });
      const { notices } = withNotices(<SchedulesTab {...p} />);
      await waitFor(() => byText("No schedules in lab.") !== null, "the empty list");
      await click(byRole("button", "Create schedule"));
      await waitFor(() => sheetOf("schedule-form") !== null, "the sheet");
      const sheet = sheetOf("schedule-form")!;
      await type(input(sheet, "Time zone"), "UTC");
      await type(input(sheet, "Hour"), "7");
      await type(input(sheet, "Minute"), "*/30");
      await type(input(sheet, "Day of week"), "mon-fri");
      const runs = () => [...sheet.querySelectorAll('[aria-label="Next runs"] li')].map((li) => li.textContent?.replace(/ ·$/, ""));
      expect(runs()).toEqual(["Thu 19 Nov 2026, 07:00 UTC", "Thu 19 Nov, 07:30", "Fri 20 Nov, 07:00", "Fri 20 Nov, 07:30", "Mon 23 Nov, 07:00"]);
      expect(byText("Mon to Fri at 07:00, 07:30")).not.toBeNull();
      expect(byText(/Computed in the browser/)).not.toBeNull();
      await type(input(sheet, "Hour"), "26");
      expect(byText("The hour is 0 to 23.")).not.toBeNull();
      expect(byText("Correct the spec to see its runs.")).not.toBeNull();
      await type(input(sheet, "Hour"), "7");

      await type(input(sheet, "Schedule ID"), "morning");
      await type(input(sheet, "Workflow type"), "Report");
      await type(input(sheet, "Task queue"), "lab");
      await type(input(sheet, "Workflow ID"), "report");
      expect(await axeViolations(sheet)).toEqual([]);
      await click(byRole("button", "Show as JSON", sheet));
      expect(sheet.textContent).toContain('"scheduleId": "morning"');
      await click(byRole("button", "Create schedule", sheet));
      await waitFor(() => create.mock.calls.length === 1, "the create");
      expect(create.mock.calls[0]![0]).toEqual({
        connId: "conn-1",
        namespace: "lab",
        scheduleId: "morning",
        schedule: {
          spec: { calendars: [{ minute: "*/30", hour: "7", dayOfWeek: "mon-fri" }], intervals: [], cronStrings: [], timezone: "UTC" },
          action: { workflowType: "Report", taskQueue: "lab", workflowId: "report", args: [] },
          policies: { pauseOnFailure: false },
          state: { paused: false, notes: "" },
        },
      });
      expect(notices[0]?.title).toBe("Created morning");
      expect(p.openTab).toHaveBeenCalledWith({ kind: "temporal.schedule", params: { namespace: "lab", scheduleId: "morning" }, title: "morning" });
    } finally {
      vi.useRealTimers();
    }
  });

  test("Interval and Cron segments preview too, and the cron's CLI command is copied", async () => {
    const client = { temporal: { taskQueues: { describe: async () => ({ workflowPollers: [], activityPollers: [] }) }, schedules: { list: async () => [], create: vi.fn() } } };
    const p = props(client, { kind: "temporal.schedules", params: { namespace: "lab" } });
    withNotices(<SchedulesTab {...p} />);
    await waitFor(() => byText("No schedules in lab.") !== null, "the empty list");
    await click(byRole("button", "Create schedule"));
    await waitFor(() => sheetOf("schedule-form") !== null, "the sheet");
    const sheet = sheetOf("schedule-form")!;
    const runs = () => sheet.querySelectorAll('[aria-label="Next runs"] li').length;
    await click(byRole("button", "Interval", sheet));
    await type(input(sheet, "Every"), "15m");
    expect(runs()).toBe(5);
    await type(input(sheet, "Every"), "often");
    expect(byText("A duration such as 30s, 5m, 1h30m or 2d.")).not.toBeNull();
    await click(byRole("button", "Cron", sheet));
    await type(input(sheet, "Cron string"), "@hourly");
    expect(runs()).toBe(5);
    await type(input(sheet, "Time zone"), "UTC");
    await type(input(sheet, "Schedule ID"), "hourly");
    await type(input(sheet, "Workflow type"), "Report");
    await type(input(sheet, "Task queue"), "lab");
    await type(input(sheet, "Workflow ID"), "report");
    await click(byRole("button", "Show as JSON", sheet));
    await click(byRole("button", "Copy as CLI command", sheet));
    await waitFor(() => clipboard.mock.calls.length === 1, "the copy");
    expect(clipboard.mock.calls[0]![0]).toBe("temporal schedule create --address 127.0.0.1:7233 --namespace lab --schedule-id hourly --cron @hourly --time-zone UTC --workflow-type Report --task-queue lab --workflow-id report");
  });
});

describe("Edit schedule", () => {
  function editSetup() {
    const update = vi.fn(async (_input: unknown) => ({}));
    const describeSchedule = vi.fn(async (_input: unknown) => detail());
    const client = { temporal: { taskQueues: { describe: async () => ({ workflowPollers: [], activityPollers: [] }) }, schedules: { describe: describeSchedule, update } } };
    const p = props(client, { kind: "temporal.schedule", params: { namespace: "lab", scheduleId: "nightly" } });
    const out = withNotices(<ScheduleTab {...p} />);
    return { ...out, update, describeSchedule, p };
  }

  test("prefilled from describe.form, the ID fixed; the changes are listed before the update with the token", async () => {
    const { update, describeSchedule, notices } = editSetup();
    await waitFor(() => byRole("button", "Edit") !== null && !isDisabled(byRole("button", "Edit")), "the loaded schedule");
    await click(byRole("button", "Edit"));
    await waitFor(() => sheetOf("schedule-form") !== null, "the sheet");
    const sheet = sheetOf("schedule-form")!;
    expect(() => input(sheet, "Schedule ID")).toThrow();
    expect(input(sheet, "Hour").value).toBe("4");
    expect(input(sheet, "Time zone").value).toBe("Europe/Berlin");
    expect(input(sheet, "Workflow type").value).toBe("Report");

    await click(byRole("button", "Review changes", sheet));
    expect(byText("Nothing changed.")).not.toBeNull();
    expect(isDisabled(byRole("button", "Update schedule", sheet))).toBe(true);

    await type(input(sheet, "Hour"), "5");
    await type(input(sheet, "Notes"), "moved an hour later");
    await click(byRole("button", "Review changes", sheet));
    const changes = sheet.querySelector('[aria-label="Changes"]')!;
    expect(changes.textContent).toContain("2 changes to send");
    expect(changes.textContent).toContain("When · calendar 1 · hour: 4 → 5");
    expect(changes.textContent).toContain("State · notes: not set → moved an hour later");
    expect(await axeViolations(sheet)).toEqual([]);
    await click(byRole("button", "Update schedule", sheet));
    await waitFor(() => update.mock.calls.length === 1, "the update");
    const sent = update.mock.calls[0]![0] as { conflictToken: string; schedule: { spec: { calendars: unknown[] }; state: { notes: string } } };
    expect(sent.conflictToken).toBe("dG9rZW4tMQ==");
    expect(sent.schedule.spec.calendars).toEqual([{ second: "0", minute: "30", hour: "5", dayOfWeek: "1-5" }]);
    expect(sent.schedule.state.notes).toBe("moved an hour later");
    expect(notices[0]?.title).toBe("Updated nightly");
    await waitFor(() => describeSchedule.mock.calls.length === 2, "the reload after saving");
  });

  test("a concurrent change is a Conflict with Reload, which refills the sheet from the stored schedule", async () => {
    const { update, describeSchedule } = editSetup();
    update.mockRejectedValueOnce(new RpcError("FailedPrecondition", "conflict", { details: { kind: "Conflict", system: "temporal", message: "The schedule changed since it was read.", retryable: false } }));
    await waitFor(() => byRole("button", "Edit") !== null && !isDisabled(byRole("button", "Edit")), "the loaded schedule");
    await click(byRole("button", "Edit"));
    await waitFor(() => sheetOf("schedule-form") !== null, "the sheet");
    const sheet = sheetOf("schedule-form")!;
    await type(input(sheet, "Hour"), "6");
    await click(byRole("button", "Review changes", sheet));
    await click(byRole("button", "Update schedule", sheet));
    await waitFor(() => byText("The schedule changed meanwhile") !== null, "the conflict");
    const stored = detail();
    stored.form.spec.calendars = [{ second: "0", minute: "0", hour: "8" }];
    stored.conflictToken = "dG9rZW4tMg==";
    describeSchedule.mockResolvedValueOnce(stored);
    await click(byRole("button", "Reload", sheet));
    await waitFor(() => input(sheet, "Hour").value === "8", "the stored version");
    expect(byText("The schedule changed meanwhile")).toBeNull();
    await type(input(sheet, "Minute"), "15");
    await click(byRole("button", "Review changes", sheet));
    await click(byRole("button", "Update schedule", sheet));
    await waitFor(() => update.mock.calls.length === 2, "the second update");
    expect((update.mock.calls[1]![0] as { conflictToken: string }).conflictToken).toBe("dG9rZW4tMg==");
  });
});
