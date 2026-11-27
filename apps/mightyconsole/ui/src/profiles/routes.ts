// Routes and proxies (DOC-23 §8.1, (aa) to (ac), TSK-117): a route is a named path from this server
// to a profile's target, through saved proxies and SSH hosts and, first, perhaps a local command.
// They live on the server (`routes.*`, `proxies.*`), with the proxies' passwords and the commands'
// secret variables write-only; this module keeps the lists the server answered, so Settings →
// Routes, the route editor and every profile's Connect through read the same ones, and reloads
// them when the server says a route, a proxy or an SSH host changed.
import { useSyncExternalStore } from "react";
import type { MightyClient } from "@/app/client";
import type { EnvInput, HopInput, HopView, OwnerWire, ProxyFields, ProxyKind, ProxyView, RouteKind, RouteTestOutput, RouteView } from "@/gen/api";

/** The most hops a route may have (DOC-23 Open question (f)). */
export const MAX_HOPS = 8;

function store<T extends { id: string; name: string }>() {
  let items: readonly T[] = [];
  let loaded = false;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const l of listeners) l();
  };
  return {
    get: () => items,
    loaded: () => loaded,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(next: readonly T[]) {
      items = [...next].sort((a, b) => a.name.localeCompare(b.name));
      loaded = true;
      notify();
    },
    put(item: T) {
      this.publish([...items.filter((i) => i.id !== item.id), item]);
    },
    drop(id: string) {
      this.publish(items.filter((i) => i.id !== id));
    },
    reset(list: readonly T[]) {
      items = list;
      loaded = list.length > 0;
      notify();
    },
  };
}

const routeStore = store<RouteView>();
const proxyStore = store<ProxyView>();

/** The routes as last read. */
export const routes = (): readonly RouteView[] => routeStore.get();
/** The proxies as last read. */
export const proxies = (): readonly ProxyView[] => proxyStore.get();
export const routesLoaded = (): boolean => routeStore.loaded();

/** The routes, re-rendering when they change. */
export function useRoutes(): readonly RouteView[] {
  return useSyncExternalStore(routeStore.subscribe.bind(routeStore), routeStore.get, routeStore.get);
}

/** The proxies, re-rendering when they change. */
export function useProxies(): readonly ProxyView[] {
  return useSyncExternalStore(proxyStore.subscribe.bind(proxyStore), proxyStore.get, proxyStore.get);
}

export function routeById(id: string | undefined | null): RouteView | undefined {
  return id ? routeStore.get().find((r) => r.id === id) : undefined;
}

export function proxyById(id: string | undefined | null): ProxyView | undefined {
  return id ? proxyStore.get().find((p) => p.id === id) : undefined;
}

/** Reads the routes and the proxies again. */
export async function reloadRoutes(client: MightyClient): Promise<void> {
  const [r, p] = await Promise.all([client.routes.list({}), client.proxies.list({})]);
  routeStore.publish(r.routes);
  proxyStore.publish(p.proxies);
}

/** Forgets the lists (sign-out, tests). */
export function resetRoutes(list: readonly RouteView[] = [], proxyList: readonly ProxyView[] = []) {
  routeStore.reset(list);
  proxyStore.reset(proxyList);
}

// ---- labels ------------------------------------------------------------------------------------

export type HopKind = HopView["kind"];

export const HOP_KIND_LABELS: Record<string, string> = {
  httpConnect: "HTTP CONNECT",
  socks5: "SOCKS5",
  ssh: "SSH",
  sshCommand: "SSH command",
  command: "Local command",
  target: "Target",
};

/** How the hop before reaches this one, as the path figure labels its arrow (DOC-23 §10). */
export const ARROW_LABELS: Record<string, string> = {
  httpConnect: "CONNECT",
  socks5: "SOCKS5",
  ssh: "SSH channel",
  sshCommand: "SSH command",
  command: "stdio",
};

/** `SOCKS5 proxy.corp:1080`, as a chip of the list shows a hop. */
export function hopChip(hop: HopView): string {
  return `${HOP_KIND_LABELS[hop.kind] ?? hop.kind} ${hop.nodeName && hop.kind !== "command" ? hop.nodeName : hop.label}`;
}

/** "Hop 2, SSH bastion.prod:22" (an error's or a line's node). */
export function hopTitle(hop: { index: number; kind: string; label: string }): string {
  if (hop.kind === "target") return `Target ${hop.label}`;
  return `Hop ${hop.index + 1}, ${HOP_KIND_LABELS[hop.kind] ?? hop.kind} ${hop.label}`;
}

export function proxyUrl(fields: Pick<ProxyFields, "kind" | "tls" | "host" | "port">): string {
  const scheme = fields.kind === "socks5" ? "socks5" : fields.tls ? "https" : "http";
  const host = fields.host.includes(":") ? `[${fields.host}]` : fields.host;
  return `${scheme}://${host}:${fields.port}`;
}

