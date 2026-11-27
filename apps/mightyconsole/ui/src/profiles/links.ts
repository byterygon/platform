// Links (DOC-23 §10, (aa), (bl), TSK-145): how one node (this server, an SSH host, a proxy) opens a
// stream to the next. They live on the server (`links.*`) and a route is an ordered path of them;
// this module keeps the list the server answered, so the network map and the route screens read
// the same one, and reloads it when the server says a link, a route, a proxy or an SSH host changed.
// A command link's secret variables are write-only, as in a route.
import { useSyncExternalStore } from "react";
import type { MightyClient } from "@/app/client";
import type { EnvInput, LinkSpecInput, LinkView, Method, Node, OwnerWire } from "@/gen/api";

let items: readonly LinkView[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: readonly LinkView[]) {
  items = [...next].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  loaded = true;
  for (const l of listeners) l();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The links as last read. */
export const links = (): readonly LinkView[] => items;
export const linksLoaded = (): boolean => loaded;

/** The links, re-rendering when they change. */
export function useLinks(): readonly LinkView[] {
  return useSyncExternalStore(subscribe, links, links);
}

export function linkById(id: string | undefined | null): LinkView | undefined {
  return id ? items.find((l) => l.id === id) : undefined;
}

/** Reads the links again. */
export async function reloadLinks(client: MightyClient): Promise<void> {
  publish((await client.links.list({})).links);
}

/** Forgets the list (sign-out, tests). */
export function resetLinks(list: readonly LinkView[] = []) {
  items = list;
  loaded = list.length > 0;
  for (const l of listeners) l();
}

// ---- labels -------------------------------------------------------------------------------------

/** What a link is called on the map and in its panel. */
export const METHOD_LABELS: Record<Method, string> = {
  tcp: "Direct TCP",
  command: "Local command",
  ssh: "SSH channel",
  sshCommand: "SSH command",
  connect: "Proxy CONNECT",
};

/** The methods a link out of `from` may use; the first is the one a new link gets. */
export function methodsFrom(from: Node): Method[] {
  switch (from.kind) {
    case "server":
      return ["tcp", "command"];
    case "sshHost":
      return ["ssh", "sshCommand"];
    case "proxy":
      return ["connect"];
    case "target":
      return [];
  }
}

export const sameNode = (a: Node, b: Node): boolean => a.kind === b.kind && ("id" in a ? "id" in b && a.id === b.id : true);

// ---- the spec of a link ---------------------------------------------------------------------------------

/** What a link does besides joining two nodes, as the panel holds it while it is edited. */
export interface LinkDraft {
  method: Method;
  program: string;
  /** One argument a line, no shell. */
  args: string;
  env: EnvInput[];
  cwd: string;
  command: string;
}

export function draftOfLink(link: LinkView): LinkDraft {
  return {
    method: link.method,
    program: link.program ?? "",
    args: link.args.join("\n"),
    env: link.env.map((v): EnvInput => (v.secret ? { name: v.name, secret: true, value: null } : { name: v.name, secret: false, value: v.value ?? "" })),
    cwd: link.cwd ?? "",
    command: link.command ?? "",
  };
}

/** A method's defaults when the panel switches to it (a command link starts with something to edit). */
export function draftForMethod(method: Method, from: Partial<LinkDraft> = {}): LinkDraft {
  const base: LinkDraft = { method, program: from.program ?? "", args: from.args ?? "", env: from.env ?? [], cwd: from.cwd ?? "", command: from.command ?? "" };
  if (method === "command" && base.program === "") return { ...base, program: "cloudflared", args: "access\nssh\n--hostname\n{host}" };
  if (method === "sshCommand" && base.command === "") return { ...base, command: "nc {host} {port}" };
  return base;
}

export function specOfDraft(d: LinkDraft): LinkSpecInput {
  const lines = d.args.split("\n").filter((l) => l !== "");
  return {
    method: d.method,
    program: d.method === "command" ? d.program.trim() : null,
    args: d.method === "command" ? lines : [],
    env: d.method === "command" ? d.env : [],
    cwd: d.method === "command" && d.cwd.trim() !== "" ? d.cwd.trim() : null,
    command: d.method === "sshCommand" ? d.command.trim() : null,
  };
}

/** What the draft changes of the saved link: a command link's confirmation is gone when this is true. */
export function changesWhatRuns(link: LinkView, d: LinkDraft): boolean {
  const before = draftOfLink(link);
  if (before.method !== d.method) return d.method === "command" || d.method === "sshCommand";
  return before.program !== d.program.trim() || before.args !== d.args.split("\n").filter((l) => l !== "").join("\n") || before.command !== d.command.trim() || before.env.map((v) => v.name).join("\n") !== d.env.map((v) => v.name).join("\n");
}

/** The line the link runs, with `{host}` and `{port}` filled in for `next` (`host:port`). */
export function previewOfDraft(d: LinkDraft, hop: { from: string; to: string; fromName: string; user?: string | undefined; next: string }): string {
  const { host, port } = splitAddress(hop.next);
  const fill = (s: string) => s.replaceAll("{host}", host).replaceAll("{port}", port);
  switch (d.method) {
    case "command":
      return `${d.program || "(program)"} ${d.args
        .split("\n")
        .filter((l) => l !== "")
        .map(fill)
        .join(" ")}`.trim();
    case "sshCommand":
      return `${fill(d.command)}   # on ${hop.fromName}${hop.user ? `, as ${hop.user}` : ""}`;
    case "ssh":
      return `direct-tcpip → ${host}:${port}   # through ${hop.fromName}`;
    case "connect":
      return `CONNECT ${hop.next}   # asked of ${hop.fromName}`;
    case "tcp":
      return `TCP ${hop.next}   # from this machine`;
  }
}

export function splitAddress(address: string): { host: string; port: string } {
  const bracket = address.match(/^\[(.*)\](?::(\d+))?$/);
  if (bracket) return { host: bracket[1] ?? "", port: bracket[2] ?? "22" };
  const m = address.match(/^(.*?)(?::(\d+))?$/);
  return { host: m?.[1] ?? address, port: m?.[2] ?? "22" };
}

// ---- server calls ------------------------------------------------------------------------------------------

export async function createLink(client: MightyClient, owner: OwnerWire, from: Node, to: Node, spec: LinkSpecInput): Promise<LinkView> {
  const saved = await client.links.create({ owner, from, to, spec });
  publish([...items.filter((l) => l.id !== saved.id), saved]);
  return saved;
}

export async function updateLink(client: MightyClient, link: LinkView, spec: LinkSpecInput): Promise<LinkView> {
  const saved = await client.links.update({ id: link.id, etag: link.etag, spec });
  publish(items.map((l) => (l.id === saved.id ? saved : l)));
  return saved;
}

export async function deleteLink(client: MightyClient, link: LinkView): Promise<void> {
  await client.links.delete({ id: link.id });
  publish(items.filter((l) => l.id !== link.id));
}

/** A person read the command of this link in full. */
export async function confirmLink(client: MightyClient, link: LinkView): Promise<LinkView> {
  const saved = await client.links.confirm({ id: link.id });
  publish(items.map((l) => (l.id === saved.id ? saved : l)));
  return saved;
}
