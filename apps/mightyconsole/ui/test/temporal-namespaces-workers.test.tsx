// Namespaces and Workers of the Temporal tool (Mightyconsole spec §9.3, TSK-92) against a stub
// client: the namespace table and the selected one's pane with its search attributes and the
// buttons to its tabs; the workers from the pollers, their filters, the idle mark, a typed task
// queue and the refresh while the tab is shown.
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { NamespaceDetail, NamespaceSummary, WorkerRow, WorkersListOutput } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { NamespacesTab, formatBytes, formatRetention } from "@/tools/temporal/NamespacesTab";
import { REFRESH_MS, WorkersTab, filterWorkers, isIdle, pollsFor } from "@/tools/temporal/WorkersTab";
import { temporalTool } from "@/tools/temporal";
import { profile as schema } from "@/tools/temporal/profile";
import type { TabProps, TabRecord } from "@/tools/types";
import { axeViolations, byRole, byText, cleanup, click, render, type, waitFor } from "./support/render";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function props(client: unknown, tab: Partial<TabRecord> & { kind: string; params: Record<string, unknown> }, active = true): TabProps & { openTab: ReturnType<typeof vi.fn> } {
  const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  profile.fields["namespace"] = "lab";
  const openTab = vi.fn();
  return { tab: { id: "t", tool: "temporal", profileId: "01T", title: "t", pinned: false, ...tab }, profile, connId: "conn-1", client: client as MightyClient, active, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab };
}

const ns = (name: string, patch: Partial<NamespaceSummary> = {}): NamespaceSummary => ({ name, state: "Registered", retentionSecs: 86_400, description: "", ownerEmail: "", isGlobal: false, isDefault: false, ...patch });

const detail = (name: string): NamespaceDetail => ({
  name,
  id: `id-of-${name}`,
  state: "Registered",
  description: "",
  ownerEmail: "orders-team@example.test",
  retentionSecs: 2_592_000,
  historyArchival: { enabled: false, uri: "" },
  visibilityArchival: { enabled: true, uri: "s3://archive" },
  isGlobal: false,
  activeCluster: "active",
  clusters: ["active"],
  capabilities: ["eagerWorkflowStart", "standaloneActivities"],
  limits: { blobSizeLimitError: 2_097_152 },
  data: [],
});

describe("Namespaces", () => {
  test("lists them with the profile's one selected; its pane has settings, attributes and buttons", async () => {
    const list = vi.fn(async () => [ns("default"), ns("lab", { isDefault: true, retentionSecs: 129_600 })]);
    const describe = vi.fn(async ({ namespace }: { namespace: string }) => detail(namespace));
    const searchAttributes = vi.fn(async () => ({ attributes: [{ name: "CustomerTier", valueType: "Keyword", custom: true }, { name: "WorkflowType", valueType: "Keyword", custom: false }] }));
    const p = props({ temporal: { namespaces: { list, describe, searchAttributes } } }, { kind: "temporal.namespaces", params: {} });
    const { container } = render(<NamespacesTab {...p} />);
    await waitFor(() => byText("id-of-lab") !== null, "the pane of the profile's namespace");
    expect(byText("lab · 2 namespaces")).not.toBeNull();
    const rows = Array.from(container.querySelectorAll("table[aria-label='Namespaces'] tbody tr")).map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("1 day");
    expect(rows[1]).toContain("36 hours");
    expect(rows[1]).toContain("profile");
    expect(byText("s3://archive")).not.toBeNull();
    expect(byText("2 MiB")).not.toBeNull();
    expect(byText("eager workflow start, standalone activities")).not.toBeNull();
    await waitFor(() => byText("CustomerTier") !== null, "the attributes");
    expect(byText("custom")).not.toBeNull();

    await click(byRole("button", "Workers"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "temporal.workers", params: { namespace: "lab" }, title: "Workers · lab" });
    await click(byRole("button", "Workflows"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "temporal.workflows", params: { namespace: "lab", query: "" }, title: "Workflows · lab" });

    await click(byRole("button", "default"));
    await waitFor(() => byText("id-of-default") !== null, "the other namespace's pane");
    expect(describe).toHaveBeenLastCalledWith({ connId: "conn-1", namespace: "default" });
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a namespace that cannot be described shows the error in the pane, the list stays", async () => {
    const list = async () => [ns("lab", { isDefault: true })];
    const describe = () => Promise.reject(new Error("boom"));
    const p = props({ temporal: { namespaces: { list, describe, searchAttributes: async () => ({ attributes: [] }) } } }, { kind: "temporal.namespaces", params: {} });
    render(<NamespacesTab {...p} />);
    await waitFor(() => byRole("alert") !== null, "the error");
    expect(document.querySelector("table[aria-label='Namespaces'] tbody tr")?.textContent).toContain("lab");
  });

  test("retention and sizes read in words", () => {
    expect(formatRetention(86_400 * 30)).toBe("30 days");
    expect(formatRetention(3_600)).toBe("1 hour");
    expect(formatRetention(undefined)).toBe("");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2 MiB");
    expect(formatBytes(1536)).toBe("1.5 KiB");
    expect(formatBytes(980)).toBe("980 B");
  });
});

