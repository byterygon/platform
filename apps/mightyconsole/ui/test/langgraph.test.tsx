// The LangGraph tool's UI (Mightyconsole spec §11, TSK-84): the run-event fold, the graph and
// profile helpers, and the screens against a scripted client: assistants with the xray graph,
// threads (search, create, delete), a run that streams to an interrupt and resumes, Stop,
// Rollback, joining a run after the connection came back, state and history with fork and time
// travel, and the store; TSK-96's Runs tab, History's diff and the Edit state sheet.
import { RpcError, type StreamCall } from "@byterygon/ambidex";
import { act, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Toast } from "@/components/ui/toast";
import type { MightyClient } from "@/app/client";
import { describeError } from "@/app/messages";
import type * as api from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { AssistantTab } from "@/tools/langgraph/assistants";
import { DEFAULT_URL, parseHeaderLines, profile } from "@/tools/langgraph/index";
import { EMPTY_RUN, eventName, parseChunk, reduceRun, type RunEvent } from "@/tools/langgraph/run-events";
import { JsonField, schemaProblems, toGraphView } from "@/tools/langgraph/shared";
import { fake as monacoFake } from "../../../../packages/ui/test/fakes/monaco.ts";
import { StoreTab } from "@/tools/langgraph/store";
import { ThreadTab, advancedSummary, defaultInput, interruptQuestion } from "@/tools/langgraph/thread";
import { DEFAULT_ORDER, ThreadsTab, orderSummary } from "@/tools/langgraph/threads";
import { appendKeys, branchCount, formatDuration, runDuration, runNote, stepNodes, updatePreview, wroteLabel } from "@/tools/langgraph/state-diff";
import { lastCheckpoints } from "@/tools/langgraph/thread-runs";
import { foldSame, diffLines } from "@/lib/diff";
import type { LiveState, TabProps, TabView } from "@/tools/types";
import { axeViolations, cleanup, render, settle } from "./support/render";

afterEach(cleanup);

const enc = new TextEncoder();
const lines = (events: RunEvent[]) => enc.encode(events.map((e) => JSON.stringify(e)).join("\n") + "\n");

describe("run events", () => {
  test("lines parse, and event names carry the subgraph namespace", () => {
    expect(parseChunk(enc.encode('{"event":"values","data":{"a":1},"id":"1"}\n\n{"event":"updates","data":{}}\n'))).toHaveLength(2);
    expect(parseChunk(enc.encode("not json\n"))[0]!.event).toBe("unparsed");
    expect(eventName("updates|summarize:01ab")).toEqual({ mode: "updates", namespace: ["summarize"] });
    expect(eventName("values")).toEqual({ mode: "values", namespace: [] });
  });

  test("a run folds into messages, running and done nodes, interrupts", () => {
    const events: RunEvent[] = [
      { event: "metadata", data: { run_id: "r1" }, id: "1" },
      { event: "tasks", data: { id: "t1", name: "plan", input: {} } },
      { event: "messages", data: [{ type: "AIMessageChunk", id: "m1", content: "Here" }, { langgraph_node: "plan" }] },
      { event: "messages", data: [{ type: "AIMessageChunk", id: "m1", content: " it is" }, { langgraph_node: "plan" }] },
      { event: "tasks", data: { id: "t1", name: "plan", result: {} } },
      { event: "updates", data: { plan: { messages: [{ type: "ai", id: "m1", content: "Here it is" }] } } },
      { event: "tasks|summarize:abc", data: { id: "t2", name: "remember", input: {} } },
      { event: "updates|summarize:abc", data: { remember: { steps: ["remember"] } } },
      { event: "updates", data: { __interrupt__: [{ value: { question: "Send?" }, id: "i1" }] } },
    ];
    let v = EMPTY_RUN;
    const seen: string[][] = [];
    for (const e of events) {
      v = reduceRun(v, e);
      seen.push(v.active);
    }
    expect(v.runId).toBe("r1");
    expect(seen[1]).toEqual(["plan"]);
    expect(seen[6]).toEqual(["summarize:remember", "summarize"]);
    expect(v.messages).toEqual([{ id: "m1", role: "ai", text: "Here it is", toolCalls: [], node: "plan" }]);
    expect(v.visited).toEqual(["plan", "summarize:remember"]);
    expect(v.interrupts).toEqual([{ id: "i1", value: { question: "Send?" } }]);
    expect(v.active).toEqual([]);
    expect(v.count).toBe(9);
    expect(v.lastEventId).toBe("1");
    const failed = reduceRun(v, { event: "error", data: { error: "ValueError", message: "boom" } });
    expect(failed.error).toBe("boom");
  });

  test("the xray graph's subgraph nodes are drawn in their group", () => {
    const view = toGraphView({
      nodes: [
        { id: "__start__", name: "__start__", kind: "start" },
        { id: "plan", name: "plan", kind: "node" },
        { id: "summarize:remember", name: "summarize:remember", kind: "node" },
        { id: "__end__", name: "__end__", kind: "end" },
      ],
      edges: [{ source: "plan", target: "summarize:remember", conditional: true }],
    });
    expect(view.nodes.map((n) => n.label)).toEqual(["start", "plan", "remember", "end"]);
    expect(view.nodes[2]!.group).toBe("summarize");
    expect(view.groups).toEqual([{ id: "summarize", label: "summarize" }]);
    expect(view.edges[0]!.conditional).toBe(true);
  });
});

