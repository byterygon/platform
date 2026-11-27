// The network map's model (DOC-23 §10, (aa) to (ad), TSK-145): the graph the server's links, hosts,
// proxies, routes and profiles make, the way in each node has, the path to a node, the rules a new
// link keeps (and the reason each refusal gives), the hops a path becomes for Test and Save as route,
// and how a test's lines colour the links.
import { describe, expect, test } from "vitest";
import type { LinkView, Method, Node, ProxyView, RouteTestLine, RouteView, SshHostView } from "@/gen/api";
import { emptyScratch } from "@/app/map/model";
import {
  type MapSource,
  SERVER_ID,
  buildGraph,
  edgeResults,
  hostNodeId,
  addressOfProfile,
  layout,
  linkTargets,
  mapWidth,
  nodeById,
  ownerOfLink,
  pathTo,
  proxyNodeId,
  resolveVia,
  routeHops,
  routeNameFor,
  targetNodeId,
  testPlan,
  whyNot,
} from "@/app/map/model";

const SERVER: Node = { kind: "server" };
const H = (id: string): Node => ({ kind: "sshHost", id });
const P = (id: string): Node => ({ kind: "proxy", id });
const TARGET: Node = { kind: "target" };

function link(id: string, from: Node, to: Node, method: Method, patch: Partial<LinkView> = {}): LinkView {
  const cmd = method === "command" || method === "sshCommand";
  return { id, from, to, method, args: [], env: [], needsConfirmation: cmd, owner: { kind: "personal" }, etag: "1", createdAt: id, updatedAt: "", createdBy: "", updatedBy: "", access: "owner", usedBy: [], usedByHidden: 0, ...patch };
}
const host = (id: string, name: string, address = `${name}.internal`): SshHostView => ({ id, name, fields: { host: address, port: 22, username: "ops", auth: "agent", keepaliveSec: null, hostKey: null }, owner: { kind: "personal" }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 }) as SshHostView;
const proxy = (id: string, name: string, kind: "socks5" | "httpConnect" = "socks5"): ProxyView => ({ id, name, fields: { kind, host: `${name}.corp`, port: 1080, tls: false, username: null, caPem: null }, url: "", owner: { kind: "personal" }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 }) as ProxyView;
const route = (id: string, name: string, linkIds: string[]): RouteView => ({ id, name, kind: "path", hops: linkIds.map((linkId) => ({ kind: "ssh", label: "x", linkId, needsConfirmation: false, args: [], env: [] })), confirmed: true, owner: { kind: "personal" }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", usedBy: [], usedByHidden: 0 });

/** corp-socks → bastion → docker1, and lab reached directly; a profile's route ends at docker1 → target. */
function source(patch: Partial<MapSource> = {}): MapSource {
  return {
    hosts: [host("B", "bastion", "bastion.prod"), host("D", "docker1"), host("L", "lab")],
    proxies: [proxy("S", "corp-socks")],
    links: [link("e1", SERVER, P("S"), "tcp"), link("e2", P("S"), H("B"), "connect"), link("e3", H("B"), H("D"), "ssh"), link("e4", SERVER, H("L"), "command", { program: "tsh", args: ["proxy", "ssh", "{host}:{port}"] }), link("e5", H("D"), TARGET, "ssh")],
    routes: [route("R1", "prod", ["e1", "e2", "e3", "e5"].filter((i) => i === "e5"))],
    profiles: [{ id: "T1", tool: "temporal", name: "prod-cluster", fields: { address: "temporal.prod.internal:7233", routeId: "R1" } }],
    scratch: emptyScratch(),
    ...patch,
  };
}

describe("the graph", () => {
  test("is the server, the saved hosts and proxies, the links between them and each profile's target", () => {
    const g = buildGraph(source());
    expect(g.nodes.map((n) => n.id)).toEqual([SERVER_ID, hostNodeId("B"), hostNodeId("D"), hostNodeId("L"), proxyNodeId("S"), targetNodeId("T1")]);
    expect(g.edges.map((e) => [e.id, e.from, e.to, e.method])).toEqual([
      ["e1", SERVER_ID, "proxy:S", "tcp"],
      ["e2", "proxy:S", "host:B", "connect"],
      ["e3", "host:B", "host:D", "ssh"],
      ["e4", SERVER_ID, "host:L", "command"],
      ["e5@T1", "host:D", "target:T1", "ssh"],
    ]);
    expect(nodeById(g, "target:T1")).toMatchObject({ name: "prod-cluster", address: "temporal.prod.internal:7233", kind: "target" });
    expect(nodeById(g, "proxy:S")?.kind).toBe("socks");
  });

  test("a command link nobody confirmed is drawn as such; a profile whose route is gone has no target", () => {
    const g = buildGraph(source({ routes: [] }));
    expect(g.edges.find((e) => e.id === "e4")?.unconfirmed).toBe(true);
    expect(g.nodes.some((n) => n.kind === "target")).toBe(false);
  });

  test("a target added on the map and its links come from this browser", () => {
    const scratch = { targets: [{ id: "s1", name: "staging", address: "svc.internal:443" }], edges: [{ id: "x1", from: "host:L", to: "s1", method: "ssh" as Method }] };
    const g = buildGraph(source({ scratch }));
    expect(nodeById(g, "s1")).toMatchObject({ scratch: true, address: "svc.internal:443" });
    expect(g.edges.find((e) => e.id === "x1")).toMatchObject({ from: "host:L", to: "s1", method: "ssh" });
  });
});

describe("the rules of a new link", () => {
  const g = buildGraph(source({ scratch: { targets: [{ id: "s1", name: "staging", address: "svc:443" }], edges: [] } }));

  test("each refusal says why", () => {
    expect(whyNot(g, "host:B", "host:B")).toBe("Pick another node.");
    expect(whyNot(g, "target:T1", "host:B")).toMatch(/prod-cluster is a target: nothing is reached through it/);
    expect(whyNot(g, "host:B", SERVER_ID)).toBe("Nothing connects into this server.");
    expect(whyNot(g, "host:B", "host:D")).toMatch(/bastion already reaches docker1/);
    expect(whyNot(g, "host:D", "host:B")).toBe("That would make a loop.");
    expect(whyNot(g, "host:L", "target:T1")).toMatch(/profile's target.*Connect through/);
  });

  test("what is allowed: the nodes a link may reach", () => {
    expect(linkTargets(g, "host:L").map((n) => n.id).sort()).toEqual(["host:B", "host:D", "proxy:S", "s1"]);
    expect(linkTargets(g, "target:T1")).toEqual([]);
    expect(whyNot(g, "host:L", "s1")).toBe("");
  });

  test("a personal node and a shared one are not linked", () => {
    const shared = { ...nodeById(g, "host:B")!, owner: "shared" as const };
    expect(ownerOfLink(nodeById(g, "host:D")!, shared)).toMatchObject({ reason: expect.stringMatching(/different owners/) });
    expect(ownerOfLink(nodeById(g, SERVER_ID)!, shared)).toEqual({ owner: "shared" });
    expect(ownerOfLink(nodeById(g, SERVER_ID)!, nodeById(g, "host:D")!)).toEqual({ owner: "personal" });
  });
});

describe("ways in and paths", () => {
  test("a node with two ways in has the one chosen; a gone choice falls back to one the server reaches", () => {
    const s = source({ links: [...source().links, link("e6", SERVER, H("D"), "tcp")] });
    const g = buildGraph(s);
    expect(resolveVia(g, { "host:D": "e3" })["host:D"]).toBe("e3");
    expect(resolveVia(g, { "host:D": "gone" })["host:D"]).toBe("e3");
    const via = resolveVia(g, {});
    expect(pathTo(g, via, "host:D").edges.map((e) => e.id)).toEqual(via["host:D"] === "e6" ? ["e6"] : ["e1", "e2", "e3"]);
  });

  test("the path to a node runs from the server along each way in, and stops at a node nothing reaches", () => {
    const g = buildGraph(source());
    const via = resolveVia(g, {});
    expect(pathTo(g, via, "host:D")).toMatchObject({ ok: true });
    expect(pathTo(g, via, "host:D").edges.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(pathTo(g, via, "target:T1").edges.map((e) => e.id)).toEqual(["e1", "e2", "e3", "e5@T1"]);
    const lonely = buildGraph(source({ links: [], routes: [], profiles: [] }));
    expect(pathTo(lonely, resolveVia(lonely, {}), "host:D")).toEqual({ edges: [], ok: false });
  });

  test("a loop in the saved links does not hang a walk", () => {
    const g = buildGraph(source({ links: [link("a", H("B"), H("D"), "ssh"), link("b", H("D"), H("B"), "ssh")], routes: [], profiles: [] }));
    const via = resolveVia(g, {});
    expect(pathTo(g, via, "host:B").ok).toBe(false);
  });
});

describe("from a path to hops", () => {
  const g = buildGraph(source());
  const via = resolveVia(g, {});

  test("a route to a node passes the nodes before it and leaves it by its way", () => {
    expect(routeHops(g, via, "host:D")).toEqual({ hops: [{ kind: "proxy", proxyId: "S" }, { kind: "ssh", sshHostId: "B" }, { kind: "ssh", sshHostId: "D" }] });
    expect(routeHops(g, via, "target:T1")).toEqual({ hops: [{ kind: "proxy", proxyId: "S" }, { kind: "ssh", sshHostId: "B" }, { kind: "ssh", sshHostId: "D" }] });
    expect(routeHops(g, via, SERVER_ID).reason).toBeDefined();
  });

  test("a command on the path waits for its confirmation; once confirmed it is the first hop", () => {
    expect(routeHops(g, via, "host:L").reason).toMatch(/not confirmed/);
    const confirmed = buildGraph(source({ links: source().links.map((l) => (l.id === "e4" ? { ...l, confirmed: { by: "u", at: "t" } } : l)) }));
    const v = resolveVia(confirmed, {});
    expect(routeHops(confirmed, v, "host:L")).toEqual({ hops: [{ kind: "command", program: "tsh", args: ["proxy", "ssh", "{host}:{port}"], env: [], cwd: null }, { kind: "ssh", sshHostId: "L" }] });
  });

  test("a test dials the node's address through the hops before it", () => {
    const plan = testPlan(g, via, "host:D");
    expect(plan).toMatchObject({ target: "docker1.internal:22", hops: [{ kind: "proxy" }, { kind: "ssh", sshHostId: "B" }] });
    expect(testPlan(g, via, "host:L")).toMatchObject({ reason: expect.stringMatching(/not confirmed/) });
    expect(testPlan(g, via, "proxy:S")).toMatchObject({ reason: expect.stringMatching(/directly/) });
  });

  test("a route is named after its node, and a name taken gets a number", () => {
    expect(routeNameFor(g, "host:D", [])).toBe("docker1");
    expect(routeNameFor(g, "host:D", ["Docker1", "docker1 2"])).toBe("docker1 3");
  });
});

describe("a test colours the links", () => {
  const g = buildGraph(source());
  const via = resolveVia(g, {});
  const line = (index: number, kind: string, ok: boolean, patch: Partial<RouteTestLine> = {}): RouteTestLine => ({ hop: { index, kind, label: "x" }, ok, ms: 4, ...patch });

  test("each line belongs to the link that opened the node it names; the target's is the last", () => {
    const plan = testPlan(g, via, "target:T1");
    if ("reason" in plan) throw new Error(plan.reason);
    const out = edgeResults(g, plan, [line(0, "socks5", true), line(1, "ssh", true), line(2, "ssh", true), line(3, "target", true, { ms: 9 })]);
    expect(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.s]))).toEqual({ e1: "ok", e2: "ok", e3: "ok", "e5@T1": "ok" });
    expect(out["e5@T1"]?.ms).toBe(9);
  });

  test("the first failure marks its link, with the error and the offer of an SSH command when the host forbade forwarding", () => {
    const plan = testPlan(g, via, "target:T1");
    if ("reason" in plan) throw new Error(plan.reason);
    const failed = line(2, "ssh", false, { failure: "Forbidden", error: { kind: "Forbidden", system: "routes", message: "through route x: hop 3 refused to forward", retryable: false } as NonNullable<RouteTestLine["error"]> });
    const out = edgeResults(g, plan, [line(0, "socks5", true), line(1, "ssh", true), failed]);
    expect(out.e1?.s).toBe("ok");
    expect(out.e2?.s).toBe("ok");
    expect(out.e3).toMatchObject({ s: "bad", text: expect.stringMatching(/refused to forward/), hint: true });
    expect(out["e5@T1"]).toBeUndefined();
  });

  test("a leading command's line is the command link's", () => {
    const confirmed = buildGraph(source({ links: source().links.map((l) => (l.id === "e4" ? { ...l, confirmed: { by: "u", at: "t" } } : l)) }));
    const v = resolveVia(confirmed, {});
    const plan = testPlan(confirmed, v, "host:L");
    expect(plan).toMatchObject({ hops: [{ kind: "command" }] });
    if ("reason" in plan) throw new Error(plan.reason);
    const out = edgeResults(confirmed, plan, [line(0, "command", true, { ms: 7 }), line(1, "target", false, { failure: "Connect", error: { kind: "Remote", system: "routes", message: "no route", retryable: false } as NonNullable<RouteTestLine["error"]> })]);
    expect(out.e4).toMatchObject({ s: "bad" });
  });
});

describe("where nodes are drawn", () => {
  test("a column per step from the server, and a node a person moved stays where it was put", () => {
    const g = buildGraph(source());
    const via = resolveVia(g, {});
    const at = layout(g, via, {});
    expect(at[SERVER_ID]?.x).toBeLessThan(at["proxy:S"]?.x ?? 0);
    expect(at["proxy:S"]?.x).toBeLessThan(at["host:B"]?.x ?? 0);
    expect(at["host:B"]?.x).toBeLessThan(at["host:D"]?.x ?? 0);
    expect(layout(g, via, { "host:D": { x: 500, y: 400 } })["host:D"]).toEqual({ x: 500, y: 400 });
  });

  test("a node sits at the height of what reaches it, and a deep path widens the map", () => {
    const g = buildGraph(source());
    const via = resolveVia(g, {});
    const at = layout(g, via, {});
    // The target and the last host that reaches it are one row apart at most; lab's column has its own row.
    expect(Math.abs((at["target:T1"]?.y ?? 0) - (at["host:D"]?.y ?? 0))).toBeLessThan(200);
    expect(mapWidth(g, via)).toBeGreaterThanOrEqual(960);
    const hosts = [...source().hosts, host("X", "x")];
    const chain = [link("a", SERVER, H("B"), "tcp"), link("b", H("B"), H("D"), "ssh"), link("c", H("D"), H("L"), "ssh"), link("d", H("L"), P("S"), "ssh"), link("e", P("S"), H("X"), "connect")];
    const deep = buildGraph(source({ hosts, links: chain, routes: [], profiles: [] }));
    expect(mapWidth(deep, resolveVia(deep, {}))).toBeGreaterThan(960);
  });

  test("a profile's target shows its own address; NATS shows its first server", () => {
    expect(addressOfProfile("temporal", { address: "t:7233" })).toBe("t:7233");
    expect(addressOfProfile("nats", { servers: ["nats://n1.internal:4223", "nats://n2:4222"] })).toBe("n1.internal:4223");
    expect(addressOfProfile("nats", { servers: ["n3.internal"] })).toBe("n3.internal:4222");
    expect(addressOfProfile("kafka", {})).toBe("");
  });
});
