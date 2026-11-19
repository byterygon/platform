import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { GEOMETRY, GraphView, type GraphViewEdge, type GraphViewNode, edgePath, layoutGraph, nodeSize } from "./graph-view";

afterEach(cleanup);

const NODES: GraphViewNode[] = [
  { id: "__start__", label: "start", kind: "start" },
  { id: "plan", label: "plan" },
  { id: "tools", label: "tools" },
  { id: "approve", label: "approve" },
  { id: "sub:a", label: "a", group: "sub" },
  { id: "__end__", label: "end", kind: "end" },
];
const EDGES: GraphViewEdge[] = [
  { source: "__start__", target: "plan" },
  { source: "plan", target: "tools", conditional: true },
  { source: "plan", target: "approve", conditional: true, label: "done" },
  { source: "tools", target: "plan" },
  { source: "approve", target: "sub:a" },
  { source: "sub:a", target: "__end__" },
  { source: "plan", target: "nowhere" },
];

const nodeEl = (c: HTMLElement, id: string) => c.querySelector<HTMLButtonElement>(`[data-graph-node="${id}"]`)!;
const keydown = (el: Element, key: string) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));

describe("layout", () => {
  test("layers follow the edges, top to bottom or left to right", () => {
    const tb = layoutGraph(NODES, EDGES, [{ id: "sub", label: "sub" }], "TB");
    const y = (id: string) => tb.nodes.find((n) => n.node.id === id)!.y;
    expect(y("__start__")).toBeLessThan(y("plan"));
    expect(y("plan")).toBeLessThan(y("approve"));
    expect(y("approve")).toBeLessThan(y("sub:a"));
    expect(tb.order[0]).toBe("__start__");
    expect(tb.order.at(-1)).toBe("__end__");
    // An edge to an unknown node is left out; a labelled edge gets a label box.
    expect(tb.edges).toHaveLength(6);
    expect(tb.edges.find((e) => e.edge.label === "done")!.label).toBeDefined();
    // The group surrounds its node.
    const group = tb.groups[0]!;
    const a = tb.nodes.find((n) => n.node.id === "sub:a")!;
    expect(group.x).toBeLessThanOrEqual(a.x);
    expect(group.y + group.height).toBeGreaterThanOrEqual(a.y + a.height);
    const lr = layoutGraph(NODES, EDGES, [], "LR");
    const x = (id: string) => lr.nodes.find((n) => n.node.id === id)!.x;
    expect(x("__start__")).toBeLessThan(x("plan"));
    expect(lr.groups).toEqual([]);
  });

  test("node sizes come from the label, pills for start and end", () => {
    expect(nodeSize({ id: "a", label: "a" }).width).toBe(GEOMETRY.minWidth);
    expect(nodeSize({ id: "a", label: "x".repeat(200) }).width).toBe(GEOMETRY.maxWidth);
    expect(nodeSize({ id: "s", label: "start", kind: "start" }).height).toBe(GEOMETRY.pillHeight);
  });

  test("edge paths are smooth curves through the points", () => {
    expect(edgePath([])).toBe("");
    expect(edgePath([{ x: 0, y: 0 }, { x: 0, y: 10 }])).toBe("M0,0 L0,10");
    expect(edgePath([{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 20 }])).toBe("M0,0 Q0,10 5,15 L10,20");
  });
});