const record = (fields: Record<string, unknown>, secrets: Record<string, unknown> = {}): ProfileRecord => ({
  id: "p1",
  tool: "langgraph",
  version: 1,
  name: "lab",
  createdAt: "2026-11-18T00:00:00Z",
  updatedAt: "2026-11-18T00:00:00Z",
  fields,
  secrets,
  extras: {},
});

describe("profile", () => {
  test("validates the URL and the header lines; toConnect sends the secrets", () => {
    expect(profile.validate(record(profile.defaults().fields))).toEqual({});
    expect(profile.validate(record({ url: "ftp://x" }))["url"]).toBeDefined();
    expect(profile.validate(record({ url: "http://u:p@x" }))["url"]).toContain("credentials");
    expect(profile.validate(record({ url: DEFAULT_URL }, { headerLines: "no colon" }))["headerLines"]).toBeDefined();
    expect(parseHeaderLines("X-A: 1\n\nX-B: two: three")).toEqual({ headers: [{ name: "X-A", value: "1" }, { name: "X-B", value: "two: three" }] });
    const out = profile.toConnect(record({ url: " https://lg.example ", tls: { caPem: "PEM", serverName: "" } }, { apiKey: "k", headerLines: "X-A: 1", clientKeyPem: "" })) as api.ConnectLanggraphProfile;
    expect(out).toEqual({ name: "lab", url: "https://lg.example", apiKey: "k", headers: [{ name: "X-A", value: "1" }], tls: { enabled: false, caPem: "PEM", clientCertPem: null, clientKeyPem: null, serverName: null } });
    expect(defaultInput({ properties: { messages: {} } })).toContain('"human"');
    expect(defaultInput({ properties: {} })).toBe("{}");
  });
});

// ---- Screens against a scripted client -------------------------------------------------------

