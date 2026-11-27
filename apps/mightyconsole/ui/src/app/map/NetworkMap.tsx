// Settings → Network map (DOC-23 §10, (aa) to (ad), (bl), TSK-145; mockup frames routes-map,
// routes-map-edge, routes-map-add, routes-map-test): every machine is a node (this server, SSH hosts,
// proxies, and the targets profiles use) and every way of reaching one is a link A → B, drawn in
// plain SVG. Drag a node; drag from the dot on a node to another node to link them with the first
// method the source allows (the reachable nodes are outlined; a refusal says why); click a link to
// set its method and, for a command, its program and arguments; click a node to light its route,
// choose its way in, Test it link by link and Save it as a route. The same things work from the
// keyboard: nodes and links take focus, Enter selects, Delete removes a link, and "Connect to…"
// does what dragging does. The links are the server's (`links.*`); the positions, the chosen ways
// in and the targets added here are kept in this browser (`mapState.ts`).
import { type KeyboardEvent, type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertDialog, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import type { ProxyKind, SshHostView } from "@/gen/api";
import { Add, ArrowRight, Info } from "@/lib/icons";
import { type LinkDraft, confirmLink, createLink, deleteLink, draftForMethod, reloadLinks, specOfDraft, splitAddress, updateLink, useLinks } from "@/profiles/links";
import { deleteProxy, emptyRouteDraft, hopKey, reloadRoutes, saveRoute, testRoute, useProxies, useRoutes } from "@/profiles/routes";
import { deleteHost, useSshHosts } from "@/profiles/ssh-hosts";
import type { DescribedError } from "@/tools/types";
import type { MightyClient } from "../client";
import { describeError } from "../messages";
import { ErrorState } from "../states";
import { ProxyForm } from "../routes/HopForms";
import { HostEditor } from "../ssh-hosts/HostEditor";
import { LinkPanel, NodePanel } from "./MapPanel";
import { type MapLocal, loadLocal, saveLocal } from "./mapState";
import {
  type EdgeResult,
  type MapEdge,
  type MapNode,
  type MapProfile,
  type Point,
  MAP_H,
  MAP_W,
  NODE_KIND_LABELS,
  SERVER_ID,
  buildGraph,
  clampPoint,
  edgeById,
  edgeLabel,
  edgeResults,
  halfOf,
  layout,
  mapWidth,
  methodsOf,
  nodeById,
  ownerOfLink,
  pathTo,
  planOfEdges,
  resolveVia,
  routeHops,
  routeNameFor,
  testPlan,
  whyNot,
  wireNode,
} from "./model";

export interface NetworkMapProps {
  client: MightyClient;
  /** The profiles, for the targets they reach and the routes they name. */
  profiles: readonly MapProfile[];
  /** Opens a profile (the target of a route). */
  onOpenProfile?: ((profileId: string, tool: string) => void) | undefined;
}

type Selection = { t: "n" | "e"; id: string } | null;

const NODE_CLASS: Record<MapNode["kind"], string> = {
  server: "fill-layer-alt",
  host: "fill-layer",
  socks: "fill-layer",
  http: "fill-layer",
  target: "fill-layer",
};

const cut = (text: string, chars: number) => (text.length > chars ? `${text.slice(0, chars - 1)}…` : text);

/** The point of a pointer event in the map's own coordinates. */
function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number, width: number): Point {
  const ctm = typeof svg.getScreenCTM === "function" ? svg.getScreenCTM() : null;
  if (ctm && typeof svg.createSVGPoint === "function") {
    const p = svg.createSVGPoint();
    p.x = clientX;
    p.y = clientY;
    const q = p.matrixTransform(ctm.inverse());
    return { x: q.x, y: q.y };
  }
  const r = svg.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: ((clientX - r.left) * width) / r.width, y: ((clientY - r.top) * MAP_H) / r.height } : { x: clientX, y: clientY };
}

