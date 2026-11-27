// The network map's model (DOC-23 §10, (aa) to (ad), (bl), TSK-145): nodes (this server, SSH hosts,
// proxies and the targets profiles use), the links between them, the way in each node has, the path
// to a node, the rules a new link keeps and the hops a path becomes when it is tested or saved as a
// route. Pure: the screen (`NetworkMap.tsx`) draws it and the server (`links.*`, `routes.*`) keeps it.
//
// A link into a target is saved only inside a route: the target is whichever profile uses the route.
// So a profile's target node is drawn from its route (the route's last link ends there), and a
// target a person adds on the map is a scratch one, kept in this browser: a place to test a path to
// and to save a route from.
import type { HopInput, LinkView, Method, Node, ProxyView, RouteTestLine, RouteView, SshHostView } from "@/gen/api";
import { METHOD_LABELS, methodsFrom } from "@/profiles/links";
import { addressOf } from "@/profiles/ssh-hosts";
import { targetOf } from "../routes/ConnectThrough";

export type MapNodeKind = "server" | "host" | "socks" | "http" | "target";

export const NODE_KIND_LABELS: Record<MapNodeKind, string> = { server: "This server", host: "SSH host", socks: "SOCKS5 proxy", http: "HTTP proxy", target: "Target" };

export const SERVER_ID = "server";

export interface MapNode {
  id: string;
  kind: MapNodeKind;
  name: string;
  /** `host:port`. */
  address: string;
  /** The saved row behind an SSH host or proxy; absent for the server and a target. */
  ref?: Node;
  user?: string | undefined;
  auth?: string | undefined;
  /** Whose it is: a link joins two nodes of one owner. */
  owner?: "personal" | "shared";
  /** What profiles and routes use it: "Docker · build-host". */
  used: string[];
  /** A target a person added to the map (not a profile's). */
  scratch?: boolean;
  profileId?: string;
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  method: Method;
  /** The saved link; absent for an edge into a scratch target. */
  link?: LinkView;
  /** A command link that nobody confirmed. */
  unconfirmed: boolean;
  /** The routes that use it. */
  routes: string[];
}

export interface MapGraph {
  nodes: MapNode[];
  edges: MapEdge[];
}

/** A profile as the map reads it: its target and its route. */
export interface MapProfile {
  id: string;
  tool: string;
  name: string;
  fields: Record<string, unknown>;
}

/** A target added on the map and a link into it: both live in this browser. */
export interface Scratch {
  targets: { id: string; name: string; address: string }[];
  /** `from` is a node id; the method is the first the source allows. */
  edges: { id: string; from: string; to: string; method: Method }[];
}

export const emptyScratch = (): Scratch => ({ targets: [], edges: [] });

export interface MapSource {
  links: readonly LinkView[];
  hosts: readonly SshHostView[];
  proxies: readonly ProxyView[];
  routes: readonly RouteView[];
  profiles: readonly MapProfile[];
  scratch: Scratch;
}

export const hostNodeId = (id: string) => `host:${id}`;
export const proxyNodeId = (id: string) => `proxy:${id}`;
export const targetNodeId = (profileId: string) => `target:${profileId}`;

export function nodeIdOf(node: Node): string {
  switch (node.kind) {
    case "server":
      return SERVER_ID;
    case "sshHost":
      return hostNodeId(node.id);
    case "proxy":
      return proxyNodeId(node.id);
    case "target":
      return "target";
  }
}

/** The tools a route serves (the ones whose profiles name `routeId`). */
const TOOL_NAMES: Record<string, string> = { docker: "Docker", temporal: "Temporal", langgraph: "LangGraph", nats: "NATS" };

/** The address a profile's target shows: its tool's own, or NATS's first server (its route waits for TSK-118). */
export function addressOfProfile(tool: string, fields: Record<string, unknown>): string {
  const own = targetOf(tool, fields);
  if (own) return own;
  const first = tool === "nats" && Array.isArray(fields["servers"]) ? fields["servers"][0] : undefined;
  if (typeof first !== "string") return "";
  try {
    const url = new URL(first.includes("://") ? first : `nats://${first}`);
    return `${url.hostname}:${url.port || "4222"}`;
  } catch {
    return "";
  }
}