describe("GraphView", () => {
  test("draws the nodes, the edges and their states", () => {
    const { container } = render(<GraphView nodes={NODES} edges={EDGES} groups={[{ id: "sub", label: "sub" }]} visitedIds={["__start__", "plan"]} activeIds={["tools"]} />);
    expect(container.querySelectorAll('[data-slot="graph-view-node"]')).toHaveLength(6);
    expect(container.querySelectorAll('[data-slot="graph-view-edge"]')).toHaveLength(6);
    expect(container.querySelectorAll('[data-slot="graph-view-edge"][data-conditional]')).toHaveLength(2);
    expect(container.querySelector('[data-slot="graph-view-group"]')!.textContent).toBe("sub");
    expect(nodeEl(container, "tools").dataset.active).toBe("");
    expect(nodeEl(container, "tools").getAttribute("aria-label")).toBe("tools, running");
    expect(nodeEl(container, "plan").dataset.visited).toBe("");
    expect(nodeEl(container, "__start__").dataset.kind).toBe("start");
    // The edge into the running node is highlighted.
    expect(container.querySelectorAll("path[data-active]")).toHaveLength(1);
    expect(container.querySelectorAll("path[data-visited]")).toHaveLength(1);
    // Screen readers get the edges as a list.
    expect(container.querySelector("ul")!.textContent).toContain("plan to approve (conditional): done");
  });

  test("a detail line with a status dot, an emphasised node, dashed edges and double-click", () => {
    const onNodeOpen = vi.fn();
    const nodes: GraphViewNode[] = [
      { id: "root", label: "checkout-9912", detail: "Running · CheckoutWorkflow", tone: "info" },
      { id: "cur", label: "order-48213", detail: "Running · OrderWorkflow", tone: "info", emphasis: true },
      { id: "kid", label: "receipt-48213", detail: "Failed · ReceiptWorkflow", tone: "danger" },
      { id: "plain", label: "support-ticket-771" },
    ];
    const edges: GraphViewEdge[] = [
      { source: "root", target: "cur" },
      { source: "cur", target: "kid" },
      { source: "plain", target: "cur", dashed: true, label: "customerConfirmed" },
    ];
    const { container } = render(<GraphView nodes={nodes} edges={edges} direction="LR" onNodeOpen={onNodeOpen} />);
    const kid = nodeEl(container, "kid");
    expect(kid.dataset.detail).toBe("");
    expect(kid.textContent).toBe("receipt-48213Failed · ReceiptWorkflow");
    expect(kid.getAttribute("aria-label")).toBe("receipt-48213, Failed · ReceiptWorkflow");
    expect(kid.querySelector<HTMLElement>('[data-slot="graph-view-dot"]')!.dataset.tone).toBe("danger");
    expect(nodeEl(container, "cur").dataset.emphasis).toBe("");
    expect(nodeEl(container, "cur").getAttribute("aria-label")).not.toContain("done");
    expect(nodeEl(container, "plain").dataset.detail).toBeUndefined();
    expect(nodeSize(nodes[0]!).height).toBe(GEOMETRY.detailHeight);
    const dashed = container.querySelector('[data-slot="graph-view-edge"][data-dashed]')!;
    expect(dashed.querySelector("path")!.getAttribute("stroke-dasharray")).toBe("6 4");
    expect(container.querySelector("ul")!.textContent).toContain("support-ticket-771 to order-48213: customerConfirmed");
    expect(container.querySelector("ul")!.textContent).not.toContain("conditional");
    act(() => void kid.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(onNodeOpen).toHaveBeenCalledWith("kid");
  });

  test("one tab stop; arrows follow the edges and the ranks; Enter selects", () => {
    const onNodeSelect = vi.fn();
    const { container } = render(<GraphView nodes={NODES} edges={EDGES} onNodeSelect={onNodeSelect} selectedId="plan" />);
    const tabbable = [...container.querySelectorAll<HTMLElement>('[data-slot="graph-view-node"]')].filter((n) => n.tabIndex === 0);
    expect(tabbable.map((n) => n.dataset.graphNode)).toEqual(["plan"]);
    expect(nodeEl(container, "plan").getAttribute("aria-pressed")).toBe("true");
    nodeEl(container, "plan").focus();
    keydown(nodeEl(container, "plan"), "ArrowDown");
    const next = document.activeElement as HTMLElement;
    expect(["tools", "approve"]).toContain(next.dataset.graphNode);
    expect(next.tabIndex).toBe(0);
    keydown(next, "ArrowUp");
    expect((document.activeElement as HTMLElement).dataset.graphNode).toBe("plan");
    keydown(document.activeElement!, "ArrowDown");
    const first = (document.activeElement as HTMLElement).dataset.graphNode;
    keydown(document.activeElement!, "ArrowRight");
    const sibling = (document.activeElement as HTMLElement).dataset.graphNode;
    expect(sibling).not.toBe(first);
    expect(["tools", "approve"]).toContain(sibling);
    keydown(document.activeElement!, "End");
    expect((document.activeElement as HTMLElement).dataset.graphNode).toBe("__end__");
    keydown(document.activeElement!, "Home");
    expect((document.activeElement as HTMLElement).dataset.graphNode).toBe("__start__");
    act(() => nodeEl(container, "tools").click());
    expect(onNodeSelect).toHaveBeenCalledWith("tools");
  });

  test("zoom buttons and keys scale the canvas; Fit restores it", () => {
    const { container } = render(<GraphView nodes={NODES} edges={EDGES} />);
    const canvas = container.querySelector<HTMLElement>('[data-slot="graph-view-canvas"]')!;
    const scale = () => Number(/scale\(([\d.]+)\)/.exec(canvas.style.transform)![1]);
    expect(scale()).toBe(1);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
    expect(scale()).toBeCloseTo(1.2);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
    expect(scale()).toBeCloseTo(1 / 1.2);
    keydown(nodeEl(container, "plan"), "+");
    expect(scale()).toBeCloseTo(1);
    keydown(nodeEl(container, "plan"), "+");
    keydown(nodeEl(container, "plan"), "0");
    expect(scale()).toBe(1);
    for (let i = 0; i < 20; i++) keydown(nodeEl(container, "plan"), "+");
    expect(scale()).toBe(GEOMETRY.maxZoom);
  });

  test("dragging the background pans", () => {
    const { container } = render(<GraphView nodes={NODES} edges={EDGES} />);
    const viewport = container.querySelector<HTMLElement>('[data-slot="graph-view-viewport"]')!;
    const canvas = container.querySelector<HTMLElement>('[data-slot="graph-view-canvas"]')!;
    const pointer = (type: string, x: number, y: number) => act(() => void viewport.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, pointerId: 1 })));
    pointer("pointerdown", 10, 10);
    expect(viewport.dataset.panning).toBe("");
    pointer("pointermove", 40, 30);
    pointer("pointerup", 40, 30);
    expect(viewport.dataset.panning).toBeUndefined();
    expect(canvas.style.transform).toContain("translate(30px, 20px)");
  });

  test("an empty graph says so", () => {
    const { container } = render(<GraphView nodes={[]} edges={[]} />);
    expect(container.textContent).toBe("No nodes to draw.");
  });

  test("forwards the ref to the root", () => {
    const ref = createRef<HTMLDivElement>();
    render(<GraphView ref={ref} nodes={NODES} edges={EDGES} />);
    expect(ref.current?.dataset.slot).toBe("graph-view");
  });

  test("has no axe violations", async () => {
    const { container } = render(<GraphView aria-label="Agent" nodes={NODES} edges={EDGES} activeIds={["plan"]} onNodeSelect={() => {}} />);
    expect(await axeViolations(container)).toEqual([]);
  });
});
