// What a LangGraph run stream says, folded into what the Run screen shows (Mightyconsole spec
// §11.2): the events by type, the chat messages assembled from message tokens, the nodes running
// and done (for the GraphView), the pending interrupts, the error. Pure, so it is tested alone.
//
// The server forwards each SSE event of the LangGraph server as one JSON line
// `{ event, data, id? }` (`RunEventLine`). With `streamSubgraphs`, events of a subgraph are named
// `<mode>|<subgraph>:<task id>`; their node names are relative to the subgraph, which the xray
// graph draws as `<subgraph>:<node>`.

/** One line of `langgraph.runs.stream` and `langgraph.runs.join`. */
export interface RunEvent {
  event: string;
  data: unknown;
  id?: string;
  /** When the event arrived (ms since the epoch), stamped by the screen (TSK-96). */
  at?: number;
}

/** A chat message as the Messages view shows it. */
export interface ChatMessage {
  id: string;
  /** `human`, `ai`, `tool`, `system`, ... (chunks count as `ai`). */
  role: string;
  text: string;
  /** Tool calls an AI message asked for. */
  toolCalls: { name: string; args: unknown }[];
  /** The node that wrote it, when the stream says. */
  node?: string;
}

export interface RunInterrupt {
  id?: string;
  value: unknown;
}

export interface RunView {
  runId?: string;
  /** The latest events, oldest first (at most MAX_EVENTS). */
  events: RunEvent[];
  /** Events seen in all, including those dropped from `events`. */
  count: number;
  messages: ChatMessage[];
  /** Graph node ids running now. */
  active: string[];
  /** Graph node ids that ran. */
  visited: string[];
  interrupts: RunInterrupt[];
  error?: string;
  lastEventId?: string;
}

/** Events kept on screen; older ones are dropped (the count still says how many came). */
export const MAX_EVENTS = 2000;

export const EMPTY_RUN: RunView = { events: [], count: 0, messages: [], active: [], visited: [], interrupts: [] };

/** Splits a `jsonl` chunk into events (the server sends whole lines only). */
export function parseChunk(bytes: Uint8Array, decoder: TextDecoder = new TextDecoder()): RunEvent[] {
  const out: RunEvent[] = [];
  for (const line of decoder.decode(bytes).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as RunEvent;
      if (typeof parsed.event === "string") out.push(parsed);
    } catch {
      out.push({ event: "unparsed", data: line });
    }
  }
  return out;
}

/** `updates|summarize:01ab` → `{ mode: "updates", namespace: ["summarize"] }`. */
export function eventName(event: string): { mode: string; namespace: string[] } {
  const [mode = event, ns] = event.split("|", 2);
  const namespace = ns ? ns.split("|").map((part) => part.split(":")[0]!).filter(Boolean) : [];
  return { mode, namespace };
}

/** The graph node id of `node` inside `namespace` (the xray graph's `<subgraph>:<node>`). */
export function nodeId(namespace: readonly string[], node: string): string {
  return [...namespace, node].join(":");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The text of a message's content (a string, or a list of text parts). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : isObject(part) && typeof part["text"] === "string" ? part["text"] : ""))
      .join("");
  }
  return content === undefined || content === null ? "" : JSON.stringify(content);
}

function roleOf(type: unknown): string {
  if (typeof type !== "string") return "ai";
  if (type === "AIMessageChunk") return "ai";
  if (type.endsWith("MessageChunk")) return type.slice(0, -"MessageChunk".length).toLowerCase();
  return type;
}

