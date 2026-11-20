// Standalone activities of the Temporal tool (Mightyconsole spec §9.3 "Activities", TSK-92) against
// a stub client: the list, a server without them, one activity with its input, result and actions,
// the Run activity request and its CLI command.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { ActivityDetail, ActivityRow } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { ActivitiesTab } from "@/tools/temporal/ActivitiesTab";
import { ActivityTab, protoDuration, retryPolicyText } from "@/tools/temporal/ActivityTab";
import { activityDraft, activityInputOf } from "@/tools/temporal/RunActivitySheet";
import { activityStartCommand, goDuration } from "@/tools/temporal/cli";
import { profile as schema } from "@/tools/temporal/profile";
import type { TabProps, TabView } from "@/tools/types";
import { axeViolations, byRole, byText, cleanup, click, dialogWith, render, settle, type, waitFor } from "./support/render";

afterEach(cleanup);

/** A patch that may unset optional fields (`undefined` drops them). */
type Loose<T> = { [K in keyof T]?: T[K] | undefined };
const strip = <T,>(o: Loose<T>): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const row = (patch: Loose<ActivityRow> = {}): ActivityRow => strip<ActivityRow>({
  activityId: "sa-charge-1",
  runId: "01a1f768",
  activityType: "charge",
  status: "Completed",
  startTime: "2026-11-20T10:43:30Z",
  closeTime: "2026-11-20T10:43:31Z",
  durationMs: 1200,
  taskQueue: "lab",
  ...patch,
});

const detail = (patch: Loose<ActivityDetail> = {}): ActivityDetail => strip<ActivityDetail>({
  activity: row(),
  attempt: 1,
  info: { startToCloseTimeout: "30s", retryPolicy: { initialInterval: "1s", backoffCoefficient: 2, maximumInterval: "100s", maximumAttempts: 3 }, lastWorkerIdentity: "1@worker" },
  input: ["ord-sa-1"],
  result: ["charged ord-sa-1"],
  ...patch,
});

