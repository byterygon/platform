// The readings behind the screens brought to the TSK-91 mockup: a pending activity (state,
// attempt, failure chain, next attempt), a worker's version, a calendar as cron.
import { describe, expect, test } from "vitest";
import { nextAttemptText, readPendingActivity } from "@/tools/temporal/PendingPanel";
import { cronOfCalendar } from "@/tools/temporal/ScheduleSheet";
import { payloadLabel } from "@/tools/temporal/HistoryPanel";
import { describeCalendar, parseRunsText } from "@/tools/temporal/schedule-preview";
import { versionText } from "@/tools/temporal/WorkersTab";

describe("a pending activity", () => {
  const info = {
    activityId: "12",
    activityType: { name: "ChargePayment" },
    state: "PENDING_ACTIVITY_STATE_SCHEDULED",
    attempt: 3,
    maximumAttempts: 5,
    scheduledTime: "2026-11-18T09:42:08Z",
    lastStartedTime: "2026-11-18T09:46:40Z",
    nextAttemptScheduleTime: "2026-11-18T09:47:04Z",
    lastWorkerIdentity: "payments-5d8b@host-7",
    activityOptions: { taskQueue: { name: "payments" }, retryPolicy: { initialInterval: "1s", backoffCoefficient: 2 } },
    lastFailure: { message: "issuer did not answer in 10s", applicationFailureInfo: { type: "CardDeclined" }, stackTrace: "at chargeCard (payments/card.ts:88:11)", cause: { message: "issuer 10s", applicationFailureInfo: { type: "TimeoutError" } } },
  };

  test("reads as the mockup writes it", () => {
    const a = readPendingActivity(info);
    expect(a).toMatchObject({ activityId: "12", type: "ChargePayment", state: "Retrying", retrying: true, attempt: 3, maximumAttempts: 5, failure: "CardDeclined: issuer did not answer in 10s", taskQueue: "payments", backoff: "backoff 2 × from 1 s", lastWorker: "payments-5d8b@host-7" });
    expect(a.stack.split("\n")).toEqual(["ApplicationError: CardDeclined", "  issuer did not answer in 10s", "  at chargeCard (payments/card.ts:88:11)", "caused by: ApplicationError: TimeoutError", "  issuer 10s"]);
  });

  test("a first attempt without a failure keeps the server's state", () => {
    expect(readPendingActivity({ activityId: "1", activityType: { name: "a" }, state: "PENDING_ACTIVITY_STATE_STARTED", attempt: 1 })).toMatchObject({ state: "Started", retrying: false, failure: "", backoff: "" });
  });

  test("the next attempt counts down", () => {
    const at = Date.parse("2026-11-18T09:47:04Z");
    expect(nextAttemptText(at, at - 3200)).toBe("in 4 s");
    expect(nextAttemptText(at, at + 1)).toBe("now");
    expect(nextAttemptText(null, at)).toBe("");
  });
});

describe("a worker's version", () => {
  test("a long hash build is cut, a named one kept, the deployment first", () => {
    expect(versionText(undefined, "3caaa00bdbb48c2292bc2c31083bf1ff")).toBe("build 3caaa00");
    expect(versionText("2.4.0", "8c1e2a")).toBe("2.4.0 · 8c1e2a");
    expect(versionText(null, null)).toBe("");
  });
});

describe("a calendar as cron", () => {
  test("whole-minute calendars read as 5 fields; seconds have none", () => {
    expect(cronOfCalendar({ second: "", minute: "", hour: "2", dayOfMonth: "", month: "", dayOfWeek: "" })).toBe("0 2 * * *");
    expect(cronOfCalendar({ second: "0", minute: "30", hour: "9", dayOfMonth: "", month: "", dayOfWeek: "mon-fri" })).toBe("30 9 * * mon-fri");
    expect(cronOfCalendar({ second: "15", minute: "", hour: "", dayOfMonth: "", month: "", dayOfWeek: "" })).toBeNull();
  });
});

describe("a payload label", () => {
  test("names the forms as stored and counts them", () => {
    expect(payloadLabel(["json/plain"])).toBe("json/plain · 1 payload");
    expect(payloadLabel(["binary/encrypted", "json/plain", "binary/encrypted"])).toBe("binary/encrypted, json/plain · 3 payloads");
    expect(payloadLabel(undefined)).toBe("no payloads");
  });
});

describe("a schedule written in words", () => {
  test("reads back what describeCalendar writes, and a few more", () => {
    const cases: [string, Record<string, string>][] = [
      ["Every day at 02:00", { hour: "2", minute: "0", dayOfWeek: "" }],
      ["Mon to Fri at 09:30", { hour: "9", minute: "30", dayOfWeek: "1-5" }],
      ["Mon, Wed at 07:00, 07:30", { hour: "7", minute: "0,30", dayOfWeek: "1,3" }],
      ["Every hour at :15", { hour: "*", minute: "15" }],
      ["Every 15 minutes", { hour: "*", minute: "*/15" }],
      ["Weekdays at 9:00", { hour: "9", dayOfWeek: "1-5" }],
      ["Day 1 of the month, in Jan at 03:00", { hour: "3", dayOfMonth: "1", month: "1" }],
    ];
    for (const [text, expected] of cases) expect(parseRunsText(text), text).toMatchObject(expected);
    // Round trip: what the sheet shows reads back as the same schedule.
    for (const c of [{ hour: "2" }, { hour: "9", minute: "30", dayOfWeek: "1-5" }, { hour: "*", minute: "15" }]) {
      const words = describeCalendar(c)!;
      expect(describeCalendar(parseRunsText(words)!), words).toBe(words);
    }
    expect(parseRunsText("at 07:00, 08:30")).toBeNull();
    expect(parseRunsText("someday")).toBeNull();
    expect(parseRunsText("Every day at 25:00")).toBeNull();
  });
});