/** Folds a message (full or a chunk) into the list: chunks with the same id are concatenated. */
function addMessage(messages: ChatMessage[], raw: unknown, node: string | undefined): ChatMessage[] {
  if (!isObject(raw)) return messages;
  const id = typeof raw["id"] === "string" ? raw["id"] : `m${messages.length}`;
  const chunk = typeof raw["type"] === "string" && raw["type"].endsWith("Chunk");
  const toolCalls = Array.isArray(raw["tool_calls"]) ? raw["tool_calls"].filter(isObject).map((c) => ({ name: String(c["name"] ?? ""), args: c["args"] })) : [];
  const at = messages.findIndex((m) => m.id === id);
  const text = contentText(raw["content"]);
  if (at >= 0) {
    const old = messages[at]!;
    const next: ChatMessage = { ...old, text: chunk ? old.text + text : text, toolCalls: toolCalls.length ? toolCalls : old.toolCalls };
    return messages.map((m, i) => (i === at ? next : m));
  }
  const message: ChatMessage = { id, role: roleOf(raw["type"]), text, toolCalls };
  if (node) message.node = node;
  return [...messages, message];
}

const without = (list: readonly string[], id: string) => list.filter((x) => x !== id);
const withId = (list: readonly string[], id: string) => (list.includes(id) ? [...list] : [...list, id]);

/** The run view after one more event. */
export function reduceRun(view: RunView, e: RunEvent): RunView {
  const next: RunView = { ...view, count: view.count + 1, events: view.events.length >= MAX_EVENTS ? [...view.events.slice(view.events.length - MAX_EVENTS + 1), e] : [...view.events, e] };
  if (e.id) next.lastEventId = e.id;
  const { mode, namespace } = eventName(e.event);
  const data = e.data;
  switch (mode) {
    case "metadata":
      if (isObject(data) && typeof data["run_id"] === "string") next.runId = data["run_id"];
      break;
    case "error":
      next.error = isObject(data) ? String(data["message"] ?? data["error"] ?? JSON.stringify(data)) : String(data);
      next.active = [];
      break;
    case "tasks": {
      // A task starts (`input`) or ends (`result`, `error`, `interrupts`).
      if (!isObject(data) || typeof data["name"] !== "string") break;
      const id = nodeId(namespace, data["name"]);
      const ended = "result" in data || "error" in data || "interrupts" in data;
      if (ended) {
        next.active = without(next.active, id);
        next.visited = withId(next.visited, id);
      } else {
        next.active = withId(next.active, id);
        for (const parent of namespace.map((_, i) => namespace.slice(0, i + 1).join(":"))) next.active = withId(next.active, parent);
      }
      break;
    }
    case "updates": {
      if (!isObject(data)) break;
      for (const [node, value] of Object.entries(data)) {
        if (node === "__interrupt__") {
          next.interrupts = Array.isArray(value) ? value.map((i) => (isObject(i) ? { ...(typeof i["id"] === "string" ? { id: i["id"] } : {}), value: i["value"] } : { value: i })) : [];
          next.active = [];
          continue;
        }
        const id = nodeId(namespace, node);
        next.active = without(next.active, id);
        next.visited = withId(next.visited, id);
        for (const msg of isObject(value) && Array.isArray(value["messages"]) ? value["messages"] : []) {
          if (isObject(msg) && !next.messages.some((m) => m.id === msg["id"])) next.messages = addMessage(next.messages, msg, id);
        }
      }
      break;
    }
    case "messages": {
      // messages-tuple: [message chunk, metadata with langgraph_node].
      if (Array.isArray(data)) {
        const meta = isObject(data[1]) ? data[1] : {};
        const node = typeof meta["langgraph_node"] === "string" ? nodeId(namespace, meta["langgraph_node"]) : undefined;
        next.messages = addMessage(next.messages, data[0], node);
      }
      break;
    }
    case "values": {
      if (isObject(data) && Array.isArray(data["messages"])) {
        for (const msg of data["messages"]) if (isObject(msg) && !next.messages.some((m) => m.id === msg["id"])) next.messages = addMessage(next.messages, msg, undefined);
      }
      break;
    }
    default:
      break;
  }
  return next;
}

/** Interrupts a run left behind, taken from the run's state when the stream itself did not say. */
export function interruptsOf(state: { interrupts?: readonly { id?: string; value: unknown }[] } | null | undefined): RunInterrupt[] {
  return (state?.interrupts ?? []).map((i) => ({ ...(i.id ? { id: i.id } : {}), value: i.value }));
}