const isDisabled = (el: HTMLElement | null) => el !== null && (el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true" || el.hasAttribute("data-disabled"));

function props(client: unknown, tab: Partial<TabView> & { kind: string; params: Record<string, unknown> }): TabProps & { openTab: ReturnType<typeof vi.fn> } {
  const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const openTab = vi.fn();
  return { tab: { id: "t", tool: "temporal", profileId: "01T", title: "t", pinned: false, ...tab }, profile, connId: "conn-1", client: client as MightyClient, active: true, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab };
}

const namespaces = { list: async () => [{ name: "lab" }] };

describe("Activities list", () => {
  test("lists standalone activities with their count; a row opens its tab", async () => {
    const list = vi.fn(async (_input: unknown) => ({ executions: [row(), row({ activityId: "sa-hold", status: "Running", closeTime: undefined, durationMs: undefined, activityType: "hold" })] }));
    const count = vi.fn(async () => ({ count: 2 }));
    const p = props({ temporal: { activities: { list, count }, namespaces } }, { kind: "temporal.activities", params: { namespace: "lab", query: "" } });
    const { container } = render(<ActivitiesTab {...p} />);
    await waitFor(() => byText("sa-hold") !== null, "the rows");
    expect(list).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", query: "", pageSize: 50, nextPageToken: null });
    const rows = Array.from(container.querySelectorAll("tbody tr")).map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("charge");
    expect(rows[0]).toContain("Completed");
    expect(rows[1]).toContain("Running");
    expect(byText(/· 2 activities/)).not.toBeNull();
    expect(isDisabled(byRole("button", "Run activity"))).toBe(false);
    await click(byRole("button", "sa-charge-1"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "temporal.activity", params: { namespace: "lab", activityId: "sa-charge-1", runId: "01a1f768" }, title: "sa-charge-1" });
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a server without them says why and Run activity stays, disabled", async () => {
    const reason = "This server does not run standalone activities: Standalone activity is disabled. Standalone activities need Temporal Server 1.31 or newer, enabled on the namespace (public preview).";
    const refused = () => Promise.reject(new RpcError("Internal", reason, { details: { kind: "Remote", system: "temporal", message: reason, retryable: false, remote: { code: "FailedPrecondition", name: "StandaloneActivitiesUnsupported" } } }));
    const p = props({ temporal: { activities: { list: refused, count: refused }, namespaces } }, { kind: "temporal.activities", params: { namespace: "lab", query: "" } });
    render(<ActivitiesTab {...p} />);
    await waitFor(() => byText("Standalone activities are not available here") !== null, "the reason");
    expect(byText(reason)).not.toBeNull();
    expect(isDisabled(byRole("button", "Run activity"))).toBe(true);
    expect(byText(/No standalone activities/)).toBeNull();
  });
});

describe("One activity", () => {
  test("shows what it is, its input and result; no actions once closed", async () => {
    const describe_ = vi.fn(async () => detail());
    const p = props({ temporal: { activities: { describe: describe_ } } }, { kind: "temporal.activity", params: { namespace: "lab", activityId: "sa-charge-1" } });
    const { container } = render(<ActivityTab {...p} />);
    await waitFor(() => byText("Overview") !== null, "the detail");
    expect(describe_).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", activityId: "sa-charge-1", runId: null });
    expect(byText("start to close 30s")).not.toBeNull();
    expect(byText("initial 1s, ×2, up to 1m 40s, 3 attempts")).not.toBeNull();
    expect(container.textContent).toContain("charged ord-sa-1");
    expect(byRole("button", "Request cancellation")).toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a running one is cancelled or terminated with a reason; a failure shows its message", async () => {
    let current = detail({ activity: row({ status: "Running", closeTime: undefined }), runState: "Started", result: undefined });
    const cancel = vi.fn(async () => ({}));
    const terminate = vi.fn(async () => {
      current = detail({ activity: row({ status: "Terminated" }), result: undefined, failure: { message: "lab test", terminatedFailureInfo: {} } });
      return {};
    });
    const p = props({ temporal: { activities: { describe: async () => current, cancel, terminate } } }, { kind: "temporal.activity", params: { namespace: "lab", activityId: "sa-charge-1" } });
    render(<ActivityTab {...p} />);
    await waitFor(() => byRole("button", "Request cancellation") !== null, "the actions");
    expect(byText("Running · started")).not.toBeNull();
    await click(byRole("button", "Request cancellation"));
    await waitFor(() => dialogWith("Request cancellation of sa-charge-1?") !== null, "the dialog");
    await click(byRole("button", "Request cancellation", dialogWith("Request cancellation of sa-charge-1?")!));
    expect(cancel).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", activityId: "sa-charge-1", runId: "01a1f768", reason: null });
    await settle();
    await click(byRole("button", "Terminate…"));
    await waitFor(() => dialogWith("Terminate sa-charge-1?") !== null, "the dialog");
    const inDialog = () => byRole("button", "Terminate", dialogWith("Terminate sa-charge-1?")!);
    expect(isDisabled(inDialog())).toBe(true);
    await type(byRole("textbox", "Reason (required)") as HTMLInputElement, "lab test");
    await click(inDialog());
    expect(terminate).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", activityId: "sa-charge-1", runId: "01a1f768", reason: "lab test" });
    await waitFor(() => byText("Failure") !== null, "the failure");
    expect(byText(/lab test/)).not.toBeNull();
  });
});

describe("Run activity", () => {
  test("the request needs a type, a queue, an ID and one of the close timeouts", () => {
    const d = activityDraft();
    expect(activityInputOf(d)).toEqual({ error: "Name the activity type." });
    const filled = { ...d, activityType: "charge", taskQueue: "lab", activityId: "sa-1", input: '["ord-1"]' };
    expect(activityInputOf({ ...filled, startToClose: "" })).toEqual({ error: "Timeouts: give start to close, schedule to close or both." });
    expect(activityInputOf({ ...filled, heartbeat: "5x" })).toEqual({ error: "Heartbeat timeout: a duration such as 30s, 5m, 1h30m or 2d." });
    expect(activityInputOf({ ...filled, scheduleToClose: "2d", idConflictPolicy: "useExisting", retry: { ...filled.retry, maximumAttempts: "3" } })).toEqual({
      input: { activityType: "charge", taskQueue: "lab", activityId: "sa-1", args: ["ord-1"], startToCloseTimeout: "30s", scheduleToCloseTimeout: "2d", retryPolicy: { maximumAttempts: 3 }, idConflictPolicy: "useExisting" },
    });
  });

  test("Copy as CLI command gives temporal activity start with Go durations", () => {
    expect(goDuration("2d3h")).toBe("48h3h");
    expect(goDuration("90")).toBe("90s");
    expect(goDuration("")).toBeNull();
    const line = activityStartCommand(
      { activityType: "charge", taskQueue: "lab", activityId: "sa 1", args: [{ a: 1 }], startToCloseTimeout: "30s", scheduleToCloseTimeout: "1d", retryPolicy: { maximumAttempts: 3, nonRetryableErrorTypes: ["Bad"] }, idReusePolicy: "rejectDuplicate" },
      { address: "127.0.0.1:7233", namespace: "lab", tls: false },
    );
    expect(line).toBe(
      `temporal activity start --address 127.0.0.1:7233 --namespace lab --type charge --task-queue lab --activity-id 'sa 1' --input '{"a":1}' --start-to-close-timeout 30s --schedule-to-close-timeout 24h --retry-maximum-attempts 3 --id-reuse-policy RejectDuplicate # non-retryable error types ["Bad"] have no CLI flag`,
    );
  });

  test("protobuf durations and retry policies read as people write them", () => {
    expect(protoDuration("30s")).toBe("30s");
    expect(protoDuration("0.250s")).toBe("250 ms");
    expect(protoDuration(undefined)).toBe("");
    expect(retryPolicyText(undefined)).toBe("Server default");
    expect(retryPolicyText({ maximumAttempts: 0 })).toBe("unlimited attempts");
  });
});