const THREAD = "11111111-1111-1111-1111-111111111111";
const ASSISTANT: api.Assistant = { assistantId: "a1", graphId: "agent", name: "agent", version: 1, config: {}, context: {}, metadata: {}, createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z" };
const GRAPH: api.AssistantGraph = {
  nodes: [
    { id: "__start__", name: "__start__", kind: "start" },
    { id: "plan", name: "plan", kind: "node" },
    { id: "approve", name: "approve", kind: "node" },
    { id: "__end__", name: "__end__", kind: "end" },
  ],
  edges: [
    { source: "__start__", target: "plan", conditional: false },
    { source: "plan", target: "approve", conditional: true },
    { source: "approve", target: "__end__", conditional: false },
  ],
};
const STATE = (checkpointId: string, interrupts: api.Interrupt[] = []): api.ThreadState => ({
  values: { messages: [], steps: ["plan"] },
  next: interrupts.length ? ["approve"] : [],
  tasks: [],
  checkpointId,
  parentCheckpointId: "c0",
  checkpoint: { checkpoint_id: checkpointId },
  metadata: { step: 2, source: "loop", writes: { plan: {} } },
  createdAt: "2026-11-18T00:00:00Z",
  interrupts,
  cuts: [],
});

interface Script {
  /** Chunks of the next runs.stream / runs.join, then it waits (`release` ends it). */
  chunks: Uint8Array[];
  release: (() => void) | null;
  fail: ((e: unknown) => void) | null;
}

function fakeClient() {
  const calls: { procedure: string; input: unknown }[] = [];
  const script: Script = { chunks: [], release: null, fail: null };
  const rec = (procedure: string) => (input: unknown) => {
    calls.push({ procedure, input });
  };
  const stream = (procedure: string) => (input: unknown): StreamCall<api.RunStreamSummary, Uint8Array> => {
    rec(procedure)(input);
    const chunks = script.chunks;
    script.chunks = [];
    let resolve!: (v: api.RunStreamSummary) => void;
    let reject!: (e: unknown) => void;
    const result = new Promise<api.RunStreamSummary>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    result.catch(() => {});
    let wake: (() => void) | null = null;
    let ended: unknown = null;
    script.release = () => {
      resolve({ runId: "r1", status: "success", events: 3 });
      ended = "done";
      wake?.();
    };
    script.fail = (e) => {
      reject(e);
      ended = e;
      wake?.();
    };
    return {
      result,
      cancel() {
        const e = new RpcError("Cancelled", "cancelled", { local: true });
        reject(e);
        ended = e;
        wake?.();
      },
      async *chunks() {
        for (const c of chunks) yield c;
        while (ended === null) await new Promise<void>((r) => (wake = r));
        if (ended !== "done") throw ended;
      },
    } as unknown as StreamCall<api.RunStreamSummary, Uint8Array>;
  };
  const state = {
    interrupted: false,
    /** The pages of History by their `before` (null: the first): the default is two checkpoints, no more. */
    pages: new Map<string | null, api.ThreadHistoryPage>(),
    /** Answers `threads.state` in place of the default state. */
    stateFor: null as null | ((input: { checkpointId?: string | null; full?: boolean | null }) => api.ThreadState),
    /** What `threads.readValue` sends, as JSON text. */
    readValue: "",
    threads: [{ threadId: THREAD, status: "idle", createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z", metadata: { lab: "x" } }] as api.Thread[],
    /** The thread's runs (TSK-96), and what `runs.get` adds to each. */
    runs: [] as api.Run[],
    request: null as api.RunRequest | null,
  };
  const client = {
    langgraph: {
      assistants: {
        search: async (i: unknown) => (rec("assistants.search")(i), [ASSISTANT]),
        get: async (i: unknown) => (rec("assistants.get")(i), ASSISTANT),
        graph: async (i: unknown) => (rec("assistants.graph")(i), GRAPH),
        schemas: async (i: unknown) => (rec("assistants.schemas")(i), { graphId: "agent", inputSchema: { properties: { messages: {} } }, outputSchema: {}, stateSchema: {}, configSchema: {} }),
      },
      threads: {
        search: async (i: unknown) => (rec("threads.search")(i), state.threads),
        get: async (i: unknown) => (rec("threads.get")(i), state.threads[0]!),
        create: async (i: unknown) => {
          rec("threads.create")(i);
          const t = { threadId: "22222222-2222-2222-2222-222222222222", status: "idle", createdAt: "c", updatedAt: "u", metadata: {} };
          state.threads = [t, ...state.threads];
          return t;
        },
        delete: async (i: { threadId: string }) => {
          rec("threads.delete")(i);
          state.threads = state.threads.filter((t) => t.threadId !== i.threadId);
          return {};
        },
        state: async (i: { checkpointId?: string | null; full?: boolean | null }) => (rec("threads.state")(i), state.stateFor ? state.stateFor(i) : STATE("c2", state.interrupted ? [{ id: "i1", value: { question: "Send?" } }] : [])),
        history: async (i: { before?: string | null; metadata?: unknown }) => (rec("threads.history")(i), i.metadata ? { items: [] } : (state.pages.get(i.before ?? null) ?? { items: [STATE("c2"), STATE("c1")] })),
        readValue: (i: unknown) => {
          rec("threads.readValue")(i);
          const bytes = enc.encode(state.readValue);
          return {
            result: Promise.resolve({ bytes: bytes.length }),
            async *chunks() {
              yield bytes.slice(0, 7);
              yield bytes.slice(7);
            },
          } as unknown as StreamCall<api.ReadValueSummary, Uint8Array>;
        },
        updateState: async (i: unknown) => (rec("threads.updateState")(i), { checkpointId: "c3", checkpoint: { checkpoint_id: "c3" } }),
      },
      runs: {
        stream: stream("runs.stream"),
        join: stream("runs.join"),
        cancel: async (i: unknown) => (rec("runs.cancel")(i), {}),
        rollback: async (i: unknown) => (rec("runs.rollback")(i), {}),
        list: async (i: unknown) => (rec("runs.list")(i), { items: state.runs }),
        get: async (i: { runId: string }) => {
          rec("runs.get")(i);
          const run = state.runs.find((r) => r.runId === i.runId)!;
          return { ...run, ...(state.request ? { request: state.request } : {}) };
        },
      },
      store: {
        namespaces: async (i: unknown) => (rec("store.namespaces")(i), [["lab", "answers"]]),
        search: async (i: unknown) => (rec("store.search")(i), [{ namespace: ["lab", "answers"], key: "answer-5", value: { text: "42" }, updatedAt: "2026-11-18T00:00:00Z" }]),
        get: async () => ({}),
        put: async (i: unknown) => (rec("store.put")(i), {}),
        delete: async (i: unknown) => (rec("store.delete")(i), {}),
      },
    },
  } as unknown as MightyClient;
  return { client, calls, script, state, last: (p: string) => calls.filter((c) => c.procedure === p).at(-1)?.input as Record<string, unknown> | undefined };
}

const PROFILE = record({ url: DEFAULT_URL });

function tabProps(client: MightyClient, kind: string, params: Record<string, unknown>, extra: Partial<TabProps> = {}): TabProps {
  const tab: TabView = { id: "t1", tool: "langgraph", profileId: "p1", kind, params, title: kind, pinned: false };
  return {
    tab,
    profile: PROFILE,
    connId: "conn-1",
    client,
    active: true,
    useTabActions: () => {},
    onLive: () => {},
    note: describeError,
    openTab: () => {},
    ...extra,
  };
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const buttonNamed = (name: string | RegExp) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => (typeof name === "string" ? b.textContent?.trim() === name || b.getAttribute("aria-label") === name : name.test(b.textContent ?? "")));
/** A button of the thread's header: Stop, More actions, Run (the Run sub-tab is a button too). */
const runBar = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("header button")].find((b) => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((m) => m.textContent?.trim() === name);
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error("no element to click");
  await act(async () => void (el as HTMLElement).click());
  await settle();
};

describe("screens", () => {
  test("an assistant's graph with xray, its schemas, and no axe violations", async () => {
    const fake = fakeClient();
    render(
      <Toast>
        <AssistantTab {...tabProps(fake.client, "langgraph.assistant", { assistantId: "a1", name: "agent" })} />
      </Toast>,
    );
    await settle();
    expect(fake.last("assistants.graph")).toMatchObject({ assistantId: "a1", xray: true });
    expect(document.querySelectorAll('[data-slot="graph-view-node"]')).toHaveLength(4);
    expect(await axeViolations()).toEqual([]);
  });

  test("threads: search by status, create opens the thread, delete asks first", async () => {
    const fake = fakeClient();
    const openTab = vi.fn();
    render(
      <Toast>
        <ThreadsTab {...tabProps(fake.client, "langgraph.threads", {}, { openTab })} />
      </Toast>,
    );
    await settle();
    expect(document.body.textContent).toContain("11111111…1111");
    await click(buttonNamed("New thread"));
    expect(fake.last("threads.create")).toMatchObject({ connId: "conn-1" });
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ kind: "langgraph.thread", params: { threadId: "22222222-2222-2222-2222-222222222222" } }));
    await click(buttonNamed(/^Delete thread 11111111/) ?? buttonNamed("Delete thread 11111111…1111"));
    expect(fake.last("threads.delete")).toBeUndefined();
    expect(document.body.textContent).toContain("Delete thread 11111111…1111 on lab?");
    await click(buttonNamed("Delete thread"));
    expect(fake.last("threads.delete")).toMatchObject({ threadId: THREAD });
    expect(await axeViolations()).toEqual([]);
  });

  test("a run streams to the interrupt, lights the running node, and resumes with a value", async () => {
    const fake = fakeClient();
    const live: (LiveState | null)[] = [];
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD }, { onLive: (l) => live.push(l) })} />
      </Toast>,
    );
    await settle();
    fake.script.chunks = [
      lines([
        { event: "metadata", data: { run_id: "r1" }, id: "1" },
        { event: "tasks", data: { id: "t1", name: "plan", input: {} }, id: "2" },
        { event: "messages", data: [{ type: "AIMessageChunk", id: "m1", content: "Hello" }, { langgraph_node: "plan" }], id: "3" },
      ]),
    ];
    await click(runBar("Run"));
    const input = fake.last("runs.stream")!;
    expect(input).toMatchObject({ threadId: THREAD, assistantId: "a1", streamSubgraphs: true, checkpointId: null });
    expect(input["streamMode"]).toEqual(["values", "updates", "messages-tuple", "tasks"]);
    expect(input["input"]).toEqual({ messages: [{ type: "human", content: "" }] });
    expect($('[data-graph-node="plan"]')!.dataset.active).toBe("");
    expect(document.body.textContent).toContain("Hello");
    expect(live.at(-1)?.status).toBe("live");

    // The run ends at the interrupt: the callout with its value, then Resume sends a command.
    fake.state.interrupted = true;
    await act(async () => fake.script.release!());
    await settle();
    expect(live.at(-1)).toMatchObject({ status: "ended", reason: "success" });
    // The callout names the node and the question (TSK-95); Resume… opens the form in a dialog.
    expect(document.body.textContent).toContain("Waiting at approve. The graph asks: Send?");
    await click(buttonNamed("Resume…"));
    await settle();
    expect(document.querySelector("[role=dialog]")?.textContent).toContain('"question": "Send?"');
    await click(buttonNamed("Resume"));
    expect(fake.last("runs.stream")).toMatchObject({ command: { resume: "approved", update: null, goto: null }, input: null });

    // Stop interrupts the run on the server, then ends the stream.
    fake.script.chunks = [lines([{ event: "metadata", data: { run_id: "r1" }, id: "9" }])];
    await act(async () => fake.script.release!());
    await settle();
    await click(runBar("Run"));
    await click(runBar("Stop"));
    expect(fake.last("runs.cancel")).toMatchObject({ threadId: THREAD, runId: "r1" });
    expect(live.at(-1)).toMatchObject({ status: "ended", reason: "stopped" });

    // Roll back, from the header's "…" menu, asks first.
    await click(runBar("More actions"));
    await settle();
    await click(menuItem("Roll back the run…"));
    expect(document.body.textContent).toContain("Roll back run r1?");
    await click(buttonNamed("Roll back"));
    expect(fake.last("runs.rollback")).toMatchObject({ runId: "r1" });
  });

  test("a run lost with the connection is joined again from the last event", async () => {
    const fake = fakeClient();
    let setConn!: (connId: string | null) => void;
    function Harness() {
      const [connId, set] = useState<string | null>("conn-1");
      setConn = set;
      return (
        <Toast>
          <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD })} connId={connId} />
        </Toast>
      );
    }
    render(<Harness />);
    await settle();
    fake.script.chunks = [lines([{ event: "metadata", data: { run_id: "r7" }, id: "5" }])];
    await click(runBar("Run"));
    await act(async () => fake.script.fail!(new RpcError("Unavailable", "connection closed", { retryable: true, local: true })));
    await settle();
    expect(fake.last("runs.join")).toBeUndefined();
    // The shell passes no handle while it reconnects, then the new one.
    await act(async () => setConn(null));
    await act(async () => setConn("conn-2"));
    await settle();
    expect(fake.last("runs.join")).toMatchObject({ connId: "conn-2", threadId: THREAD, runId: "r7", lastEventId: "5" });
  });

  test("history: fork from a checkpoint and run from it", async () => {
    const fake = fakeClient();
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD })} />
      </Toast>,
    );
    await settle();
    // The History tab carries the count of checkpoints (TSK-95), as the header does.
    const historyTab = [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent?.startsWith("History"));
    expect(historyTab?.textContent).toMatch(/^History \d+$/);
    expect(document.querySelector("header")?.textContent).toMatch(/checkpoint c2.*\d+ checkpoints?/);
    await click(historyTab);
    expect(fake.last("threads.history")).toMatchObject({ threadId: THREAD, limit: 50 });
    // An older checkpoint: Fork opens the Edit state sheet on it, which writes a new branch.
    await click([...document.querySelectorAll("tbody tr")][1]);
    await click(buttonNamed("Fork from here"));
    expect(document.body.textContent).toContain("Fork from a checkpoint");
    expect(document.body.textContent).toContain("writes a new branch after c1");
    await click(buttonNamed("Update state"));
    expect(fake.last("threads.updateState")).toMatchObject({ threadId: THREAD, checkpointId: "c1", values: {} });
    await click(buttonNamed("Run from here"));
    expect(document.body.textContent).toContain("Run from checkpoint");
    fake.script.chunks = [];
    await click(runBar("Run"));
    expect(fake.last("runs.stream")).toMatchObject({ checkpointId: "c1", input: { messages: [{ type: "human", content: "" }] } });
  });

  test("history: pages follow the server's token, and a value left out is a note that loads on request (TSK-108)", async () => {
    const fake = fakeClient();
    const big = (id: string): api.ThreadState => ({ ...STATE(id), values: null, cuts: [{ field: "values", bytes: 3 * 1024 * 1024, kind: "object", preview: '{"messages":[{"content":"xxxx' }] });
    fake.state.pages.set(null, { items: [big("c9"), STATE("c8")], next: "c8" });
    fake.state.pages.set("c8", { items: [STATE("c7")] });
    fake.state.stateFor = (i) => ({ ...STATE(i.checkpointId ?? "c9"), values: i.full ? { messages: ["the whole value"] } : null });
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD })} />
      </Toast>,
    );
    await settle();
    const historyTab = [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent?.startsWith("History"));
    // More than the first page holds: the count says so.
    expect(historyTab?.textContent).toBe("History 2+");
    await click(historyTab);
    // The newest checkpoint is selected; its diff says the values were left out (TSK-96), and
    // its full state shows the note with the size, not a viewer.
    expect(document.querySelector("[aria-label^='Step']")?.textContent).toContain("left out for their size");
    await click(buttonNamed("Full state"));
    const note = document.querySelector("[role=group][aria-label='Values, left out']");
    expect(note?.textContent).toContain("Values is an object of 3.0 MiB");
    expect(note?.textContent).toContain('{"messages":[{"content":"xxxx');
    await click(buttonNamed("Load 3.0 MiB"));
    expect(fake.last("threads.state")).toMatchObject({ threadId: THREAD, checkpointId: "c9", full: true });
    expect(document.querySelector("[role=group][aria-label='Values, left out']")).toBeNull();
    expect(document.body.textContent).toContain("the whole value");
    // Older checkpoints: the token of the page, and the button goes with the last page.
    await click(buttonNamed("Load older checkpoints"));
    expect(fake.last("threads.history")).toMatchObject({ threadId: THREAD, before: "c8" });
    expect(buttonNamed("Load older checkpoints")).toBeUndefined();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(3);
  });

  test("a value over what one reply can carry is read as a stream (TSK-108)", async () => {
    const fake = fakeClient();
    const huge: api.ThreadState = { ...STATE("c2"), values: null, cuts: [{ field: "values", bytes: 30 * 1024 * 1024, kind: "object", preview: '{"a":' }] };
    fake.state.stateFor = () => huge; // still cut with `full`: 12 MiB is not enough
    fake.state.readValue = JSON.stringify({ a: "from the stream" });
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD, view: "state" })} />
      </Toast>,
    );
    await settle();
    expect(document.body.textContent).toContain("Values is an object of 30.0 MiB");
    await click(buttonNamed("Load 30.0 MiB"));
    expect(fake.last("threads.state")).toMatchObject({ full: true });
    expect(fake.last("threads.readValue")).toMatchObject({ threadId: THREAD, checkpointId: "c2", field: "values" });
    expect(document.body.textContent).toContain("from the stream");
  });

  test("the store lists namespaces and items, puts and deletes", async () => {
    const fake = fakeClient();
    render(
      <Toast>
        <StoreTab {...tabProps(fake.client, "langgraph.store", {})} />
      </Toast>,
    );
    await settle();
    expect(document.body.textContent).toContain("lab.answers");
    expect(document.body.textContent).toContain("answer-5");
    await click(buttonNamed("lab.answers"));
    expect(fake.last("store.search")).toMatchObject({ namespacePrefix: ["lab", "answers"] });
    await click(buttonNamed("Delete answer-5"));
    await click(buttonNamed("Delete item"));
    expect(fake.last("store.delete")).toMatchObject({ namespace: ["lab", "answers"], key: "answer-5" });
    await click(buttonNamed("Put item"));
    expect(document.body.textContent).toContain("Put an item");
    expect(await axeViolations()).toEqual([]);
  });
});

