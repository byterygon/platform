// The pure parts of TSK-92's Write sheets: the next runs computed in the browser (calendars, cron,
// intervals, time zones, bounds), durations, the CLI commands and the schedule sheet's draft.
import { describe, expect, test } from "vitest";
import type { ScheduleForm } from "@/gen/api";
import { scheduleCommand, shellQuote, workflowStartCommand } from "@/tools/temporal/cli";
import { changesOf, draftErrors, draftOfForm, formOf, newDraft } from "@/tools/temporal/schedule-draft";
import { describeCalendar, formatDurationText, formatRun, formatRuns, instantOf, nextRuns, parseCalendarField, parseCron, parseDuration } from "@/tools/temporal/schedule-preview";
import { prefillOf } from "@/tools/temporal/WorkflowTab";

const iso = (runs: Date[]) => runs.map((r) => r.toISOString());
const spec = (patch: Partial<Parameters<typeof nextRuns>[0]>) => ({ calendars: [], intervals: [], cronStrings: [], ...patch });
const FROM = new Date("2026-11-18T10:15:30Z"); // a Wednesday

describe("durations", () => {
  test("read as the server reads them and written back", () => {
    expect(parseDuration("")).toBeNull();
    expect(parseDuration("90")).toBe(90_000);
    expect(parseDuration("1h30m")).toBe(5_400_000);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseDuration("2d")).toBe(172_800_000);
    expect(parseDuration("1x")).toBe("invalid");
    expect(parseDuration("h")).toBe("invalid");
    expect(formatDurationText(5_400_000)).toBe("1h30m");
    expect(formatDurationText(0)).toBe("0s");
    expect(formatDurationText(1500)).toBe("1s500ms");
  });
});

describe("calendar strings", () => {
  test("ranges, steps, lists, names and the defaults", () => {
    expect(parseCalendarField("hour", "")).toEqual([0]);
    expect(parseCalendarField("dayOfMonth", "")).toHaveLength(31);
    expect(parseCalendarField("year", "")).toBeNull();
    expect(parseCalendarField("minute", "*/15")).toEqual([0, 15, 30, 45]);
    expect(parseCalendarField("minute", "5/20")).toEqual([5, 25, 45]);
    expect(parseCalendarField("hour", "9-17/4")).toEqual([9, 13, 17]);
    expect(parseCalendarField("minute", "0,30")).toEqual([0, 30]);
    expect(parseCalendarField("dayOfWeek", "mon-fri")).toEqual([1, 2, 3, 4, 5]);
    expect(parseCalendarField("dayOfWeek", "7")).toEqual([0]);
    expect(parseCalendarField("month", "Jan,dec")).toEqual([1, 12]);
  });

  test("what cannot be read says why", () => {
    expect(parseCalendarField("hour", "24")).toEqual({ error: "The hour is 0 to 23." });
    expect(parseCalendarField("minute", "5-1")).toEqual({ error: '"5-1" ends before it starts.' });
    expect(parseCalendarField("minute", "*/0")).toEqual({ error: 'The step of "*/0" is a whole number from 1.' });
    expect(parseCalendarField("dayOfWeek", "funday")).toEqual({ error: '"funday" is not a day of the week.' });
    expect(parseCalendarField("minute", "1,,2")).toEqual({ error: "An empty item in the list." });
  });
});

describe("cron strings", () => {
  test("5, 6 and 7 fields, shorthands, @every and the time zone prefix", () => {
    expect(parseCron("30 4 * * 1-5")).toEqual({ calendar: { minute: "30", hour: "4", dayOfMonth: "*", month: "*", dayOfWeek: "1-5" } });
    expect(parseCron("0 0 1 1 * 2027")).toEqual({ calendar: { minute: "0", hour: "0", dayOfMonth: "1", month: "1", dayOfWeek: "*", year: "2027" } });
    expect(parseCron("15 0 0 * * ? *")).toEqual({ calendar: { second: "15", minute: "0", hour: "0", dayOfMonth: "*", month: "*", dayOfWeek: "*", year: "*" } });
    expect(parseCron("@daily")).toEqual({ calendar: {} });
    expect(parseCron("CRON_TZ=Asia/Ho_Chi_Minh @hourly # every hour")).toEqual({ calendar: { hour: "*" }, timezone: "Asia/Ho_Chi_Minh" });
    expect(parseCron("@every 90m/15m")).toEqual({ interval: { every: "90m", offset: "15m" } });
    expect(parseCron("* * *")).toEqual({ error: "A cron string has 5, 6 or 7 fields; this one has 3." });
    expect(parseCron("@sometimes")).toEqual({ error: '"@sometimes" is not a cron shorthand.' });
  });
});