export function buildGraph(src: MapSource): MapGraph {
  const nodes: MapNode[] = [{ id: SERVER_ID, kind: "server", name: "This server", address: "", used: [] }];
  const used = new Map<string, string[]>();
  const note = (id: string, text: string) => used.set(id, [...(used.get(id) ?? []), text]);
  for (const r of src.routes) {
    for (const h of r.hops) {
      if (h.sshHostId) note(hostNodeId(h.sshHostId), `route ${r.name}`);
      if (h.proxyId) note(proxyNodeId(h.proxyId), `route ${r.name}`);
    }
  }
  for (const h of src.hosts) {
    nodes.push({ id: hostNodeId(h.id), kind: "host", name: h.name, address: addressOf(h.fields), ref: { kind: "sshHost", id: h.id }, owner: h.owner.kind === "shared" ? "shared" : "personal", user: h.fields.username, auth: h.fields.auth ?? undefined, used: [...new Set(used.get(hostNodeId(h.id)) ?? [])] });
  }
  for (const p of src.proxies) {
    nodes.push({ id: proxyNodeId(p.id), kind: p.fields.kind === "socks5" ? "socks" : "http", name: p.name, address: `${p.fields.host}:${p.fields.port}`, ref: { kind: "proxy", id: p.id }, owner: p.owner.kind === "shared" ? "shared" : "personal", used: [...new Set(used.get(proxyNodeId(p.id)) ?? [])] });
  }
  const edges: MapEdge[] = [];
  const routeNames = (linkId: string) => src.routes.filter((r) => r.hops.some((h) => h.linkId === linkId)).map((r) => r.name);
  const known = new Set(nodes.map((n) => n.id));
  for (const l of src.links) {
    if (l.to.kind === "target") continue;
    const from = nodeIdOf(l.from);
    const to = nodeIdOf(l.to);
    if (!known.has(from) || !known.has(to)) continue;
    edges.push({ id: l.id, from, to, method: l.method, link: l, unconfirmed: l.needsConfirmation && !l.confirmed, routes: routeNames(l.id) });
  }
  // A profile's target: where its route's last link ends.
  for (const profile of src.profiles) {
    const routeId = typeof profile.fields["routeId"] === "string" ? profile.fields["routeId"] : "";
    const route = routeId ? src.routes.find((r) => r.id === routeId) : undefined;
    const last = route?.hops.at(-1);
    const link = last ? src.links.find((l) => l.id === last.linkId) : undefined;
    if (!route || !link || link.to.kind !== "target") continue;
    const id = targetNodeId(profile.id);
    nodes.push({ id, kind: "target", name: profile.name, address: addressOfProfile(profile.tool, profile.fields), used: [`${TOOL_NAMES[profile.tool] ?? profile.tool} · ${profile.name}`], profileId: profile.id });
    const from = nodeIdOf(link.from);
    if (!known.has(from)) continue;
    edges.push({ id: `${link.id}@${profile.id}`, from, to: id, method: link.method, link, unconfirmed: link.needsConfirmation && !link.confirmed, routes: [route.name] });
  }
  for (const t of src.scratch.targets) nodes.push({ id: t.id, kind: "target", name: t.name, address: t.address, used: [], scratch: true });
  for (const e of src.scratch.edges) {
    if (!nodes.some((n) => n.id === e.from) || !nodes.some((n) => n.id === e.to)) continue;
    edges.push({ id: e.id, from: e.from, to: e.to, method: e.method, unconfirmed: false, routes: [] });
  }
  return { nodes, edges };
}

export const nodeById = (g: MapGraph, id: string): MapNode | undefined => g.nodes.find((n) => n.id === id);
export const edgeById = (g: MapGraph, id: string): MapEdge | undefined => g.edges.find((e) => e.id === id);

/** The node a saved link's end is, as a wire `Node`. */
export function wireNode(n: MapNode): Node {
  return n.ref ?? (n.kind === "server" ? { kind: "server" } : { kind: "target" });
}

/** The methods a link out of `node` may use; the first is the one a new link gets. */
export function methodsOf(node: MapNode): Method[] {
  return methodsFrom(wireNode(node));
}