/** "2 profiles", or "Not used". */
export function routeUsedByText(route: RouteView): string {
  const n = route.usedBy.length + route.usedByHidden;
  return n === 0 ? "Not used" : `${n} profile${n === 1 ? "" : "s"}`;
}

/** The hops a route's view sends back to the server unchanged (a secret variable keeps its value). */
export function hopsOf(route: RouteView): HopInput[] {
  return route.hops.map((h) => hopInputOf(h));
}

export function hopInputOf(h: HopView): HopInput {
  switch (h.kind) {
    case "httpConnect":
    case "socks5":
      return { kind: "proxy", proxyId: h.proxyId ?? "" };
    case "ssh":
      return { kind: "ssh", sshHostId: h.sshHostId ?? "" };
    case "sshCommand":
      return { kind: "sshCommand", sshHostId: h.sshHostId ?? "", command: h.command ?? "" };
    default:
      return {
        kind: "command",
        program: h.program ?? "",
        args: [...h.args],
        env: h.env.map((v): EnvInput => (v.secret ? { name: v.name, secret: true, value: null } : { name: v.name, secret: false, value: v.value ?? "" })),
        cwd: h.cwd ?? null,
      };
  }
}

// ---- the editor's draft --------------------------------------------------------------------------

/** A hop as the editor holds it: its input, and a key that survives reordering. */
export interface DraftHop {
  key: string;
  hop: HopInput;
  /** A new proxy hop before a proxy is chosen: which kind of proxy it asks for. */
  proxyKind?: ProxyKind;
}

export interface RouteDraft {
  name: string;
  kind: RouteKind;
  hops: DraftHop[];
  shared: boolean;
}

let nextKey = 0;
export const hopKey = (): string => `h${++nextKey}`;

export function emptyRouteDraft(kind: RouteKind = "path"): RouteDraft {
  return { name: "", kind, hops: [], shared: false };
}

export function routeDraftOf(route: RouteView): RouteDraft {
  return { name: route.name, kind: route.kind, hops: hopsOf(route).map((hop) => ({ key: hopKey(), hop })), shared: route.owner.kind === "shared" };
}

export type RouteErrors = { name?: string; hops?: string } & Record<`hop${number}`, string | undefined>;