describe("JsonField (TSK-94)", () => {
  const schema = { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } };

  test("the schema's problems as one line, or a count and a list", () => {
    expect(schemaProblems([], "x")).toBeNull();
    expect(schemaProblems([{ line: 6, column: 3, message: 'Missing property "customer_id".', severity: "error" }], "support-agent's input schema")).toEqual({
      summary: '1 problem: missing property "customer_id" (required by support-agent\'s input schema)',
      items: [],
    });
    expect(
      schemaProblems(
        [
          { line: 2, column: 3, message: "Incorrect type. Expected \"string\".", severity: "error" },
          { line: 4, column: 3, message: "Property extra is not allowed.", severity: "warning" },
        ],
        "the config schema",
      ),
    ).toEqual({ summary: "2 problems with the config schema:", items: ['line 2: incorrect type. Expected "string"', "line 4: property extra is not allowed"] });
  });

  test("sized by its rows; the parse error alone while the text does not parse, else the schema's problems", async () => {
    function Harness({ initial }: { initial: string }) {
      const [v, setV] = useState(initial);
      return <JsonField label="Input" value={v} onChange={setV} rows={7} schema={schema} schemaLabel="support-agent's input schema" />;
    }
    render(<Harness initial="{" />);
    await settle(3);
    const editor = monacoFake.editors.at(-1)!;
    expect(editor.options).toMatchObject({ lineNumbersMinChars: 2, folding: false });
    await act(async () => monacoFake.report([{ startLineNumber: 1, startColumn: 1, message: "Expected a JSON object.", severity: 8, owner: "json" }]));
    expect(document.body.textContent).toContain("Not valid JSON");
    expect(document.querySelector("[data-schema-problems]")).toBeNull();
    cleanup();
    monacoFake.reset();
    render(<Harness initial={'{ "messages": [] }'} />);
    await settle(3);
    await act(async () => monacoFake.report([{ startLineNumber: 1, startColumn: 1, message: 'Missing property "customer_id".', severity: 8, owner: "json" }]));
    expect(document.querySelector("[data-schema-problems]")!.textContent).toContain('1 problem: missing property "customer_id" (required by support-agent\'s input schema)');
    expect(document.querySelector('[data-slot="code-editor"]')!.hasAttribute("data-invalid")).toBe(false);
    monacoFake.reset();
  });
});