/** What an arrow says: how the node before opens the stream (the label on a link). */
export function edgeLabel(g: MapGraph, e: MapEdge): string {
  if (e.method === "connect") return nodeById(g, e.from)?.kind === "socks" ? "SOCKS5" : "HTTP CONNECT";
  return { tcp: "TCP", command: "command", ssh: "SSH channel", sshCommand: "SSH command", connect: "CONNECT" }[e.method];
}

export const methodLabel = (m: Method): string => METHOD_LABELS[m];

// ---- ways in and paths ---------------------------------------------------------------------------

/** For each node, the id of the edge that is its way in. */
export type Via = Record<string, string>;

/** `via` kept to edges that still exist, and a way in chosen for every node that has one. */
export function resolveVia(g: MapGraph, chosen: Via): Via {
  const out: Via = {};
  for (const n of g.nodes) {
    if (n.id === SERVER_ID) continue;
    const incoming = g.edges.filter((e) => e.to === n.id);
    const wanted = chosen[n.id];
    const pick = incoming.find((e) => e.id === wanted) ?? firstWayIn(g, incoming);
    if (pick) out[n.id] = pick.id;
  }
  return out;
}

/** The default way in: one the server reaches without a loop, else the first. */
function firstWayIn(g: MapGraph, incoming: MapEdge[]): MapEdge | undefined {
  return incoming.find((e) => e.from === SERVER_ID || reaches(g, SERVER_ID, e.from)) ?? incoming[0];
}

/** Whether `goal` is reached from `start` over the edges (a target ends a walk). */
export function reaches(g: MapGraph, start: string, goal: string): boolean {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const at = stack.pop() as string;
    if (at === goal) return true;
    if (seen.has(at)) continue;
    seen.add(at);
    for (const e of g.edges) if (e.from === at) stack.push(e.to);
  }
  return false;
}

export interface MapPath {
  /** From this server to the node, in order. */
  edges: MapEdge[];
  /** The path starts at this server. */
  ok: boolean;
}

/** The path to `id` along each node's way in. */
export function pathTo(g: MapGraph, via: Via, id: string): MapPath {
  const edges: MapEdge[] = [];
  const seen = new Set<string>();
  let at = id;
  while (at !== SERVER_ID && via[at] && !seen.has(at)) {
    seen.add(at);
    const e = edgeById(g, via[at] as string);
    if (!e) break;
    edges.unshift(e);
    at = e.from;
  }
  return { edges, ok: at === SERVER_ID };
}

/** Why a link from `from` to `to` may not be made, or `""` when it may. */
export function whyNot(g: MapGraph, from: string, to: string): string {
  const a = nodeById(g, from);
  const b = nodeById(g, to);
  if (!a || !b || from === to) return "Pick another node.";
  if (a.kind === "target") return `${a.name} is a target: nothing is reached through it.`;
  if (b.kind === "server") return "Nothing connects into this server.";
  if (b.kind === "target" && !b.scratch) return `${b.name} is a profile's target: it is reached through its route, which the profile's Connect through chooses.`;
  if (g.edges.some((e) => e.from === from && e.to === to)) return `${a.name} already reaches ${b.name}.`;
  if (reaches(g, to, from)) return "That would make a loop.";
  return "";
}

/** The nodes `from` may be linked to. */
export function linkTargets(g: MapGraph, from: string): MapNode[] {
  return g.nodes.filter((n) => n.id !== from && whyNot(g, from, n.id) === "");
}

// ---- from a path to hops ------------------------------------------------------------------------------

/** The hop a link is: a command is the link itself, anything else is the node the link leaves. */
export function hopOfEdge(g: MapGraph, e: MapEdge): HopInput | null {
  const from = nodeById(g, e.from);
  const ref = from?.ref;
  switch (e.method) {
    case "tcp":
      return null;
    case "command": {
      const l = e.link;
      if (!l) return null;
      return {
        kind: "command",
        program: l.program ?? "",
        args: [...l.args],
        env: l.env.map((v) => (v.secret ? { name: v.name, secret: true, value: null } : { name: v.name, secret: false, value: v.value ?? "" })),
        cwd: l.cwd ?? null,
      };
    }
    case "connect":
      return ref?.kind === "proxy" ? { kind: "proxy", proxyId: ref.id } : null;
    case "ssh":
      return ref?.kind === "sshHost" ? { kind: "ssh", sshHostId: ref.id } : null;
    case "sshCommand":
      return ref?.kind === "sshHost" ? { kind: "sshCommand", sshHostId: ref.id, command: e.link?.command ?? "" } : null;
  }
}

