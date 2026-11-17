// The Workflows screen of the Temporal tool (Mightyconsole spec §9.3) against a stub client: rows,
// count, status chips rewriting the query, paging by token, the server's message for an invalid
// query under the bar, an error in place of the list, and no calls while disconnected.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { WorkflowRow, WorkflowsListInput } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { WorkflowsTab } from "@/tools/temporal/WorkflowsTab";
import { profile as schema } from "@/tools/temporal/profile";
import type { TabProps, TabRecord } from "@/tools/types";
import { axeViolations, byRole, byText, cleanup, click, render, settle, type, waitFor } from "./support/render";

afterEach(cleanup);

const row = (n: number, patch: Partial<WorkflowRow> = {}): WorkflowRow => ({
  workflowId: `order-${n}`,
  runId: `0190aaaa-bbbb-cccc-dddd-${String(n).padStart(12, "0")}`,
  workflowType: "OrderWorkflow",
  status: "Running",
  startTime: "2026-11-18T01:02:03Z",
  taskQueue: "orders",
  historyLength: 1200 + n,
  ...patch,
});

const opened = vi.fn();

function setup(options: { list?: (input: WorkflowsListInput) => Promise<{ executions: WorkflowRow[]; nextPageToken?: string }>; connId?: string | null; query?: string } = {}) {
  const list = vi.fn(options.list ?? (async () => ({ executions: [row(1), row(2, { status: "Failed", closeTime: "2026-11-18T01:05:03Z", durationMs: 180_000 })] })));
  const count = vi.fn(async () => ({ count: 1234 }));
  const namespaces = vi.fn(async () => [
    { name: "default", state: "Registered", description: "", ownerEmail: "", isGlobal: false, isDefault: true },
    { name: "lab", state: "Registered", description: "", ownerEmail: "", isGlobal: false, isDefault: false },
  ]);
  const client = { temporal: { workflows: { list, count }, namespaces: { list: namespaces } } } as unknown as MightyClient;
  const profile: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const tab: TabRecord = { id: "t1", tool: "temporal", profileId: "01T", kind: "temporal.workflows", params: { namespace: "default", query: options.query ?? "" }, title: "Workflows · default", pinned: false };
  const props: TabProps = {
    tab,
    profile,
    connId: options.connId === undefined ? "conn-1" : options.connId,
    client,
    active: true,
    useTabActions: () => {},
    onLive: () => {},
    note: describeError,
    openTab: opened,
  };
  const view = render(<WorkflowsTab {...props} />);
  return { list, count, namespaces, ...view };
}

const queryInput = () => document.querySelector<HTMLInputElement>('input[aria-label="Visibility query"]')!;

describe("Workflows (spec §9.3)", () => {
  test("lists the workflows with status, times, duration and the count", async () => {
    const { list, count, container } = setup();
    await waitFor(() => byText("order-1") !== null, "the rows");
    expect(list).toHaveBeenCalledWith({ connId: "conn-1", namespace: "default", query: "", pageSize: 50, nextPageToken: null });
    expect(count).toHaveBeenCalledWith({ connId: "conn-1", namespace: "default", query: "" });
    expect(byText("1,234 workflows")).not.toBeNull();
    const cells = Array.from(container.querySelectorAll("tbody tr")).map((r) => r.textContent ?? "");
    expect(cells).toHaveLength(2);
    expect(cells[0]).toContain("Running");
    expect(cells[1]).toContain("Failed");
    expect(cells[1]).toContain("3m");
    expect(cells[0]).toContain("1,201");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a status chip rewrites the query and loads it", async () => {
    const { list } = setup();
    await waitFor(() => byText("order-1") !== null, "the rows");
    list.mockClear();
    await click(byRole("button", "Failed"));
    await waitFor(() => list.mock.calls.length > 0, "the filtered load");
    expect(queryInput().value).toBe('ExecutionStatus = "Failed"');
    expect(list.mock.calls[0]![0]).toMatchObject({ query: 'ExecutionStatus = "Failed"', nextPageToken: null });
  });

  test("Run sends the typed query", async () => {
    const { list } = setup();
    await waitFor(() => byText("order-1") !== null, "the rows");
    list.mockClear();
    await type(queryInput(), 'WorkflowType = "Order"');
    await click(byRole("button", "Run"));
    await waitFor(() => list.mock.calls.length > 0, "the query");
    expect(list.mock.calls[0]![0]).toMatchObject({ query: 'WorkflowType = "Order"' });
  });

  test("Load more asks for the next page by its token and appends", async () => {
    const pages = new Map<string | null, { executions: WorkflowRow[]; nextPageToken?: string }>([
      [null, { executions: [row(1), row(2)], nextPageToken: "tok-2" }],
      ["tok-2", { executions: [row(3)] }],
    ]);
    const { list } = setup({ list: async (input) => pages.get(input.nextPageToken ?? null)! });
    await waitFor(() => byText("order-2") !== null, "the first page");
    expect(byText("order-3")).toBeNull();
    await click(byRole("button", "Load more"));
    await waitFor(() => byText("order-3") !== null, "the second page");
    expect(list.mock.calls.at(-1)![0]).toMatchObject({ nextPageToken: "tok-2" });
    expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(byRole("button", "Load more")).toBeNull();
  });

  test("an invalid query shows the server's message under the bar, not instead of the screen", async () => {
    const invalid = new RpcError("InvalidArgument", "unable to parse query: unexpected token", { details: { kind: "Invalid", system: "temporal", message: "unable to parse query: unexpected token", retryable: false } });
    setup({ list: async () => Promise.reject(invalid), query: "oops ((" });
    await waitFor(() => byText(/unable to parse query/) !== null, "the message");
    expect(byText("Invalid")).not.toBeNull();
    expect(queryInput().value).toBe("oops ((");
    expect(byRole("button", "Run")).not.toBeNull();
  });

  test("another failure replaces the list with the error and Retry", async () => {
    const down = new RpcError("Unavailable", "the Temporal frontend at h:1 is unavailable", { retryable: true, details: { kind: "Connect", system: "temporal", message: "x", retryable: true } });
    let calls = 0;
    setup({ list: async () => (++calls === 1 ? Promise.reject(down) : { executions: [row(1)] }) });
    await waitFor(() => byRole("button", "Retry") !== null, "the error state");
    await click(byRole("button", "Retry"));
    await waitFor(() => byText("order-1") !== null, "the reload");
  });

  test("an empty result says so", async () => {
    setup({ list: async () => ({ executions: [] }), query: 'WorkflowType = "x"' });
    await waitFor(() => byText("No workflow matches this query.") !== null, "the empty line");
  });

  test("disconnected: nothing is fetched", async () => {
    const { list, namespaces } = setup({ connId: null });
    await settle(3);
    expect(byText("Connect to lab")).not.toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(namespaces).not.toHaveBeenCalled();
  });
});