const now = Date.parse("2026-11-18T10:00:00Z");
const worker = (identity: string, patch: Partial<WorkerRow> = {}): WorkerRow => ({ identity, taskQueue: "lab", pollsWorkflows: true, pollsActivities: true, lastAccessTime: "2026-11-18T09:59:58Z", ratePerSecond: 1.5, ...patch });

describe("Workers", () => {
  const out = (patch: Partial<WorkersListOutput> = {}): WorkersListOutput => ({
    workers: [worker("w1@host-1", { buildId: "8c1e2a" }), worker("w2@host-2", { taskQueue: "payments", pollsWorkflows: false, lastAccessTime: "2026-11-18T09:55:00Z", ratePerSecond: 0 })],
    taskQueues: [
      { name: "lab", source: "workflows" },
      { name: "payments", source: "workflows" },
    ],
    truncated: false,
    ...patch,
  });

  test("lists the workers with what they poll, their version, and the idle one marked", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    const list = vi.fn(async (_input: unknown) => out());
    const p = props({ temporal: { workers: { list } } }, { kind: "temporal.workers", params: { namespace: "lab" } });
    const { container } = render(<WorkersTab {...p} />);
    await waitFor(() => byText("w2@host-2") !== null, "the rows");
    expect(list).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", taskQueues: null });
    expect(byText(/2 workers polling 2 of 2 task queues · 1 idle/)).not.toBeNull();
    const rows = Array.from(container.querySelectorAll("tbody tr")).map((r) => r.textContent ?? "");
    expect(rows[0]).toContain("Workflow, activity");
    expect(rows[0]).toContain("8c1e2a");
    expect(rows[0]).toContain("1.50");
    expect(rows[1]).toContain("Activity");
    expect(rows[1]).toContain("Idle");
    await click(byRole("button", "payments"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "temporal.taskQueue", params: { namespace: "lab", name: "payments" }, title: "Task queue payments" });
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a typed task queue is asked for; the list refreshes every 10 s while shown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now });
    const list = vi.fn(async (_input: unknown) => out());
    const p = props({ temporal: { workers: { list } } }, { kind: "temporal.workers", params: { namespace: "lab" } });
    render(<WorkersTab {...p} />);
    await waitFor(() => byText("w1@host-1") !== null, "the rows");
    await type(byRole("textbox", "Task queue to add") as HTMLInputElement, "billing");
    await click(byRole("button", "Add"));
    await waitFor(() => list.mock.calls.some(([input]) => JSON.stringify(input).includes("billing")), "the typed queue");
    const before = list.mock.calls.length;
    await vi.advanceTimersByTimeAsync(REFRESH_MS + 50);
    await waitFor(() => list.mock.calls.length > before, "a refresh");
  });

  test("no task queue seen asks for one; no pollers says so", async () => {
    const none = props({ temporal: { workers: { list: async () => out({ workers: [], taskQueues: [] }) } } }, { kind: "temporal.workers", params: { namespace: "lab" } });
    render(<WorkersTab {...none} />);
    await waitFor(() => byText(/Type a task queue/) !== null, "the empty line");
    cleanup();
    const idle = props({ temporal: { workers: { list: async () => out({ workers: [] }) } } }, { kind: "temporal.workers", params: { namespace: "lab" } });
    render(<WorkersTab {...idle} />);
    await waitFor(() => byText("No worker is polling these task queues.") !== null, "no pollers");
  });

  test("filters by queue, kind and text; idle and polls-for read as said", () => {
    const rows = out().workers;
    expect(filterWorkers(rows, "payments", "any", "").map((w) => w.identity)).toEqual(["w2@host-2"]);
    expect(filterWorkers(rows, "*", "workflow", "").map((w) => w.identity)).toEqual(["w1@host-1"]);
    expect(filterWorkers(rows, "*", "any", "8C1E").map((w) => w.identity)).toEqual(["w1@host-1"]);
    expect(isIdle(rows[0]!, now)).toBe(false);
    expect(isIdle(rows[1]!, now)).toBe(true);
    expect(isIdle({}, now)).toBe(true);
    expect(pollsFor({ pollsWorkflows: true, pollsActivities: false })).toBe("Workflow");
  });
});

describe("the tree", () => {
  test("has Namespaces and Workers under the profile", () => {
    const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
    const nodes = temporalTool.sidebarTree({ profile, connId: "c" });
    expect(nodes.map((n) => n.label)).toEqual(["Namespaces", "Workflows", "Schedules", "Task queues", "Workers"]);
    expect(nodes[4]?.open).toEqual({ kind: "temporal.workers", params: { namespace: "default" }, title: "Workers · default" });
    expect(temporalTool.tabKinds["temporal.workers"]?.title({ namespace: "lab" })).toBe("Workers · lab");
  });
});