export function hopsOfPath(g: MapGraph, edges: readonly MapEdge[]): HopInput[] {
  return edges.flatMap((e) => {
    const h = hopOfEdge(g, e);
    return h ? [h] : [];
  });
}

/** The hops of a route that ends at `nodeId` and reaches the profile's target from there. */
export function routeHops(g: MapGraph, via: Via, nodeId: string): { hops: HopInput[]; reason?: string } {
  const node = nodeById(g, nodeId);
  if (!node || node.id === SERVER_ID) return { hops: [], reason: "Pick a node to reach." };
  const path = pathTo(g, via, nodeId);
  if (!path.ok) return { hops: [], reason: "No path from this server reaches it yet." };
  if (path.edges.some((e) => e.unconfirmed)) return { hops: [], reason: "A command on the path is not confirmed yet." };
  if (node.kind === "target") return { hops: hopsOfPath(g, path.edges) };
  // Through an SSH host or a proxy: the stream leaves it by its default method.
  const last: MapEdge = { id: "final", from: node.id, to: "target", method: methodsOf(node)[0] ?? "ssh", unconfirmed: false, routes: [] };
  return { hops: hopsOfPath(g, [...path.edges, last]) };
}

/** A route's default name for the path that ends at `nodeId`. */
export function routeNameFor(g: MapGraph, nodeId: string, taken: readonly string[]): string {
  const base = nodeById(g, nodeId)?.name ?? "route";
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!lower.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

// ---- Test --------------------------------------------------------------------------------------------

export interface TestPlan {
  hops: HopInput[];
  /** `host:port` the last line dials. */
  target: string;
  /** The path's edges, to colour with the lines. */
  edges: MapEdge[];
}

/** What to send `routes.test` to test the path to `nodeId`, or why it cannot be tested. */
export function testPlan(g: MapGraph, via: Via, nodeId: string): TestPlan | { reason: string } {
  const node = nodeById(g, nodeId);
  if (!node || node.id === SERVER_ID) return { reason: "Pick a node to reach." };
  const path = pathTo(g, via, nodeId);
  if (!path.ok) return { reason: "No path from this server reaches it yet." };
  return planOfEdges(g, node, path.edges);
}

export function planOfEdges(g: MapGraph, node: MapNode, edges: MapEdge[]): TestPlan | { reason: string } {
  if (node.address === "") return { reason: `${node.name} has no address to dial yet.` };
  if (edges.some((e) => e.unconfirmed)) return { reason: "A command on the path is not confirmed yet: read it and confirm it first." };
  const hops = hopsOfPath(g, edges);
  if (hops.length === 0) return { reason: `This server reaches ${node.name} directly: there is no hop in between to test.` };
  return { hops, target: node.address, edges };
}

export interface EdgeResult {
  s: "run" | "ok" | "bad";
  ms?: number;
  text?: string;
  /** The host refused the channel: offer its SSH command instead. */
  hint?: boolean;
}

/** One result per edge of a test: each line belongs to the edge that opened the node it names. */
export function edgeResults(g: MapGraph, plan: TestPlan, lines: readonly RouteTestLine[]): Record<string, EdgeResult> {
  const out: Record<string, EdgeResult> = {};
  const into = (nodeId: string) => plan.edges.find((e) => e.to === nodeId);
  const hopNode = (h: HopInput | undefined): string | null =>
    !h ? null : h.kind === "proxy" ? proxyNodeId(h.proxyId) : h.kind === "ssh" || h.kind === "sshCommand" ? hostNodeId(h.sshHostId) : null;
  for (const line of lines) {
    let edge: MapEdge | undefined;
    if (line.hop.kind === "target") edge = plan.edges.at(-1);
    else {
      const h = plan.hops[line.hop.index];
      const id = hopNode(h);
      edge = h?.kind === "command" ? plan.edges.find((e) => e.method === "command") : id ? into(id) : undefined;
    }
    if (!edge) continue;
    const before = out[edge.id];
    if (before?.s === "bad") continue;
    if (line.ok) out[edge.id] = { s: "ok", ms: (before?.ms ?? 0) + line.ms };
    else {
      const refused = line.failure === "Forbidden" && edge.method === "ssh";
      out[edge.id] = { s: "bad", ms: line.ms, text: line.error?.message ?? "The hop failed.", ...(refused ? { hint: true } : {}) };
    }
  }
  return out;
}

// ---- where nodes are drawn -----------------------------------------------------------------------------

export const MAP_W = 960;
export const MAP_H = 610;

export interface Point {
  x: number;
  y: number;
}

/** The half size of a node's box. */
export const halfOf = (n: MapNode): [number, number] => (n.kind === "server" ? [58, 23] : [75, 23]);

/** The least gap a column keeps between nodes, so a link's label fits in it. */
const COLUMN = 210;

/** Each node's step from this server along its way in (1 for a node nothing reaches). */
function depthsOf(g: MapGraph, via: Via): Map<string, number> {
  const depth = new Map<string, number>([[SERVER_ID, 0]]);
  const depthOf = (id: string, guard = new Set<string>()): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (guard.has(id)) return 1;
    guard.add(id);
    const e = edgeById(g, via[id] ?? "");
    const d = e ? depthOf(e.from, guard) + 1 : 1;
    depth.set(id, d);
    return d;
  };
  for (const n of g.nodes) depthOf(n.id);
  return depth;
}

