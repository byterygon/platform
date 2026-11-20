// What the NATS tree shows once a profile connects (§6.2, the mockup's tree): the account's streams,
// each with its consumers, the KV buckets (the `KV_*` streams) and the object stores (`OBJ_*`). Loaded once per connection through the shell's `sidebarData` contract,
// and again when a screen creates or deletes a stream or consumer (`reloadStreams`). JetStream off
// is kept as the reason, which the Streams group then shows.
import type { MightyClient } from "@/app/client";
import { describeError } from "@/app/messages";
import type { NatsStreamSummary } from "@/gen/api";
import type { SidebarData } from "../types";

/**
 * A stream behind a KV bucket (`KV_<bucket>` on `$KV.<bucket>.>`) or an object store (`OBJ_<bucket>`
 * on `$O.<bucket>.…`): listed apart, as `nats stream ls` does, since their own screens come with
 * Key-Value and Object Store.
 */
export function isBackingStream(s: Pick<NatsStreamSummary, "name" | "subjects">): boolean {
  const all = (prefix: string) => s.subjects.length > 0 && s.subjects.every((x) => x.startsWith(prefix));
  return (s.name.startsWith("KV_") && all("$KV.")) || (s.name.startsWith("OBJ_") && all("$O."));
}

/** Streams whose consumers the tree lists; the others show theirs on their own screen. */
export const TREE_CONSUMER_STREAMS = 50;

export interface TreeData {
  /** The streams in name order, without those behind KV buckets and object stores; absent until listed. */
  streams?: NatsStreamSummary[];
  /** The KV buckets by name, from the same listing. */
  buckets?: string[];
  /** The object stores by name, from the same listing. */
  objectStores?: string[];
  /** Consumer names per stream, for the first streams. */
  consumers: Record<string, string[]>;
  /** Why the streams could not be listed (JetStream off, no permission). */
  error?: string;
}

const data = new Map<string, TreeData>();
const clients = new Map<string, MightyClient>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version += 1;
  for (const l of listeners) l();
};

/** The tree's data for a connection, or an empty one. */
export function treeDataOf(connId: string): TreeData {
  return data.get(connId) ?? { consumers: {} };
}

async function load(connId: string, client: MightyClient): Promise<void> {
  let streams: NatsStreamSummary[];
  let buckets: string[];
  let objectStores: string[];
  try {
    const all = await client.nats.js.streams.list({ connId });
    streams = all.filter((s) => !isBackingStream(s));
    buckets = all.filter((s) => isBackingStream(s) && s.name.startsWith("KV_")).map((s) => s.name.slice(3));
    objectStores = all.filter((s) => isBackingStream(s) && s.name.startsWith("OBJ_")).map((s) => s.name.slice(4));
  } catch (e) {
    data.set(connId, { consumers: {}, error: describeError(e).title });
    changed();
    return;
  }
  data.set(connId, { streams, buckets, objectStores, consumers: data.get(connId)?.consumers ?? {} });
  changed();
  const lists = streams.slice(0, TREE_CONSUMER_STREAMS).map(async (s) => {
    if (s.consumers === 0) return [s.name, []] as const;
    try {
      const list = await client.nats.js.consumers.list({ connId, stream: s.name });
      return [s.name, list.map((c) => c.name)] as const;
    } catch {
      return [s.name, []] as const;
    }
  });
  const consumers = Object.fromEntries(await Promise.all(lists));
  data.set(connId, { streams, buckets, objectStores, consumers });
  changed();
}

export const natsTreeData: SidebarData = {
  load({ connId, client }) {
    if (clients.has(connId)) return;
    clients.set(connId, client);
    void load(connId, client);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  version: () => version,
};

/** Lists the streams, consumers, buckets and object stores again (after a create or a delete). */
export function reloadStreams(connId: string, client?: MightyClient): Promise<void> {
  const c = client ?? clients.get(connId);
  if (!c) return Promise.resolve();
  clients.set(connId, c);
  return load(connId, c);
}

/** Forgets every connection's data (tests; a reconnect gets a new connId anyway). */
export function resetTreeData(): void {
  data.clear();
  clients.clear();
  changed();
}