// TSK-95: the mockup's langgraph-thread and langgraph-threads frames.
describe("thread and threads on the mockup", () => {
  test("the Advanced row sums up the folded options and names a folded problem", () => {
    const base = { modes: ["values", "updates", "messages"], subgraphs: false, before: "", after: "", config: "", context: "" };
    expect(advancedSummary(base)).toEqual({ text: "values, updates, messages · subgraphs off · no interrupts", problem: null });
    expect(advancedSummary({ ...base, modes: [], subgraphs: true, before: "review, send", after: "*", config: '{"a": 1}' }).text).toBe("no stream modes · subgraphs on · interrupt before review, send, after * · config set");
    expect(advancedSummary({ ...base, config: "{", context: "[" }).problem).toBe("Config and Context are not valid JSON");
    expect(advancedSummary({ ...base, context: "{" }).problem).toBe("Context is not valid JSON");
  });

  test("an interrupt's question: a string, an object's question, else a preview", () => {
    expect(interruptQuestion("Refund 129.90 EUR?")).toBe("Refund 129.90 EUR?");
    expect(interruptQuestion({ question: "Send?", amount: 3 })).toBe("Send?");
    expect(interruptQuestion({ amount: 3 })).toContain("amount");
  });

  test("the input column folds Config, stream modes, subgraphs and interrupts under Advanced", async () => {
    const fake = fakeClient();
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD })} />
      </Toast>,
    );
    await settle();
    const row = buttonNamed(/^Advanced · /)!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toBe("Advanced · values, updates, messages · subgraphs on · no interrupts");
    expect(document.body.textContent).not.toContain("Stream modes");
    expect(document.body.textContent).not.toContain("Interrupt before");
    await click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(document.body.textContent).toContain("Stream modes");
    expect(document.body.textContent).toContain("Interrupt before");
    expect([...document.querySelectorAll("label")].some((l) => l.textContent === "Config")).toBe(true);
    // The header: the thread's short ID, the assistant, Stop, More actions and Run.
    const header = document.querySelector("header")!;
    // The profile, the assistant, the checkpoint and the counts (TSK-96: runs too).
    expect(header.textContent).toMatch(/· assistant agent · checkpoint c2.* · \d+ checkpoints? · \d+ runs?/);
    expect(runBar("Stop")!.disabled).toBe(true);
    expect(runBar("Run")!.getAttribute("aria-keyshortcuts")).toBe("Control+Enter");
    expect(await axeViolations()).toEqual([]);
  });

  test("Delete thread from the header's menu asks first, then goes back to the threads", async () => {
    const fake = fakeClient();
    const navigate = vi.fn();
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD }, { navigate })} />
      </Toast>,
    );
    await settle();
    await click(runBar("More actions"));
    expect(menuItem("Roll back the run…")!.hasAttribute("data-disabled")).toBe(true);
    await click(menuItem("Delete thread…"));
    expect(document.body.textContent).toContain("Delete thread 11111111…1111 on lab?");
    expect(fake.last("threads.delete")).toBeUndefined();
    await click(buttonNamed("Delete thread"));
    expect(fake.last("threads.delete")).toMatchObject({ threadId: THREAD });
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ kind: "langgraph.threads" }), { replace: true });
  });

  test("Threads: sort, order and rows per page behind Advanced reach the search", async () => {
    expect(orderSummary(DEFAULT_ORDER)).toBe("Advanced");
    expect(orderSummary({ sortBy: "created_at", sortOrder: "asc", limit: 100 })).toBe("Advanced: Created, oldest first · 100 rows");
    expect(orderSummary({ ...DEFAULT_ORDER, sortBy: "status" })).toBe("Advanced: Status, descending");
    const fake = fakeClient();
    render(
      <Toast>
        <ThreadsTab {...tabProps(fake.client, "langgraph.threads", {})} />
      </Toast>,
    );
    await settle();
    expect(fake.last("threads.search")).toMatchObject({ limit: 50, sortBy: "updated_at", sortOrder: "desc" });
    expect(buttonNamed("Advanced")).toBeDefined();
    expect(document.querySelector('[aria-label="Status"]')!.textContent).toContain("Status: Any");
  });
});