/** The draft's problems, before the server checks it again. */
export function validateRoute(d: RouteDraft): RouteErrors {
  const errors: RouteErrors = {};
  if (d.name.trim() === "") errors.name = "A name is required.";
  if (d.kind === "system") return errors;
  if (d.hops.length === 0) errors.hops = "Add the hop the server contacts first.";
  if (d.hops.length > MAX_HOPS) errors.hops = `A route has at most ${MAX_HOPS} hops.`;
  const seen = new Set<string>();
  d.hops.forEach(({ hop }, i) => {
    const key = `hop${i}` as const;
    switch (hop.kind) {
      case "proxy":
        if (!hop.proxyId) errors[key] = "Choose a proxy, or make one.";
        else if (seen.has(hop.proxyId)) errors[key] = "A route passes each proxy once.";
        seen.add(hop.proxyId);
        break;
      case "ssh":
      case "sshCommand":
        if (!hop.sshHostId) errors[key] = "Choose an SSH host, or make one.";
        else if (seen.has(hop.sshHostId)) errors[key] = "A route passes each SSH host once.";
        seen.add(hop.sshHostId);
        if (hop.kind === "sshCommand" && hop.command.trim() === "") errors[key] = "Enter the command to run on the host, such as nc {host} {port}.";
        break;
      case "command":
        if (i > 0) errors[key] = "A local command comes first in a route.";
        else if (hop.program.trim() === "") errors[key] = "Enter the program to run.";
        else {
          const names = hop.env.map((v) => v.name);
          if (names.some((n) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) errors[key] = "A variable name is letters, digits and _.";
          else if (new Set(names).size !== names.length) errors[key] = "A variable is set twice.";
        }
        break;
    }
  });
  return errors;
}

export function hasErrors(errors: RouteErrors): boolean {
  return Object.values(errors).some((e) => e !== undefined);
}

/** Moves the hop at `from` to `to` (both in range). */
export function moveHop(hops: readonly DraftHop[], from: number, to: number): DraftHop[] {
  const next = [...hops];
  const [moved] = next.splice(from, 1);
  if (moved) next.splice(to, 0, moved);
  return next;
}

// ---- server calls ----------------------------------------------------------------------------------

/** Creates (`base` absent) or updates a route; the view the server answered. */
export async function saveRoute(client: MightyClient, d: RouteDraft, base?: RouteView): Promise<RouteView> {
  const hops = d.hops.map((h) => h.hop);
  const saved = base
    ? await client.routes.update({ id: base.id, etag: base.etag, name: d.name.trim(), hops: d.kind === "system" ? null : hops })
    : await client.routes.create({ name: d.name.trim(), owner: d.shared ? { kind: "shared" } : { kind: "personal" }, kind: d.kind, hops: d.kind === "system" ? [] : hops });
  routeStore.put(saved);
  return saved;
}

export async function duplicateRoute(client: MightyClient, route: RouteView, name: string): Promise<RouteView> {
  const copy = await client.routes.duplicate({ id: route.id, name });
  routeStore.put(copy);
  return copy;
}

export async function deleteRoute(client: MightyClient, route: RouteView): Promise<void> {
  await client.routes.delete({ id: route.id, name: route.name });
  routeStore.drop(route.id);
}

/** A person read the commands of these hops in full (DOC-23 11.3). */
export async function confirmRoute(client: MightyClient, route: RouteView, linkIds: readonly string[]): Promise<RouteView> {
  const out = await client.routes.confirm({ id: route.id, links: [...linkIds] });
  routeStore.put(out);
  return out;
}

/** The hops of a route that wait for a confirmation. */
export function unconfirmedHops(route: RouteView): HopView[] {
  return route.hops.filter((h) => h.needsConfirmation && !h.confirmed);
}

/** Test (DOC-23 §9): a saved route, or the editor's draft. */
export async function testRoute(client: MightyClient, target: { host: string; port: number }, route: { id: string } | { hops: HopInput[] }): Promise<RouteTestOutput> {
  return "id" in route ? client.routes.test({ routeId: route.id, target }) : client.routes.test({ hops: route.hops, target });
}

// ---- proxies -----------------------------------------------------------------------------------------

export interface ProxyDraft {
  name: string;
  kind: ProxyKind;
  tls: boolean;
  host: string;
  port: string;
  username: string;
  /** Typed; empty keeps the stored one. */
  password: string;
  caPem: string;
  shared: boolean;
}

export const DEFAULT_PROXY_PORT: Record<ProxyKind, number> = { httpConnect: 3128, socks5: 1080 };

export function emptyProxyDraft(kind: ProxyKind = "httpConnect"): ProxyDraft {
  return { name: "", kind, tls: false, host: "", port: "", username: "", password: "", caPem: "", shared: false };
}

export function proxyDraftOf(view: ProxyView): ProxyDraft {
  const f = view.fields;
  return { name: view.name, kind: f.kind, tls: f.tls, host: f.host, port: String(f.port), username: f.username ?? "", password: "", caPem: f.caPem ?? "", shared: view.owner.kind === "shared" };
}

export type ProxyErrors = Partial<Record<"name" | "host" | "port" | "username" | "caPem", string>>;

export function validateProxy(d: ProxyDraft): ProxyErrors {
  const errors: ProxyErrors = {};
  if (d.name.trim() === "") errors.name = "A name is required.";
  const host = d.host.trim();
  if (host === "") errors.host = "The proxy's host name or address is required.";
  else if (/\s|@|\/|:\/\//.test(host)) errors.host = "Only the host: the scheme is the kind, the login has its own fields.";
  if (d.port.trim() !== "" && !(/^\d+$/.test(d.port.trim()) && Number(d.port) >= 1 && Number(d.port) <= 65535)) errors.port = "A port from 1 to 65535.";
  if (d.kind === "httpConnect" && d.username.includes(":")) errors.username = "A Basic login's user has no colon.";
  if (d.caPem.trim() !== "" && !d.caPem.includes("-----BEGIN CERTIFICATE-----")) errors.caPem = "A CA certificate in PEM.";
  return errors;
}

export function proxyFieldsOf(d: ProxyDraft): ProxyFields {
  return {
    kind: d.kind,
    host: d.host.trim(),
    port: d.port.trim() === "" ? DEFAULT_PROXY_PORT[d.kind] : Number(d.port),
    tls: d.kind === "httpConnect" && d.tls,
    username: d.username.trim() === "" ? null : d.username.trim(),
    caPem: d.kind === "httpConnect" && d.tls && d.caPem.trim() !== "" ? d.caPem : null,
  };
}

export async function saveProxy(client: MightyClient, d: ProxyDraft, base?: ProxyView): Promise<ProxyView> {
  const fields = proxyFieldsOf(d);
  const password = d.password === "" ? null : d.password;
  const owner: OwnerWire = d.shared ? { kind: "shared" } : { kind: "personal" };
  const saved = base ? (await client.proxies.update({ id: base.id, etag: base.etag, name: d.name.trim(), fields, password })).proxy : await client.proxies.create({ name: d.name.trim(), owner, fields, password });
  proxyStore.put(saved);
  return saved;
}

export async function deleteProxy(client: MightyClient, proxy: ProxyView): Promise<void> {
  await client.proxies.delete({ id: proxy.id, name: proxy.name });
  proxyStore.drop(proxy.id);
}