/** The map's width: wide enough for a column per step, never less than the default. */
export function mapWidth(g: MapGraph, via: Via): number {
  const deepest = Math.max(0, ...depthsOf(g, via).values());
  return Math.max(MAP_W, 80 + deepest * COLUMN + 110);
}

/** A column per step from this server and a row per node in it, for the nodes a person has not moved. */
export function layout(g: MapGraph, via: Via, saved: Record<string, Point>): Record<string, Point> {
  const depth = depthsOf(g, via);
  const columns = new Map<number, MapNode[]>();
  for (const n of g.nodes) {
    const d = depth.get(n.id) ?? 1;
    columns.set(d, [...(columns.get(d) ?? []), n]);
  }
  const width = mapWidth(g, via);
  const maxDepth = Math.max(0, ...columns.keys());
  const step = maxDepth === 0 ? 0 : Math.min(260, (width - 190) / maxDepth);
  const out: Record<string, Point> = {};
  // Left to right; in a column the nodes sit near the ones that reach them (the mean height of
  // their sources), so the links cross as little as a simple pass can make them.
  for (const d of [...columns.keys()].sort((a, b) => a - b)) {
    const list = columns.get(d) ?? [];
    const pull = (n: MapNode): number => {
      const ys = g.edges.filter((e) => e.to === n.id && out[e.from] !== undefined).map((e) => (out[e.from] as Point).y);
      return ys.length > 0 ? ys.reduce((a, b) => a + b, 0) / ys.length : MAP_H / 2;
    };
    const ordered = [...list].sort((a, b) => pull(a) - pull(b) || a.name.localeCompare(b.name));
    ordered.forEach((n, i) => {
      out[n.id] = saved[n.id] ?? { x: 80 + d * step, y: Math.round(((i + 1) * MAP_H) / (ordered.length + 1)) };
    });
  }
  return out;
}

export const clampPoint = (p: Point, width: number = MAP_W): Point => ({ x: Math.max(70, Math.min(width - 70, p.x)), y: Math.max(30, Math.min(MAP_H - 30, p.y)) });

/** The owner of a link between two nodes: a personal node and a shared one cannot be joined (DOC-23 (ae)). */
export function ownerOfLink(a: MapNode, b: MapNode): { owner: "personal" | "shared" } | { reason: string } {
  const owners = new Set([a.owner, b.owner].filter((o) => o !== undefined));
  if (owners.size > 1) return { reason: `${a.name} and ${b.name} have different owners: a personal node and a shared one cannot be linked.` };
  return { owner: owners.has("shared") ? "shared" : "personal" };
}
