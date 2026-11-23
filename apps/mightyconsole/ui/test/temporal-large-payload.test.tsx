// Large payloads of the Temporal tool (Mightyconsole spec §9.3 "Large payload", TSK-92) against a
// stub client: the stub's helpers, the payload view's tree (pages, Go to index), jq on the server,
// the size pane and limits, an expired payload, and History's Size column and stub cards.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { HistoryEvent, PayloadChild, PayloadNode } from "@/gen/api";
import { HistoryPanel, bySizeRows } from "@/tools/temporal/HistoryPanel";
import { HistoryStore } from "@/tools/temporal/history-store";
import { PayloadView, jqPath, largeOf, largeStubs, sizeVerdict, withoutPreviews, type LargeStub } from "@/tools/temporal/LargePayload";
import { largestPayloads } from "@/tools/temporal/WorkflowTab";
import { historyRows, summaryContext } from "@/tools/temporal/history-view";
import { axeViolations, byRole, byText, cleanup, click, render, type, waitFor } from "./support/render";

afterEach(cleanup);

const MiB = 1024 * 1024;
const stub: LargeStub = { id: "a1b2", bytes: 1.62 * MiB, decodedBytes: 1.62 * MiB, encoding: "json/plain", codec: { codec: "codec.lab", from: "binary/encrypted" }, preview: '{\n  "items": [' };

const child = (key: string, path: string, kind: PayloadChild["kind"], bytes: number, length?: number, preview = ""): PayloadChild => ({ key, path, kind, bytes, preview, ...(length !== undefined ? { length } : {}) });

/** A fake payload store: an object with `items` (12,480 entries), `debug` and `snapshotAt`. */
function fakeClient(options: { expired?: boolean } = {}) {
  const node = vi.fn(async ({ path, offset }: { path?: string | null; offset?: number | null }): Promise<PayloadNode> => {
    if (options.expired) throw new RpcError("NotFound", "this payload is no longer kept on the server (10 minutes unused, or the connection was opened again): reload the event", { details: { kind: "NotFound", system: "temporal", message: "gone", retryable: false, resource: "payload" } });
    if (!path) {
      return {
        path: "",
        kind: "object",
        length: 3,
        bytes: 1_700_000,
        cut: false,
        offset: 0,
        total: 3,
        children: [child("items", "/items", "array", 1_650_000, 12_480), child("debug", "/debug", "object", 42_000, 3), child("snapshotAt", "/snapshotAt", "string", 22, 20, '"2026-11-18T10:29:58Z"')],
        info: { bytes: 1_700_000, decodedBytes: 1_700_000, encoding: "json/plain", largestArrays: [{ path: "/items", length: 12_480, bytes: 1_650_000, entryBytes: 132 }] },
      };
    }
    const from = offset ?? 0;
    const n = Math.min(50, 12_480 - from);
    return {
      path,
      kind: "array",
      length: 12_480,
      bytes: 1_650_000,
      cut: false,
      offset: from,
      total: 12_480,
      children: Array.from({ length: n }, (_, i) => child(String(from + i), `${path}/${from + i}`, "object", 131, 4, `{"sku":"A-${String(from + i).padStart(5, "0")}","qty":0}`)),
    };
  });
  const query = vi.fn(async () => ({ results: [312], bytes: 3, truncated: false, ms: 64 }));
  return { client: { temporal: { payload: { node, query, download: vi.fn() } } } as unknown as MightyClient, node, query };
}

describe("the stub", () => {
  test("is found in a value, its preview left out of listings, and its size judged against the limits", () => {
    const attrs = { input: [{ $large: stub }, "small"], header: {} };
    expect(largeOf(attrs.input[0])).toEqual(stub);
    expect(largeOf({ $large: { id: 1 } })).toBeNull();
    expect(largeStubs(attrs)).toEqual([{ path: "input[0]", stub }]);
    const listed = withoutPreviews(attrs) as { input: [{ $large: LargeStub }] };
    expect(listed.input[0].$large.preview).toBe("(1.62 MiB of JSON, kept on the server)");
    expect(sizeVerdict(1.62 * MiB)).toEqual({ text: "1.62 MiB, near the 2 MiB limit", tone: "warning" });
    expect(sizeVerdict(600 * 1024).text).toBe("600 KiB, over the 512 KiB warning");
    expect(sizeVerdict(3 * MiB).tone).toBe("danger");
    expect(sizeVerdict(100 * 1024).tone).toBe("neutral");
  });

  test("a JSON pointer reads as jq's path", () => {
    expect(jqPath("")).toBe(".");
    expect(jqPath("/items/1/sku", new Set(["/items"]))).toBe(".items[1].sku");
    expect(jqPath("/a~1b/0")).toBe('.["a/b"]["0"]');
  });

  test("the run's largest payloads come from the events' stubs", () => {
    const events = [
      { eventId: 1, eventType: "WorkflowExecutionStarted", category: "Workflow", attributes: { input: [{ $large: stub }] }, size: 1_700_100 },
      { eventId: 7, eventType: "ActivityTaskCompleted", category: "Activity", attributes: { result: [{ $large: { ...stub, id: "b", bytes: 980 * 1024 } }] }, size: 1_003_600 },
      { eventId: 9, eventType: "WorkflowExecutionSignaled", category: "Signal", attributes: { input: ["x"] }, size: 90 },
    ] as HistoryEvent[];
    expect(largestPayloads(events)).toEqual([
      { eventId: 1, label: "started input[0]", bytes: stub.bytes },
      { eventId: 7, label: "completed result[0]", bytes: 980 * 1024 },
    ]);
  });
});

