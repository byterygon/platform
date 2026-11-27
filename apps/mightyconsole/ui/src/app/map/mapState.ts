// What the network map keeps in this browser (DOC-23 §10, TSK-145): where each node was dragged to,
// the way in a person chose for a node that has two, and the targets they added with their links.
// Nothing here is a secret and none of it is shared: the links, proxies, SSH hosts and routes are on
// the server. Everything is read and written inside try/catch: a private window or blocked site
// data leaves the map working with the defaults.
import { emptyScratch, type Point, type Scratch, type Via } from "./model";

const KEY = "mightyconsole.network-map.v1";

export interface MapLocal {
  positions: Record<string, Point>;
  via: Via;
  scratch: Scratch;
}

export const emptyLocal = (): MapLocal => ({ positions: {}, via: {}, scratch: emptyScratch() });

const isPoint = (v: unknown): v is Point => typeof v === "object" && v !== null && typeof (v as Point).x === "number" && typeof (v as Point).y === "number";

export function loadLocal(storage: Pick<Storage, "getItem"> | null = safeStorage()): MapLocal {
  if (!storage) return emptyLocal();
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return emptyLocal();
    const data = JSON.parse(raw) as Partial<MapLocal>;
    const positions: Record<string, Point> = {};
    for (const [id, p] of Object.entries(data.positions ?? {})) if (isPoint(p)) positions[id] = p;
    const via: Via = {};
    for (const [id, e] of Object.entries(data.via ?? {})) if (typeof e === "string") via[id] = e;
    const scratch = emptyScratch();
    for (const t of data.scratch?.targets ?? []) if (typeof t?.id === "string" && typeof t.name === "string" && typeof t.address === "string") scratch.targets.push({ id: t.id, name: t.name, address: t.address });
    for (const e of data.scratch?.edges ?? []) if (typeof e?.id === "string" && typeof e.from === "string" && typeof e.to === "string" && typeof e.method === "string") scratch.edges.push({ id: e.id, from: e.from, to: e.to, method: e.method });
    return { positions, via, scratch };
  } catch {
    return emptyLocal();
  }
}

export function saveLocal(local: MapLocal, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(KEY, JSON.stringify(local));
  } catch {
    // Quota or a blocked store: the map keeps working for this visit.
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
