// What the Docker tree shows after a profile connects (TSK-81 mockup, docker tree): the host's
// containers, grouped by Compose project with their counts, and how many images, volumes and
// networks there are (`docker.host.counts`). Loaded once per connection through the shell's
// `sidebarData` contract; the Containers, Images, Volumes and Networks tabs hand over every list
// they load, so the tree follows the host's events while one is open.
import type { MightyClient } from "@/app/client";
import type { ContainerRow, HostCounts } from "@/gen/api";
import type { SidebarData } from "../types";

const data = new Map<string, readonly ContainerRow[]>();
const counts = new Map<string, Partial<HostCounts>>();
const started = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version += 1;
  for (const l of listeners) l();
};

/** The containers the tree knows for a connection, or `null` before the first list. */
export function treeContainersOf(connId: string): readonly ContainerRow[] | null {
  return data.get(connId) ?? null;
}

/** A newer list of the host's containers (the Containers tab, after an event or a refresh). */
export function setTreeContainers(connId: string, rows: readonly ContainerRow[]): void {
  data.set(connId, rows);
  changed();
}

/** How many images, volumes and networks the tree knows for a connection (each absent until known). */
export function treeCountsOf(connId: string): Partial<HostCounts> {
  return counts.get(connId) ?? {};
}

/** A newer count of one kind (its tab loaded a list, or the first `docker.host.counts`). */
export function setTreeCount(connId: string, kind: keyof HostCounts, n: number): void {
  if (counts.get(connId)?.[kind] === n) return;
  counts.set(connId, { ...counts.get(connId), [kind]: n });
  changed();
}

export const dockerTreeData: SidebarData = {
  load({ connId, client }: { connId: string; client: MightyClient }) {
    if (started.has(connId)) return;
    started.add(connId);
    // Best effort: a refused list leaves the tree with its fixed nodes.
    client.docker.containers.list({ connId, all: true }).then(
      (rows) => setTreeContainers(connId, rows),
      () => undefined,
    );
    client.docker.host.counts({ connId }).then(
      (n) => {
        // A tab's list that came first is newer.
        const known = counts.get(connId) ?? {};
        counts.set(connId, { ...n, ...known });
        changed();
      },
      () => undefined,
    );
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  version: () => version,
};