describe("next runs", () => {
  test("a calendar in UTC: weekdays at 09:00", () => {
    const p = nextRuns(spec({ calendars: [{ hour: "9", dayOfWeek: "1-5" }] }), FROM);
    expect(iso(p.runs)).toEqual(["2026-11-19T09:00:00.000Z", "2026-11-20T09:00:00.000Z", "2026-11-23T09:00:00.000Z", "2026-11-24T09:00:00.000Z", "2026-11-25T09:00:00.000Z"]);
    expect(p.errors).toEqual({});
  });

  test("a calendar in Europe/Berlin crosses the spring clock change", () => {
    const from = new Date("2026-03-27T00:00:00Z");
    const p = nextRuns(spec({ calendars: [{ hour: "8", minute: "30" }], timezone: "Europe/Berlin" }), from, 4);
    // 08:30 CET is 07:30Z; from 29 March 08:30 CEST is 06:30Z.
    expect(iso(p.runs)).toEqual(["2026-03-27T07:30:00.000Z", "2026-03-28T07:30:00.000Z", "2026-03-29T06:30:00.000Z", "2026-03-30T06:30:00.000Z"]);
    expect(formatRun(p.runs[2]!, "Europe/Berlin")).toBe("Sun 2026-03-29 08:30:00 Europe/Berlin");
  });

  test("wall times in a clock change: a skipped one moves forward, a repeated one is the first", () => {
    expect(new Date(instantOf({ year: 2026, month: 3, day: 29, hour: 2, minute: 30, second: 0 }, "Europe/Berlin")).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(new Date(instantOf({ year: 2026, month: 10, day: 25, hour: 2, minute: 30, second: 0 }, "Europe/Berlin")).toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });

  test("a cron string with CRON_TZ, and the two day fields must both match", () => {
    const p = nextRuns(spec({ cronStrings: ["CRON_TZ=Asia/Ho_Chi_Minh 0 7 13 * 5"] }), FROM, 2);
    // Friday the 13th at 07:00 in Ho Chi Minh City (UTC+7).
    expect(iso(p.runs)).toEqual(["2027-08-13T00:00:00.000Z", "2028-10-13T00:00:00.000Z"]);
  });

  test("an interval is aligned on the epoch plus its offset", () => {
    const p = nextRuns(spec({ intervals: [{ every: "1h", offset: "15m" }] }), FROM, 3);
    expect(iso(p.runs)).toEqual(["2026-11-18T11:15:00.000Z", "2026-11-18T12:15:00.000Z", "2026-11-18T13:15:00.000Z"]);
  });

  test("entries merge in time order; start and end time bound them", () => {
    const p = nextRuns(spec({ calendars: [{ hour: "12" }], intervals: [{ every: "6h" }], startTime: "2026-11-19T00:00:00Z", endTime: "2026-11-19T13:00:00Z" }), FROM, 10);
    expect(iso(p.runs)).toEqual(["2026-11-19T00:00:00.000Z", "2026-11-19T06:00:00.000Z", "2026-11-19T12:00:00.000Z"]);
  });

  test("a part that cannot be read is named and the rest still runs", () => {
    const p = nextRuns(spec({ calendars: [{ hour: "25" }], intervals: [{ every: "1d" }], cronStrings: ["bad"], timezone: "Mars/Olympus" }), FROM, 1);
    expect(p.errors).toEqual({
      timezone: 'The browser does not know the time zone "Mars/Olympus".',
      "calendar 1 hour": "The hour is 0 to 23.",
      "cron 1": "A cron string has 5, 6 or 7 fields; this one has 1.",
    });
    expect(iso(p.runs)).toEqual(["2026-11-19T00:00:00.000Z"]);
  });

  test("a date that never comes gives no run", () => {
    expect(nextRuns(spec({ calendars: [{ dayOfMonth: "31", month: "2" }] }), FROM).runs).toEqual([]);
  });
});

describe("in words", () => {
  test("a calendar reads as the mockup writes it", () => {
    expect(describeCalendar({ hour: "2" })).toBe("Every day at 02:00");
    expect(describeCalendar({ hour: "9", minute: "30", dayOfWeek: "mon-fri" })).toBe("Mon to Fri at 09:30");
    expect(describeCalendar({ hour: "*", minute: "15" })).toBe("Every hour at :15");
    expect(describeCalendar({ hour: "7", minute: "0,30", dayOfWeek: "1,3" })).toBe("Mon, Wed at 07:00, 07:30");
    expect(describeCalendar({ hour: "3", dayOfMonth: "1", month: "jan" })).toBe("Day 1 of the month, in Jan at 03:00");
    expect(describeCalendar({ hour: "25" })).toBeNull();
  });

  test("the runs: the first with its year and zone, the next ones short", () => {
    const runs = nextRuns(spec({ calendars: [{ hour: "2" }], timezone: "Europe/Berlin" }), new Date("2026-12-30T12:00:00Z"), 3).runs;
    expect(formatRuns(runs, "Europe/Berlin")).toEqual(["Thu 31 Dec 2026, 02:00 CET", "Fri 1 Jan 2027, 02:00", "Sat 2 Jan, 02:00"]);
  });
});

describe("CLI commands", () => {
  const target = { address: "127.0.0.1:7233", namespace: "lab", tls: false };

  test("single quotes are escaped and safe words stay bare", () => {
    expect(shellQuote("lab-queue")).toBe("lab-queue");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('["a b"]')).toBe(`'["a b"]'`);
  });

  test("temporal workflow start with every option, never a secret", () => {
    const line = workflowStartCommand(
      { workflowType: "Order", taskQueue: "lab", workflowId: "ord-1", args: ["it's", { n: 2 }], executionTimeout: "1h", idReusePolicy: "rejectDuplicate", idConflictPolicy: "useExisting", memo: { owner: "ops" }, searchAttributes: { CustomKeywordField: "x" }, startDelay: "30s" },
      { ...target, tls: true },
    );
    expect(line).toBe(
      `temporal workflow start --address 127.0.0.1:7233 --namespace lab --tls --type Order --task-queue lab --workflow-id ord-1 --input '"it'\\''s"' --input '{"n":2}' --execution-timeout 1h --id-reuse-policy RejectDuplicate --id-conflict-policy UseExisting --memo 'owner="ops"' --search-attribute 'CustomKeywordField="x"' --start-delay 30s`,
    );
    expect(workflowStartCommand({ workflowType: "A", taskQueue: "q", workflowId: "w", retryPolicy: { maximumAttempts: 3 } }, target)).toContain(`# retry policy {"maximumAttempts":3} has no CLI flag`);
  });

  test("temporal schedule create and update", () => {
    const form: ScheduleForm = {
      spec: { calendars: [{ hour: "9", dayOfWeek: "1-5", comment: null }], intervals: [{ every: "1h", offset: "15m" }], cronStrings: ["0 3 * * *"], timezone: "Europe/Berlin" },
      action: { workflowType: "Report", taskQueue: "lab", workflowId: "report", args: [1] },
      policies: { overlap: "bufferOne", catchupWindow: "10m", pauseOnFailure: true },
      state: { paused: true, notes: "on hold", remainingActions: 5 },
    };
    expect(scheduleCommand("create", "nightly", form, target)).toBe(
      `temporal schedule create --address 127.0.0.1:7233 --namespace lab --schedule-id nightly --calendar '{"hour":"9","dayOfWeek":"1-5"}' --interval 1h/15m --cron '0 3 * * *' --time-zone Europe/Berlin --workflow-type Report --task-queue lab --workflow-id report --input 1 --overlap-policy BufferOne --catchup-window 10m --pause-on-failure --paused --notes 'on hold' --remaining-actions 5`,
    );
    expect(scheduleCommand("update", "nightly", form, target)).toMatch(/^temporal schedule update /);
  });
});

describe("the schedule draft", () => {
  const stored: ScheduleForm = {
    spec: { calendars: [{ second: "0", minute: "30", hour: "4", dayOfWeek: "1-5" }, { hour: "12", dayOfMonth: "1" }], intervals: [], cronStrings: [], timezone: "Europe/Berlin" },
    action: { workflowType: "Report", taskQueue: "lab", workflowId: "report", args: ["a"], memo: { owner: "ops" } },
    policies: { overlap: "skip", pauseOnFailure: false },
    state: { paused: false, notes: "" },
  };

  test("a stored form round-trips; the second calendar is kept", () => {
    const d = draftOfForm("nightly", stored);
    expect(d.when).toBe("calendar");
    expect(d.calendar.hour).toBe("4");
    expect(d.rest.calendars).toEqual([{ hour: "12", dayOfMonth: "1" }]);
    expect(draftErrors(d, true)).toEqual({});
    expect(formOf(d)).toEqual(stored);
    expect(changesOf(stored, formOf(d))).toEqual([]);
  });

  test("an edit lists what it changes", () => {
    const d = { ...draftOfForm("nightly", stored), calendar: { ...draftOfForm("nightly", stored).calendar, hour: "5" }, paused: true, notes: "holiday", memo: "" };
    expect(changesOf(stored, formOf(d))).toEqual([
      { label: "When · calendar 1 · hour", before: "4", after: "5" },
      { label: "Workflow · memo", before: '{"owner":"ops"}', after: null },
      { label: "State · paused", before: "false", after: "true" },
      { label: "State · notes", before: null, after: "holiday" },
    ]);
  });

  test("a new draft needs an ID and a workflow; a cron and an interval are checked", () => {
    const d = newDraft();
    expect(Object.keys(draftErrors(d, false))).toEqual(["scheduleId", "workflowType", "taskQueue", "workflowId"]);
    expect(draftErrors({ ...d, when: "interval", every: "soon" }, false)["every"]).toBe("A duration such as 30s, 5m, 1h30m or 2d.");
    expect(draftErrors({ ...d, when: "cron", cron: "CRON_TZ=UTC 0 9 * * *", timezone: "Europe/Berlin" }, false)["cron"]).toContain("one place");
    const ok = { ...d, scheduleId: "s", workflowType: "T", taskQueue: "q", workflowId: "w", when: "interval" as const, every: "1h", offset: "5m" };
    expect(formOf(ok).spec).toEqual({ calendars: [], intervals: [{ every: "1h", offset: "5m" }], cronStrings: [], timezone: d.timezone });
  });
});

describe("Start another like this", () => {
  test("takes the type, queue, input, memo, timeouts and retry policy of the run", () => {
    const w = { workflowId: "ord-1", runId: "r", workflowType: "Order", status: "Completed" as const, startTime: "2026-11-18T00:00:00Z", taskQueue: "lab", historyLength: 5 };
    const started = {
      eventId: 1,
      eventTime: "2026-11-18T00:00:00Z",
      eventType: "WorkflowExecutionStarted",
      category: "Workflow" as const,
      size: 0,
      attributes: { input: ["a", { n: 1 }], memo: { fields: { owner: "ops" } }, workflowExecutionTimeout: "3600s", workflowRunTimeout: "0s", workflowTaskTimeout: "10s", retryPolicy: { initialInterval: "1s", backoffCoefficient: 2, maximumAttempts: 3 } },
    };
    expect(prefillOf(w as never, [started])).toEqual({ workflowType: "Order", taskQueue: "lab", args: ["a", { n: 1 }], memo: { owner: "ops" }, executionTimeout: "1h", retryPolicy: { initialInterval: "1s", backoffCoefficient: 2, maximumAttempts: 3 } });
  });
});