// ---- TSK-96: Runs, History's diff, Edit state's preview ------------------------------------------

const RUN = (runId: string, status: string, extra: Partial<api.Run> = {}): api.Run => ({ runId, threadId: THREAD, assistantId: "a1", status, createdAt: "2026-11-18T10:21:40Z", updatedAt: "2026-11-18T10:21:54.800Z", metadata: {}, multitaskStrategy: "reject", cuts: [], ...extra });
const CHECKPOINT = (id: string, parent: string | null, extra: Partial<api.ThreadState> & { meta?: Record<string, unknown> } = {}): api.ThreadState => {
  const { meta, ...rest } = extra;
  const { parentCheckpointId: _parent, ...base } = STATE(id);
  return { ...base, ...(parent ? { parentCheckpointId: parent } : {}), metadata: { step: 1, source: "loop", ...meta }, ...rest };
};

describe("thread additions (TSK-96)", () => {
  test("What changes: messages are appended (an id replaces), other keys replaced; only changed keys are compared", () => {
    const appended = appendKeys({ properties: { notes: { description: "Annotated[list, add_messages]" }, refund: {} } });
    expect([...appended].sort()).toEqual(["messages", "notes"]);
    const current = { messages: [{ id: "m1", content: "hi" }], refund: { approved: null }, intent: "billing" };
    const out = updatePreview(current, { messages: [{ id: "m2", content: "yes" }], refund: { approved: true }, intent: "billing" }, appended);
    expect(out.keys).toEqual(["messages", "refund"]);
    expect(out.lines.filter((l) => l.kind === "added").map((l) => l.text.trim())).toEqual(expect.arrayContaining(['"approved": true', '"content": "yes",']));
    expect(out.lines.some((l) => l.text.includes("intent"))).toBe(false);
    // A message with a known id replaces the old one.
    const replaced = updatePreview(current, { messages: { id: "m1", content: "edited" } }, appended);
    expect(replaced.lines.filter((l) => l.kind === "removed").map((l) => l.text.trim())).toEqual(['"content": "hi",']);
    expect(updatePreview(current, { intent: "billing" }, appended).keys).toEqual([]);
  });

  test("a step's nodes: its writes, else its parent's next; the Wrote column; branches; folded diffs", () => {
    const parent = CHECKPOINT("p", null, { next: ["retrieve"] });
    expect(stepNodes(CHECKPOINT("c", "p", { meta: { writes: { draft: {} } } }), parent)).toEqual(["draft"]);
    expect(stepNodes(CHECKPOINT("c", "p"), parent)).toEqual(["retrieve"]);
    const byId = new Map([["p", { ...parent, metadata: { step: 6, source: "loop" } }]]);
    expect(wroteLabel(CHECKPOINT("u", "p", { meta: { source: "update", writes: { human_review: {} } } }), parent, byId)).toBe("(by a person) as human_review");
    expect(wroteLabel(CHECKPOINT("f", "p", { meta: { source: "fork" } }), parent, byId)).toBe("from step 6");
    expect(wroteLabel(CHECKPOINT("i", null, { meta: { source: "input" } }), undefined, byId)).toBe("—");
    expect(branchCount([CHECKPOINT("a", "p"), CHECKPOINT("b", "p"), CHECKPOINT("c", "a"), parent])).toBe(2);
    expect(branchCount([CHECKPOINT("a", "p"), parent])).toBe(1);
    const lines = diffLines(["a", "b", "c", "d", "e", "f", "g", "h"].join("\n"), ["a", "b", "c", "d", "e", "f", "g", "X"].join("\n"));
    expect(foldSame(lines)).toEqual([{ kind: "folded", count: 5 }, { kind: "same", text: "f" }, { kind: "same", text: "g" }, { kind: "removed", text: "h" }, { kind: "added", text: "X" }]);
  });

  test("a run's duration, note and last checkpoint", () => {
    expect(formatDuration(runDuration(RUN("r", "error")))).toBe("14.8 s");
    expect(formatDuration(runDuration(RUN("r", "running"), Date.parse("2026-11-18T10:23:44Z")))).toBe("2 min 4 s");
    expect(formatDuration(null)).toBe("—");
    const failed = CHECKPOINT("c3", "c2", { meta: { run_id: "r1", step: 3 }, tasks: [{ id: "t", name: "retrieve", error: "TimeoutError: retrieve took longer than 10 s\n  at search_kb", interrupts: [], state: null, result: null }] });
    expect(runNote(RUN("r1", "error"), failed)).toBe("TimeoutError: retrieve took longer than 10 s");
    expect(runNote(RUN("r2", "interrupted"), CHECKPOINT("c9", "c8", { next: ["human_review"] }))).toBe("waiting at human_review");
    expect(runNote(RUN("r3", "success"), failed)).toBe("");
    // interrupt() inside a node: the server may call the run a success; the checkpoint says it waits.
    expect(runNote(RUN("r4", "success"), CHECKPOINT("c9", "c8", { next: ["approve"], interrupts: [{ id: "i1", value: "Send?" }] }))).toBe("waiting at approve");
    expect(runNote(RUN("r5", "success"), CHECKPOINT("c9", "c8", { next: ["approve"] }))).toBe("");
    const lasts = lastCheckpoints([CHECKPOINT("c4", "c3", { meta: { run_id: "r1" } }), failed, CHECKPOINT("c1", null, { meta: { run_id: "r0" } })]);
    expect(lasts.get("r1")?.checkpointId).toBe("c4");
    expect(lasts.get("r0")?.checkpointId).toBe("c1");
  });

  test("Runs: the table, a failed run's error, Run again with the same input fills the form", async () => {
    const fake = fakeClient();
    fake.state.runs = [RUN("r2", "interrupted", { createdAt: "2026-11-18T10:44:02Z", updatedAt: "2026-11-18T10:44:05.600Z" }), RUN("r1", "error")];
    fake.state.pages.set(null, { items: [CHECKPOINT("c9", "c8", { next: ["approve"], meta: { run_id: "r2", step: 4 } }), CHECKPOINT("c3", "c2", { meta: { run_id: "r1", step: 3 }, tasks: [{ id: "t", name: "retrieve", error: "TimeoutError: too slow", interrupts: [], state: null, result: null }] })] });
    fake.state.request = { input: { messages: [{ type: "human", content: "again" }] }, config: { configurable: { model: "small", thread_id: THREAD } }, streamMode: ["values"] };
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD, view: "runs" })} />
      </Toast>,
    );
    await settle();
    const runsTab = [...document.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent?.startsWith("Runs"));
    expect(runsTab?.textContent).toBe("Runs 2");
    expect(document.querySelector("header")?.textContent).toContain("2 runs");
    const rows = [...document.querySelectorAll("table[aria-label=Runs] tbody tr")];
    expect(rows[0]?.textContent).toContain("waiting at approve");
    expect(rows[0]?.textContent).toContain("3.6 s");
    expect(rows[0]?.querySelector("button")?.textContent).toBe("r2");
    expect(rows[1]?.textContent).toContain("TimeoutError: too slow");
    expect(rows[1]?.textContent).toContain("agent");
    await click(rows[1]?.querySelector("button"));
    expect(fake.last("runs.get")).toMatchObject({ threadId: THREAD, runId: "r1" });
    expect($("[aria-label=\"The run's error\"]")?.textContent).toContain("during node retrieve, step 3, checkpoint c3");
    expect(await axeViolations()).toEqual([]);
    await click(buttonNamed("Run again with the same input"));
    // The Run tab shows the run's input and the config it asked for (the server's own keys left out).
    expect(document.querySelector("[role=tab][aria-selected=true]")?.textContent).toBe("Run");
    fake.script.chunks = [];
    await click(runBar("Run"));
    expect(fake.last("runs.stream")).toMatchObject({ input: { messages: [{ type: "human", content: "again" }] }, config: { configurable: { model: "small" } }, streamMode: expect.arrayContaining(["values"]) });
  });

  test("History: a checkpoint against its parent, read when it is older than the page", async () => {
    const fake = fakeClient();
    fake.state.pages.set(null, { items: [CHECKPOINT("c2", "c1", { values: { messages: ["a", "b"], refund: { approved: true } } }), CHECKPOINT("c1", "c0", { values: { messages: ["a"], refund: { approved: null } } })] });
    fake.state.stateFor = (i) => CHECKPOINT(i.checkpointId ?? "c2", null, { values: { messages: [] } });
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD, view: "history" })} />
      </Toast>,
    );
    await settle();
    expect(document.body.textContent).toContain("2 checkpoints · 1 branch");
    const diff = $("[aria-label='What changed']");
    const kind = (k: string) => [...(diff?.querySelectorAll(`[data-kind=${k}]`) ?? [])].map((l) => l.textContent).join("\n");
    expect(kind("removed")).toContain('"approved": null');
    expect(kind("added")).toContain('"approved": true');
    expect(kind("added")).toContain('"b"');
    expect(await axeViolations()).toEqual([]);
    // The oldest loaded one's parent is read from the server.
    await click([...document.querySelectorAll("tbody tr")][1]);
    expect(fake.last("threads.state")).toMatchObject({ checkpointId: "c0" });
    expect($("[aria-label='What changed']")?.textContent).toContain('"a"');
    await click(buttonNamed("Graph"));
    expect($("[aria-label^='The graph at step']")).not.toBeNull();
  });

  test("Edit state: what changes before it is sent, then Update and continue the run", async () => {
    const fake = fakeClient();
    fake.state.pages.set(null, { items: [CHECKPOINT("c2", "c1", { values: { messages: [{ id: "m1", content: "hi" }], refund: { approved: null } }, meta: { writes: { plan: {} } } })] });
    render(
      <Toast>
        <ThreadTab {...tabProps(fake.client, "langgraph.thread", { threadId: THREAD, view: "state" })} />
      </Toast>,
    );
    await settle();
    await click(buttonNamed("Edit state"));
    expect(document.body.textContent).toContain("makes a new checkpoint after c2");
    const editor = monacoFake.editors.at(-1)!;
    await act(async () => editor.model.setValue('{"refund": {"approved": true}}'));
    await settle();
    const changes = $("[aria-label='What changes']");
    expect(changes?.textContent).toContain("1 key");
    expect(changes?.querySelector("[data-kind=added]")?.textContent).toContain('"approved": true');
    expect(await axeViolations()).toEqual([]);
    fake.script.chunks = [];
    await click(buttonNamed("Update and continue the run"));
    expect(fake.last("threads.updateState")).toMatchObject({ threadId: THREAD, values: { refund: { approved: true } }, asNode: "plan", checkpointId: null });
    expect(fake.last("runs.stream")).toMatchObject({ input: null, checkpointId: "c3" });
  });
});