describe("the payload view", () => {
  test("loads the root, opens an array a page at a time, goes to an index, and copies the selected path", async () => {
    const { client, node } = fakeClient();
    const { container } = render(<PayloadView client={client} connId="c" stub={stub} label="Input · argument 1 of 1" fileName="large-1-input" note={describeError} context={{ historyBytes: 18.4 * MiB, events: 1_402, largest: [{ eventId: 1, label: "started input[0]", bytes: stub.bytes }] }} />);
    await waitFor(() => byText("array[12,480]") !== null, "the root's children");
    expect(node).toHaveBeenCalledWith({ connId: "c", payloadId: "a1b2", path: "", offset: 0, limit: null });
    expect(byText("1.62 MiB, near the 2 MiB limit")).not.toBeNull();
    expect(byText("binary/encrypted")).not.toBeNull();
    // What makes it big, the limits, the largest payloads.
    expect(byText("What makes it big")).not.toBeNull();
    expect(byText(/12,480 entries, about 132 B each/)).not.toBeNull();
    expect(byText("18.4 MiB / 50 MiB")).not.toBeNull();
    expect(byText("1,402 / 51,200")).not.toBeNull();
    expect(byText("event 1")).not.toBeNull();
    await click(byRole("button", /^items/));
    await waitFor(() => byText('{"sku":"A-00049","qty":0}') !== null, "the first page");
    expect(byText(/showing 1–50, each about/)).not.toBeNull();
    await click(byRole("button", "Load 50 more"));
    await waitFor(() => byText('{"sku":"A-00099","qty":0}') !== null, "the second page");
    expect(node).toHaveBeenLastCalledWith({ connId: "c", payloadId: "a1b2", path: "/items", offset: 50, limit: null });
    await type(byRole("textbox", "Go to index in .items") as HTMLInputElement, "9000");
    await click(byRole("textbox", "Go to index in .items"));
    (byRole("textbox", "Go to index in .items") as HTMLInputElement).form!.requestSubmit();
    await waitFor(() => byText('{"sku":"A-09000","qty":0}') !== null, "the jump");
    await click(byRole("button", /^\[9001\]/));
    expect(byText(".items[9001]")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("jq runs on the server and only its result shows", async () => {
    const { client, query } = fakeClient();
    render(<PayloadView client={client} connId="c" stub={stub} label="Input" fileName="x" note={describeError} />);
    await waitFor(() => byText("array[12,480]") !== null, "the root");
    await type(byRole("textbox", "jq") as HTMLInputElement, ".items | map(select(.qty == 0)) | length");
    await click(byRole("button", "Run jq"));
    // The user's time limit goes with it (TSK-113; 2 s by default), and the call waits a little longer.
    expect(query).toHaveBeenCalledWith({ connId: "c", payloadId: "a1b2", jq: ".items | map(select(.qty == 0)) | length", timeoutMs: 2000 }, { timeoutMs: 35_000 });
    await waitFor(() => byText("on the server, 64 ms") !== null, "the result");
    expect(byText("312")).not.toBeNull();
  });

  test("a payload no longer kept says so and offers to read the event again", async () => {
    const { client } = fakeClient({ expired: true });
    const reload = vi.fn();
    render(<PayloadView client={client} connId="c" stub={stub} label="Input" fileName="x" note={describeError} onReload={reload} />);
    await waitFor(() => byText(/no longer kept on the server/) !== null, "the expiry");
    await click(byRole("button", "Reload the event"));
    expect(reload).toHaveBeenCalled();
  });
});

/** A store holding the events, as the workflow tab's (TSK-109). */
function storeOf(events: HistoryEvent[]): HistoryStore {
  const store = new HistoryStore();
  store.append(events);
  return store;
}

describe("History", () => {
  const ev = (eventId: number, eventType: string, size: number, attributes: Record<string, unknown> = {}): HistoryEvent => ({ eventId, eventTime: new Date(Date.UTC(2026, 10, 18, 10, 0, eventId)).toISOString(), eventType, category: eventType.startsWith("WorkflowTask") ? "WorkflowTask" : "Workflow", attributes, size });
  const events = [ev(1, "WorkflowExecutionStarted", 1_700_100, { input: [{ $large: stub }] }), ev(2, "WorkflowTaskScheduled", 90), ev(3, "WorkflowTaskStarted", 300), ev(4, "WorkflowTaskCompleted", 120), ev(5, "WorkflowExecutionSignaled", 4_000, { signalName: "go", input: ["x"] })];

  test("rows sort by size with folds opened", () => {
    const rows = historyRows(events, { category: "All", fold: true, expanded: new Set(), query: "", ctx: summaryContext(events) });
    expect(bySizeRows(rows).map((r) => (r.kind === "event" ? r.event.eventId : -1))).toEqual([1, 5, 3, 4, 2]);
  });

  test("has a Size column, sorts by it, and a large input is a card that opens its tab", async () => {
    const open = vi.fn();
    const { container } = render(<HistoryPanel workflowId="large-1" runId="r" store={storeOf(events)} total={5} live={false} pending={[]} selected={1} onSelect={() => undefined} hasMore={false} onLoadMore={() => undefined} onOpenPending={() => undefined} onOpenPayload={open} />);
    expect(Array.from(container.querySelectorAll("th")).map((t) => t.textContent)).toContain("Size");
    expect(container.textContent).toContain("1.62 MiB");
    await click(byRole("button", "Size"));
    const ids = Array.from(container.querySelectorAll("tbody tr")).map((r) => r.querySelector("td")?.textContent);
    expect(ids.slice(0, 2)).toEqual(["1", "5"]);
    expect(container.textContent).toContain("(1.62 MiB of JSON, kept on the server)");
    await click(byRole("button", "Open input[0]"));
    expect(open).toHaveBeenCalledWith(stub, "Event 1 · input[0]");
  });
});