export function NetworkMap({ client, profiles, onOpenProfile }: NetworkMapProps) {
  const links = useLinks();
  const hosts = useSshHosts();
  const proxies = useProxies();
  const routes = useRoutes();
  const [local, setLocal] = useState<MapLocal>(() => loadLocal());
  const [sel, setSel] = useState<Selection>(null);
  const [conn, setConn] = useState<{ from: string; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, EdgeResult> | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [routeName, setRouteName] = useState("");
  const [adding, setAdding] = useState<null | "host" | "proxy" | "target">(null);
  const [proxyKind, setProxyKind] = useState<ProxyKind>("socks5");
  const [editingHost, setEditingHost] = useState<SshHostView | null>(null);
  const [removing, setRemoving] = useState<MapNode | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ t: "conn" } | { t: "node"; id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null>(null);

  useEffect(() => {
    void reloadLinks(client).catch((e) => setError(describeError(e)));
    void reloadRoutes(client).catch(() => undefined);
  }, [client]);
  useEffect(() => saveLocal(local), [local]);

  const graph = useMemo(() => buildGraph({ links, hosts, proxies, routes, profiles, scratch: local.scratch }), [links, hosts, proxies, routes, profiles, local.scratch]);
  const via = useMemo(() => resolveVia(graph, local.via), [graph, local.via]);
  const pos = useMemo(() => layout(graph, via, local.positions), [graph, via, local.positions]);
  const width = useMemo(() => mapWidth(graph, via), [graph, via]);

  const selected = sel?.t === "n" ? nodeById(graph, sel.id) : undefined;
  const selectedEdge = sel?.t === "e" ? edgeById(graph, sel.id) : undefined;
  // A selection whose node or link is gone falls back to nothing.
  useEffect(() => {
    if (sel && !selected && !selectedEdge) setSel(null);
  }, [sel, selected, selectedEdge]);

  const select = (next: Selection) => {
    setSel(next);
    setMessage("");
    setError(null);
    if (next?.t === "n") setRouteName(routeNameFor(graph, next.id, routes.map((r) => r.name)));
  };

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  // ---- drawing helpers -------------------------------------------------------------------------

  const focusId = selected?.id ?? selectedEdge?.to ?? null;
  const focusPath = focusId && focusId !== SERVER_ID ? pathTo(graph, via, focusId) : null;
  const pathEdges = new Set(focusPath?.ok ? focusPath.edges.map((e) => e.id) : []);
  const pathNodes = new Set(focusPath?.ok ? focusPath.edges.flatMap((e) => [e.from, e.to]) : []);
  const candidate = (id: string) => (conn ? whyNot(graph, conn.from, id) === "" : false);
  const at = (id: string): Point => pos[id] ?? { x: 80, y: 80 };
  const nodeAt = (p: Point): MapNode | undefined =>
    graph.nodes.find((n) => {
      const [hw, hh] = halfOf(n);
      const c = at(n.id);
      return Math.abs(p.x - c.x) <= hw + 4 && Math.abs(p.y - c.y) <= hh + 4;
    });

  // ---- pointer ------------------------------------------------------------------------------------

  const onPointerDown = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const target = ev.target as Element;
    const svg = svgRef.current;
    if (!svg) return;
    const p = svgPoint(svg, ev.clientX, ev.clientY, width);
    const hd = target.closest("[data-hd]");
    const nd = target.closest("[data-n]");
    const ed = target.closest("[data-e]");
    const capture = () => {
      try {
        svg.setPointerCapture(ev.pointerId);
      } catch {
        // A synthetic pointer has nothing to capture.
      }
    };
    if (hd) {
      ev.preventDefault();
      capture();
      setConn({ from: hd.getAttribute("data-hd") as string, x: p.x, y: p.y });
      setHover(null);
      setMessage("");
      drag.current = { t: "conn" };
      return;
    }
    if (nd) {
      capture();
      const id = nd.getAttribute("data-n") as string;
      const c = at(id);
      drag.current = { t: "node", id, dx: p.x - c.x, dy: p.y - c.y, sx: ev.clientX, sy: ev.clientY, moved: false };
      return;
    }
    if (ed) {
      select({ t: "e", id: ed.getAttribute("data-e") as string });
      return;
    }
    select(null);
  };

  const onPointerMove = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const svg = svgRef.current;
    if (!d || !svg) return;
    const p = svgPoint(svg, ev.clientX, ev.clientY, width);
    if (d.t === "conn") {
      setConn((c) => (c ? { ...c, x: p.x, y: p.y } : c));
      setHover(nodeAt(p)?.id ?? null);
      return;
    }
    if (!d.moved && Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) < 4) return;
    d.moved = true;
    const next = clampPoint({ x: p.x - d.dx, y: p.y - d.dy }, width);
    setLocal((l) => ({ ...l, positions: { ...l.positions, [d.id]: next } }));
  };

  const onPointerUp = (ev: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    const svg = svgRef.current;
    drag.current = null;
    if (!d || !svg) return;
    if (d.t === "conn") {
      const from = conn?.from;
      const over = nodeAt(svgPoint(svg, ev.clientX, ev.clientY, width));
      setConn(null);
      setHover(null);
      if (from && over) void link(from, over.id);
      return;
    }
    if (!d.moved) select({ t: "n", id: d.id });
  };

  const onKeyDown = (ev: KeyboardEvent<SVGSVGElement>) => {
    const el = (ev.target as Element).closest("[data-n],[data-e]");
    if (!el) return;
    const n = el.getAttribute("data-n");
    const e = el.getAttribute("data-e");
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      select(n ? { t: "n", id: n } : { t: "e", id: e as string });
    }
    if ((ev.key === "Delete" || ev.key === "Backspace") && e) {
      ev.preventDefault();
      const edge = edgeById(graph, e);
      if (edge) void removeEdge(edge);
    }
  };

  // ---- what a person does ---------------------------------------------------------------------------------

  /** Links `from` to `to` with the first method the source allows. */
  async function link(from: string, to: string) {
    const a = nodeById(graph, from);
    const b = nodeById(graph, to);
    const why = whyNot(graph, from, to);
    if (!a || !b || why) return setMessage(why || "Pick another node.");
    const method = methodsOf(a)[0];
    if (!method) return setMessage(`${a.name} reaches nothing.`);
    if (b.scratch) {
      const id = `scratch-edge:${from}>${to}`;
      setLocal((l) => ({ ...l, scratch: { ...l.scratch, edges: [...l.scratch.edges, { id, from, to, method }] } }));
      setResults(null);
      select({ t: "e", id });
      return setMessage(`Linked ${a.name} to ${b.name}. A link to a target you added stays in this browser.`);
    }
    const owner = ownerOfLink(a, b);
    if ("reason" in owner) return setMessage(owner.reason);
    await run(async () => {
      const saved = await createLink(client, { kind: owner.owner }, wireNode(a), wireNode(b), specOfDraft(draftForMethod(method)));
      setResults(null);
      setSel({ t: "e", id: saved.id });
      setMessage(`Linked ${a.name} to ${b.name}. Pick how below.`);
    });
  }

  async function removeEdge(e: MapEdge) {
    if (!e.link) {
      setLocal((l) => ({ ...l, scratch: { ...l.scratch, edges: l.scratch.edges.filter((x) => x.id !== e.id) } }));
      setSel(null);
      return setMessage("Link removed.");
    }
    if (e.routes.length > 0) return setMessage(`A route uses this link (${e.routes.join(", ")}): take it out of the route first.`);
    await run(async () => {
      if (e.link) await deleteLink(client, e.link);
      setSel(null);
      setResults(null);
      setMessage("Link removed.");
    });
  }

  async function saveEdge(e: MapEdge, draft: LinkDraft) {
    if (!e.link) return;
    const link = e.link;
    await run(async () => {
      await updateLink(client, link, specOfDraft(draft));
      setResults(null);
      setMessage(draft.method === "command" || draft.method === "sshCommand" ? "Saved. A command waits for you to confirm it." : "Saved.");
    });
  }

  async function fix(edgeId: string) {
    const e = edgeById(graph, edgeId);
    if (!e?.link) return;
    const link = e.link;
    await run(async () => {
      const saved = await updateLink(client, link, specOfDraft(draftForMethod("sshCommand")));
      setSel({ t: "e", id: saved.id });
      setResults(null);
      setMessage("Switched to SSH command. Confirm it, then test again.");
    });
  }

  async function runTest(plan: ReturnType<typeof planOfEdges> | ReturnType<typeof testPlan>) {
    if ("reason" in plan) return setMessage(plan.reason);
    const { host, port } = splitAddress(plan.target);
    setResults(Object.fromEntries(plan.edges.map((e) => [e.id, { s: "run" } as EdgeResult])));
    setMessage("");
    await run(async () => {
      try {
        const out = await testRoute(client, { host, port: Number(port) }, { hops: plan.hops });
        const next = edgeResults(graph, plan, out.lines);
        setResults(next);
        const bad = plan.edges.find((e) => next[e.id]?.s === "bad");
        setMessage(bad ? `The test stopped at ${nodeById(graph, bad.from)?.name} → ${nodeById(graph, bad.to)?.name}.` : "The test reached the end of the route.");
      } catch (e) {
        setResults(null);
        throw e;
      }
    });
  }

  async function saveAsRoute(nodeId: string) {
    const plan = routeHops(graph, via, nodeId);
    if (plan.reason) return setMessage(plan.reason);
    const owner = graph.nodes.some((n) => n.owner === "shared" && pathTo(graph, via, nodeId).edges.some((e) => e.from === n.id || e.to === n.id));
    await run(async () => {
      const draft = { ...emptyRouteDraft(), name: routeName.trim(), shared: owner, hops: plan.hops.map((hop) => ({ key: hopKey(), hop })) };
      const saved = await saveRoute(client, draft);
      setMessage(`Saved as the route "${saved.name}": ${saved.hops.length} hop${saved.hops.length === 1 ? "" : "s"}.${saved.confirmed ? "" : " A command on it waits for a confirmation."} It appears in Routes.`);
    });
  }

  async function removeNode(n: MapNode) {
    setRemoving(null);
    if (n.scratch) {
      setLocal((l) => ({ ...l, scratch: { targets: l.scratch.targets.filter((t) => t.id !== n.id), edges: l.scratch.edges.filter((e) => e.from !== n.id && e.to !== n.id) } }));
      setSel(null);
      return setMessage("Node and its links removed.");
    }
    await run(async () => {
      if (n.ref?.kind === "sshHost") {
        const host = hosts.find((h) => h.id === (n.ref as { id: string }).id);
        if (host) await deleteHost(client, host);
      } else if (n.ref?.kind === "proxy") {
        const proxy = proxies.find((p) => p.id === (n.ref as { id: string }).id);
        if (proxy) await deleteProxy(client, proxy);
      }
      await reloadLinks(client);
      setSel(null);
      setResults(null);
      setMessage("Node and its links removed.");
    });
  }

  const chooseWayIn = useCallback((nodeId: string, edgeId: string) => {
    setLocal((l) => ({ ...l, via: { ...l.via, [nodeId]: edgeId } }));
    setResults(null);
  }, []);

  // ---- the panel ------------------------------------------------------------------------------------------------

  const panel = (() => {
    if (selected) {
      const path = pathTo(graph, via, selected.id);
      const plan = testPlan(graph, via, selected.id);
      const blocked = selected.id === SERVER_ID ? null : "reason" in plan ? plan.reason : null;
      const profile = selected.profileId ? profiles.find((p) => p.id === selected.profileId) : undefined;
      return (
        <NodePanel
          graph={graph}
          node={selected}
          incoming={graph.edges.filter((e) => e.to === selected.id)}
          via={via[selected.id]}
          path={path}
          results={results}
          busy={busy}
          testBlocked={blocked}
          routeName={routeName}
          onRouteName={setRouteName}
          onChooseWayIn={(e) => chooseWayIn(selected.id, e)}
          onTest={() => void runTest(plan)}
          onSaveRoute={() => void saveAsRoute(selected.id)}
          onLinkTo={(to) => void link(selected.id, to)}
          onEdit={
            selected.ref?.kind === "sshHost"
              ? () => setEditingHost(hosts.find((h) => h.id === (selected.ref as { id: string }).id) ?? null)
              : undefined
          }
          onRemove={selected.id === SERVER_ID || selected.profileId ? undefined : () => setRemoving(selected)}
          onOpenProfile={profile && onOpenProfile ? () => onOpenProfile(profile.id, profile.tool) : undefined}
          onFix={(e) => void fix(e)}
          onSelectEdge={(e) => select({ t: "e", id: e })}
        />
      );
    }
    if (selectedEdge) {
      return (
        <LinkPanel
          graph={graph}
          edge={selectedEdge}
          result={results?.[selectedEdge.id]}
          busy={busy}
          onSave={(d) => void saveEdge(selectedEdge, d)}
          onConfirm={() => selectedEdge.link && void run(async () => void (await confirmLink(client, selectedEdge.link as NonNullable<MapEdge["link"]>)))}
          onTest={() => {
            const to = nodeById(graph, selectedEdge.to);
            const path = pathTo(graph, via, selectedEdge.from);
            if (to) void runTest(planOfEdges(graph, to, selectedEdge.from === SERVER_ID ? [selectedEdge] : [...path.edges, selectedEdge]));
          }}
          onRemove={() => void removeEdge(selectedEdge)}
          onFix={() => void fix(selectedEdge.id)}
        />
      );
    }
    return (
      <div className="flex flex-col gap-stack-sm text-body-1">
        <h3 className="text-subtitle-2">Network map</h3>
        <p className="text-fg-muted">Every machine you reach is a node. A link says how one node opens a stream to the next: an SSH channel, a proxy CONNECT, a command. A route is a path of links from this server.</p>
        <ul className="list-disc ps-inset-lg">
          <li>
            <b>Connect</b> two nodes: drag from the dot on the right of a node to another node, or use Connect to… on the node.
          </li>
          <li>
            <b>Set a method</b> or a command: click a link.
          </li>
          <li>
            <b>See a route</b>: click the node you want to reach.
          </li>
        </ul>
      </div>
    );
  })();

  // ---- the SVG ----------------------------------------------------------------------------------------------------

  const edgeLines = graph.edges.map((e) => {
    const A = nodeById(graph, e.from);
    const B = nodeById(graph, e.to);
    if (!A || !B) return null;
    const a = at(e.from);
    const b = at(e.to);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const clip = (n: MapNode, c: Point, sx: number, sy: number) => {
      const [hw, hh] = halfOf(n);
      const t = Math.min(hw / (Math.abs(sx) || 1e-9), hh / (Math.abs(sy) || 1e-9));
      return { x: c.x + sx * t, y: c.y + sy * t };
    };
    const p1 = clip(A, a, dx, dy);
    const p2 = clip(B, b, -dx, -dy);
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const ux = (p2.x - p1.x) / len;
    const uy = (p2.y - p1.y) / len;
    const q2 = { x: p2.x - ux * 9, y: p2.y - uy * 9 };
    const r = results?.[e.id];
    const alt = via[e.to] !== e.id;
    const isSel = sel?.t === "e" && sel.id === e.id;
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    let label = edgeLabel(graph, e) + (r?.ms !== undefined && r.s === "ok" ? ` · ${r.ms} ms` : "");
    let lw = label.length * 6.1 + 16 + (e.unconfirmed ? 12 : 0);
    if (lw > len - 2) {
      label = r?.ms !== undefined ? `${r.ms} ms` : cut(label, Math.max(4, Math.floor((len - 36) / 6.1)));
      lw = label.length * 6.1 + 16 + (e.unconfirmed ? 12 : 0);
    }
    const arrow = `${p2.x},${p2.y} ${p2.x - ux * 9 - uy * 4.5},${p2.y - uy * 9 + ux * 4.5} ${p2.x - ux * 9 + uy * 4.5},${p2.y - uy * 9 - ux * 4.5}`;
    const stroke = r?.s === "bad" ? "stroke-danger-fg" : r?.s === "ok" ? "stroke-success-fg" : isSel || pathEdges.has(e.id) ? "stroke-accent-compound" : "stroke-border-strong";
    const fill = r?.s === "bad" ? "fill-danger-fg" : r?.s === "ok" ? "fill-success-fg" : isSel || pathEdges.has(e.id) ? "fill-accent-compound" : "fill-border-strong";
    return (
      <g
        key={e.id}
        data-e={e.id}
        data-state={r?.s}
        data-path={pathEdges.has(e.id) || undefined}
        role="button"
        tabIndex={0}
        aria-label={`Link ${A.name} to ${B.name}, ${edgeLabel(graph, e)}${e.unconfirmed ? ", not confirmed" : ""}`}
        className="cursor-pointer outline-none [&:focus-visible_.ln]:stroke-accent-compound"
      >
        <line x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y} strokeWidth={14} className="stroke-transparent" />
        <line x1={p1.x} y1={p1.y} x2={q2.x} y2={q2.y} strokeWidth={isSel || pathEdges.has(e.id) ? 2.5 : 1.5} strokeDasharray={alt && !isSel ? "5 4" : undefined} className={`ln ${stroke}`} />
        <polygon points={arrow} className={fill} />
        <rect x={mx - lw / 2} y={my - 10} width={lw} height={20} rx={10} className="fill-layer stroke-border" />
        <text x={mx + (e.unconfirmed ? 6 : 0)} y={my + 4} textAnchor="middle" className="fill-fg-muted text-caption-2">
          {label}
        </text>
        {e.unconfirmed ? <circle cx={mx - lw / 2 + 11} cy={my} r={3.5} className="fill-warning-fg" /> : null}
      </g>
    );
  });

  const nodeBoxes = graph.nodes.map((n) => {
    const [hw, hh] = halfOf(n);
    const c = at(n.id);
    const r = n.id === SERVER_ID ? undefined : results?.[via[n.id] ?? ""];
    const isSel = sel?.t === "n" && sel.id === n.id;
    const cand = conn ? candidate(n.id) : false;
    const dim = conn && !cand && n.id !== conn.from;
    const stroke = r?.s === "bad" ? "stroke-danger-fg" : r?.s === "ok" ? "stroke-success-fg" : cand ? "stroke-accent-compound" : isSel || pathNodes.has(n.id) ? "stroke-accent-compound" : "stroke-border-strong";
    return (
      <g
        key={n.id}
        data-n={n.id}
        data-state={r?.s}
        data-candidate={cand || undefined}
        role="button"
        tabIndex={0}
        aria-label={`${n.name}, ${NODE_KIND_LABELS[n.kind]}`}
        transform={`translate(${c.x - hw} ${c.y - hh})`}
        opacity={dim ? 0.45 : 1}
        className="cursor-grab outline-none [&:focus-visible>rect]:stroke-accent-compound"
      >
        <rect width={hw * 2} height={hh * 2} rx={9} strokeWidth={isSel || cand || hover === n.id ? 2.5 : 1.5} strokeDasharray={n.scratch ? "4 3" : undefined} className={`${NODE_CLASS[n.kind]} ${stroke}`} />
        <text x={10} y={19} className="fill-fg text-caption-1-strong">
          {cut(n.name, 16)}
        </text>
        <text x={10} y={37} className="fill-fg-muted font-mono text-caption-2">
          {cut(n.kind === "server" ? "Mightyconsole" : n.address, 23)}
        </text>
        {n.kind !== "target" ? <circle data-hd={n.id} cx={hw * 2} cy={hh} r={6.5} className="cursor-crosshair fill-accent-compound stroke-layer" strokeWidth={2} /> : null}
      </g>
    );
  });

  const onlyServer = graph.nodes.length === 1;

  return (
    <div className="@container flex min-w-0 flex-col gap-stack-sm" data-testid="network-map">
      <div className="flex flex-wrap items-center gap-inline-sm">
        <div className="min-w-0 flex-1 basis-panel-xs">
          <h3 className="text-subtitle-2">Network map</h3>
          <p className="text-caption-1 text-fg-muted">
            {graph.nodes.length} nodes · {graph.edges.length} links · machines are nodes, the way one reaches the next is the link
          </p>
        </div>
        <span className="text-caption-1 text-fg-muted">Add</span>
        <Button size="small" onClick={() => setAdding("host")}>
          <Icon icon={Add} size="sm" />
          SSH host
        </Button>
        <Button size="small" onClick={() => setAdding("proxy")}>
          <Icon icon={Add} size="sm" />
          Proxy
        </Button>
        <Button size="small" onClick={() => setAdding("target")}>
          <Icon icon={Add} size="sm" />
          Target
        </Button>
      </div>
      <div role="status" className="flex min-h-control-md items-center gap-inline-sm text-body-1">
        {conn ? (
          <>
            <Icon icon={ArrowRight} size="sm" />
            <span>
              Release on a highlighted node to link {nodeById(graph, conn.from)?.name} to it with {nodeById(graph, conn.from) ? edgeMethodName(nodeById(graph, conn.from) as MapNode) : ""}.
            </span>
          </>
        ) : message ? (
          <>
            <Icon icon={Info} size="sm" />
            <span>{message}</span>
          </>
        ) : (
          <span className="text-fg-muted">Drag from the dot on a node to another node to link them. Click a link to set its method.</span>
        )}
      </div>
      {error ? <ErrorState error={error} /> : null}
      <div className="flex min-w-0 flex-col gap-inline-md @5xl:flex-row">
        <div className="relative min-w-0 flex-1 overflow-x-auto rounded-md border border-border-subtle bg-layer-alt">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${width} ${MAP_H}`}
            role="group"
            aria-label="Network map: machines as nodes, links between them"
            className="block h-auto w-full touch-none select-none"
            style={{ minWidth: Math.round(width * 0.8) }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            <g>{edgeLines}</g>
            {conn ? <line x1={at(conn.from).x} y1={at(conn.from).y} x2={conn.x} y2={conn.y} strokeWidth={2} strokeDasharray="4 3" className="stroke-accent-compound" /> : null}
            <g>{nodeBoxes}</g>
          </svg>
          {onlyServer ? <p className="absolute inset-x-inset-md top-1/2 -translate-y-1/2 text-center text-body-1 text-fg-muted">Nothing to connect yet. Add an SSH host, a proxy or a target above, then drag a link from this server to it.</p> : null}
        </div>
        <aside aria-label="Details" className="min-w-0 rounded-md border border-border-subtle p-inset-md @5xl:w-panel-sm @5xl:shrink-0">
          {panel}
        </aside>
      </div>

      <HostEditor
        open={adding === "host" || editingHost !== null}
        onOpenChange={(open) => {
          if (!open) {
            setAdding(null);
            setEditingHost(null);
          }
        }}
        client={client}
        host={editingHost ?? undefined}
        onSaved={(saved) => {
          setAdding(null);
          setEditingHost(null);
          setSel({ t: "n", id: `host:${saved.host.id}` });
          setMessage("Node added. Drag a link to it.");
        }}
      />
      <Dialog open={adding === "proxy"} onOpenChange={(open) => !open && setAdding(null)} size="lg">
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New proxy</DialogTitle>
            <DialogDescription>A proxy is a node: a link from this server reaches it, and it opens the next stream with a CONNECT request.</DialogDescription>
          </DialogHeader>
          <DialogBody className="flex flex-col gap-stack-sm">
            <Field>
              <FieldLabel>Kind</FieldLabel>
              <Select<ProxyKind> aria-label="Proxy kind" value={proxyKind} onValueChange={(v) => v && setProxyKind(v)}>
                <SelectItem value="socks5">SOCKS5</SelectItem>
                <SelectItem value="httpConnect">HTTP CONNECT</SelectItem>
              </Select>
            </Field>
            <ProxyForm
              key={proxyKind}
              client={client}
              kind={proxyKind}
              shared={false}
              onSaved={(p) => {
                setAdding(null);
                setSel({ t: "n", id: `proxy:${p.id}` });
                setMessage("Node added. Drag a link to it.");
              }}
              onCancel={() => setAdding(null)}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
      <ScratchTargetDialog
        open={adding === "target"}
        onClose={() => setAdding(null)}
        onAdd={(name, address) => {
          const id = `scratch:${Date.now().toString(36)}`;
          setLocal((l) => ({ ...l, scratch: { ...l.scratch, targets: [...l.scratch.targets, { id, name, address }] } }));
          setAdding(null);
          setSel({ t: "n", id });
          setMessage("Target added. It is kept in this browser: link a path to it to test it or save it as a route.");
        }}
      />
      <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {removing?.scratch
                ? "The target and the links drawn to it are forgotten."
                : `The ${removing ? NODE_KIND_LABELS[removing.kind].toLowerCase() : "node"} and the links drawn to and from it are deleted, with its stored secrets. A node a route or a profile uses is refused, and the refusal lists them.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody />
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <Button appearance="primary" onClick={() => removing && void removeNode(removing)}>
              Remove {removing?.name}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function edgeMethodName(n: MapNode): string {
  const m = methodsOf(n)[0];
  return m === "tcp" ? "Direct TCP" : m === "ssh" ? "an SSH channel" : m === "connect" ? "a CONNECT request" : "a link";
}

function ScratchTargetDialog({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (name: string, address: string) => void }) {
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [problem, setProblem] = useState("");
  useEffect(() => {
    if (open) {
      setName("");
      setAddress("");
      setProblem("");
    }
  }, [open]);
  const add = () => {
    if (name.trim() === "") return setProblem("A name is required.");
    if (!/^[^\s/@]+:\d{1,5}$/.test(address.trim())) return setProblem("An address as host:port, such as service.internal:443.");
    onAdd(name.trim(), address.trim());
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a target</DialogTitle>
          <DialogDescription>A place to test a path to, and to save a route from. Profiles' own targets are drawn from their routes. This one stays in this browser.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-sm">
          <Field>
            <FieldLabel>Name</FieldLabel>
            <Input value={name} onValueChange={setName} placeholder="staging-nats" autoComplete="off" />
          </Field>
          <Field invalid={problem !== ""}>
            <FieldLabel>Address</FieldLabel>
            <Input value={address} onValueChange={setAddress} placeholder="service.internal:443" autoComplete="off" spellCheck={false} />
            {problem ? <FieldError match>{problem}</FieldError> : null}
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button appearance="primary" onClick={add}>
            Add target
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
