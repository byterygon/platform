// What the Docker tree shows after a profile connects (TSK-81 mockup, docker tree): the host's
// containers, grouped by Compose project with their counts. Loaded once per connection through the
// shell's `sidebarData` contract; the Containers tab hands over every list it loads, so the tree
// follows the host's events while that tab is open.
import type { MightyClient } from "@/app/client";
import type { ContainerRow } from "@/gen/api";
import type { SidebarData } from "../types";

const data = new Map<string, readonly ContainerRow[]>();
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

export const dockerTreeData: SidebarData = {
  load({ connId, client }: { connId: string; client: MightyClient }) {
    if (started.has(connId)) return;
    started.add(connId);
    // Best effort: a refused list leaves the tree with its fixed nodes.
    client.docker.containers.list({ connId, all: true }).then(
      (rows) => setTreeContainers(connId, rows),
      () => undefined,
    );
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  version: () => version,
};
