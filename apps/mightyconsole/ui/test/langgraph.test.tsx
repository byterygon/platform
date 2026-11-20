// The LangGraph tool's UI (Mightyconsole spec §11, TSK-84): the run-event fold, the graph and
// profile helpers, and the screens against a scripted client: assistants with the xray graph,
// threads (search, create, delete), a run that streams to an interrupt and resumes, Stop,
// Rollback, joining a run after the connection came back, state and history with fork and time
// travel, and the store.
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
import { ThreadTab, defaultInput } from "@/tools/langgraph/thread";
import { ThreadsTab } from "@/tools/langgraph/threads";
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
  const state = { interrupted: false, threads: [{ threadId: THREAD, status: "idle", createdAt: "2026-11-18T00:00:00Z", updatedAt: "2026-11-18T00:00:00Z", metadata: { lab: "x" } }] as api.Thread[] };
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
        state: async (i: unknown) => (rec("threads.state")(i), STATE("c2", state.interrupted ? [{ id: "i1", value: { question: "Send?" } }] : [])),
        history: async (i: unknown) => (rec("threads.history")(i), [STATE("c2"), STATE("c1")]),
        updateState: async (i: unknown) => (rec("threads.updateState")(i), { checkpointId: "c3", checkpoint: { checkpoint_id: "c3" } }),
      },
      runs: {
        stream: stream("runs.stream"),
        join: stream("runs.join"),
        cancel: async (i: unknown) => (rec("runs.cancel")(i), {}),
        rollback: async (i: unknown) => (rec("runs.rollback")(i), {}),
        list: async () => [],
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
/** A button of the Run toolbar (the Run sub-tab is a button too). */
const runBar = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("[aria-label=\"Run actions\"] button")].find((b) => b.textContent?.trim() === name);
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
    expect(document.body.textContent).toContain("The run is waiting at an interrupt");
    expect(document.body.textContent).toContain('"question": "Send?"');
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

    // Rollback asks first.
    await click(runBar("Rollback"));
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
    await click([...document.querySelectorAll<HTMLElement>("[role=tab]")].find((t) => t.textContent === "History"));
    expect(fake.last("threads.history")).toMatchObject({ threadId: THREAD, limit: 50 });
    await click(buttonNamed("Fork from here"));
    expect(document.body.textContent).toContain("Fork from checkpoint c2");
    await click(buttonNamed("Save"));
    expect(fake.last("threads.updateState")).toMatchObject({ threadId: THREAD, checkpointId: "c2", values: {} });
    await click(buttonNamed("Run from here"));
    expect(document.body.textContent).toContain("Run from checkpoint");
    fake.script.chunks = [];
    await click(runBar("Run"));
    expect(fake.last("runs.stream")).toMatchObject({ checkpointId: "c2", input: { messages: [{ type: "human", content: "" }] } });
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
