// What the Temporal tree shows after a profile connects (the TSK-91 mockup's tree): the cluster's
// namespaces, one folder each, and counts beside Namespaces, Schedules and Workers. Loaded once per
// connection through the shell's `sidebarData` contract; the tree re-renders when it arrives.
import type { MightyClient } from "@/app/client";
import { describeError } from "@/app/messages";
import type { ProfileRecord } from "@/profiles/record";
import type { SidebarData } from "../types";
import { namespaceOf } from "./profile";

export interface TreeData {
  /** The cluster's namespaces by name, the profile's first; absent until listed. */
  namespaces?: string[];
  /**
   * Per namespace: how many schedules, workers polling and standalone activities, or why the
   * server has no standalone activities (only the profile's namespace is counted).
   */
  counts: Record<string, { schedules?: number; workers?: number; activities?: number; activitiesUnsupported?: string }>;
}

const data = new Map<string, TreeData>();
const started = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version += 1;
  for (const l of listeners) l();
};

const update = (connId: string, change: (d: TreeData) => TreeData) => {
  data.set(connId, change(data.get(connId) ?? { counts: {} }));
  changed();
};

/** The tree's data for a connection, or an empty one. */
export function treeDataOf(connId: string): TreeData {
  return data.get(connId) ?? { counts: {} };
}

/** The profile's namespace first, then the others in name order; the hidden system namespace left out. */
export function orderNamespaces(names: readonly string[], first: string): string[] {
  const rest = [...new Set(names)].filter((n) => n !== first && n !== "temporal-system").sort((a, b) => a.localeCompare(b));
  return [first, ...rest];
}

async function load(profile: ProfileRecord, connId: string, client: MightyClient): Promise<void> {
  const namespace = namespaceOf(profile);
  // Each part is best effort: a refused call leaves its count out, the tree still works.
  const lists = client.temporal.namespaces.list({ connId }).then(
    (list) => update(connId, (d) => ({ ...d, namespaces: orderNamespaces(list.map((n) => n.name), namespace) })),
    () => undefined,
  );
  const schedules = client.temporal.schedules.list({ connId, namespace }).then(
    (list) => update(connId, (d) => ({ ...d, counts: { ...d.counts, [namespace]: { ...d.counts[namespace], schedules: list.length } } })),
    () => undefined,
  );
  const workers = client.temporal.workers.list({ connId, namespace, taskQueues: [] }).then(
    (out) => update(connId, (d) => ({ ...d, counts: { ...d.counts, [namespace]: { ...d.counts[namespace], workers: new Set(out.workers.map((w) => w.identity)).size } } })),
    () => undefined,
  );
  // Standalone activities (TSK-92): the count, or the server's reason when it has none; other errors leave it out.
  const activities = client.temporal.activities.count({ connId, namespace }).then(
    (out) => update(connId, (d) => ({ ...d, counts: { ...d.counts, [namespace]: { ...d.counts[namespace], activities: Number(out.count) } } })),
    (e: unknown) => {
      const described = describeError(e);
      if (described.remoteName !== "StandaloneActivitiesUnsupported") return;
      update(connId, (d) => ({ ...d, counts: { ...d.counts, [namespace]: { ...d.counts[namespace], activitiesUnsupported: described.title } } }));
    },
  );
  await Promise.all([lists, schedules, workers, activities]);
}

export const temporalTreeData: SidebarData = {
  load({ profile, connId, client }) {
    if (started.has(connId)) return;
    started.add(connId);
    void load(profile, connId, client);
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  version: () => version,
};

/** Forgets a connection's data (tests; a reconnect gets a new connId anyway). */
export function resetTreeData(): void {
  data.clear();
  started.clear();
  changed();
}
