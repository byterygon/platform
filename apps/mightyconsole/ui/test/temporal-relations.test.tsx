// A workflow's Relations view (DOC-21 §9.3, TSK-104) against a stub client: the family drawn as a
// graph with the current workflow emphasised and the signal dashed, the side's lists, the scope
// switch, the signals checkbox, opening a workflow and listing the family in Workflows.
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { RelationNode, WorkflowRelations } from "@/gen/api";
import { RelationsPanel, graphOf, summaryOf } from "@/tools/temporal/RelationsPanel";
import { axeViolations, byRole, byText, cleanup, click, render, waitFor } from "./support/render";

afterEach(cleanup);

const node = (workflowId: string, workflowType: string, status: RelationNode["status"], level: number | undefined, patch: Partial<RelationNode> = {}): RelationNode => ({
  workflowId,
  runId: `run-${workflowId}`,
  workflowType,
  status,
  startTime: "2026-11-19T10:00:00Z",
  ...(level === undefined ? {} : { level }),
  missing: false,
  current: false,
  ...patch,
});

const FAMILY: WorkflowRelations = {
  workflow: { workflowId: "family-order", runId: "run-family-order", workflowType: "Order", status: "Running", taskQueue: "lab", historyLength: 30, parentWorkflowId: "family-root" },
  rootWorkflowId: "family-root",
  nodes: [
    node("family-root", "Checkout", "Running", 0),
    node("family-order", "Order", "Running", 1, { parentWorkflowId: "family-root", current: true }),
    node("family-order-fraud", "FraudCheck", "Completed", 2, { parentWorkflowId: "family-order", durationMs: 800 }),
    node("family-order-payment", "Payment", "Running", 2, { parentWorkflowId: "family-order" }),
    node("family-order-receipt", "Receipt", "Failed", 2, { parentWorkflowId: "family-order", failure: "SmtpUnavailable" }),
    node("family-support", "SupportTicket", "Running", undefined),
  ],
  edges: [
    { from: "family-root", to: "family-order", kind: "child" },
    { from: "family-order", to: "family-order-fraud", kind: "child" },
    { from: "family-order", to: "family-order-payment", kind: "child" },
    { from: "family-order", to: "family-order-receipt", kind: "child" },
    { from: "family-support", to: "family-order", kind: "signal", label: "customerConfirmed", eventId: 13 },
  ],
  parent: { workflowId: "family-root", runId: "run-family-root", parentClosePolicy: "Terminate" },
  children: [
    { workflowId: "family-order-fraud", runId: "run-family-order-fraud", workflowType: "FraudCheck", status: "Completed", initiatedEventId: 5 },
    { workflowId: "family-order-payment", runId: "run-family-order-payment", workflowType: "Payment", status: "Running", initiatedEventId: 6, startTime: "2026-11-19T10:00:00Z" },
    { workflowId: "family-order-receipt", runId: "run-family-order-receipt", workflowType: "Receipt", status: "Failed", initiatedEventId: 7, failure: "SmtpUnavailable" },
  ],
  signals: [{ direction: "received", kind: "signal", workflowId: "family-support", runId: "run-family-support", signalName: "customerConfirmed", eventId: 13 }],
  runs: {},
  family: { scope: "family", supported: true, query: 'RootWorkflowId = "family-root"', total: 6, drawn: 5, levels: 3, notDrawn: 0 },
};

const DIRECT: WorkflowRelations = { ...FAMILY, family: { ...FAMILY.family, scope: "direct", query: 'ParentWorkflowId = "family-order"' } };

function setup(answer: (scope: string) => WorkflowRelations = (s) => (s === "direct" ? DIRECT : FAMILY)) {
  const relations = vi.fn(async (input: { scope?: string | null }) => answer(input.scope ?? "family"));
  const client = { temporal: { workflows: { relations } } } as unknown as MightyClient;
  const onOpenWorkflow = vi.fn();
  const onListWorkflows = vi.fn();
  const view = render(
    <RelationsPanel client={client} connId="conn-1" namespace="lab" workflowId="family-order" runId="run-family-order" active version={30} now={Date.parse("2026-11-19T10:12:00Z")} note={describeError} onOpenWorkflow={onOpenWorkflow} onListWorkflows={onListWorkflows} />,
  );
  return { relations, onOpenWorkflow, onListWorkflows, ...view };
}

const nodeEl = (c: HTMLElement, id: string) => c.querySelector<HTMLButtonElement>(`[data-graph-node="${id}"]`);

describe("Relations (DOC-21 §9.3)", () => {
  test("graphOf: two-line boxes, the current one emphasised, signals dashed and left out on request", () => {
    const all = graphOf(FAMILY, true);
    expect(all.nodes).toHaveLength(6);
    expect(all.nodes.find((n) => n.id === "family-order")).toMatchObject({ detail: "Running · Order", tone: "info", emphasis: true });
    expect(all.nodes.find((n) => n.id === "family-order-receipt")).toMatchObject({ detail: "Failed · Receipt", tone: "danger" });
    expect(all.edges.find((e) => e.source === "family-support")).toEqual({ source: "family-support", target: "family-order", dashed: true, label: "customerConfirmed" });
    const tree = graphOf(FAMILY, false);
    expect(tree.nodes.map((n) => n.id)).not.toContain("family-support");
    expect(tree.edges.every((e) => !e.dashed)).toBe(true);
    expect(summaryOf(FAMILY)).toBe("Root family-root · 5 workflows in 3 levels");
    expect(summaryOf(DIRECT)).toBe("1 parent · 3 children");
    expect(summaryOf({ ...FAMILY, family: { ...FAMILY.family, notDrawn: 12 } })).toContain("12 more not drawn");
  });

  test("draws the family and lists the parent, children, signals and runs", async () => {
    const { relations, container } = setup();
    await waitFor(() => nodeEl(container, "family-order-receipt") !== null, "the graph");
    expect(relations).toHaveBeenCalledWith({ connId: "conn-1", namespace: "lab", workflowId: "family-order", runId: "run-family-order", scope: "family" });
    expect(nodeEl(container, "family-order")!.dataset.emphasis).toBe("");
    expect(container.querySelector('[data-slot="graph-view-edge"][data-dashed]')).not.toBeNull();
    expect(byText("Root family-root · 5 workflows in 3 levels")).not.toBeNull();
    const side = document.querySelector<HTMLElement>('aside[aria-label="Related workflows"]')!;
    expect(side.textContent).toContain("if it closes, this is terminated");
    expect(side.textContent).toContain("SmtpUnavailable");
    expect(side.textContent).toContain("800 ms");
    expect(side.textContent).toContain("running for 12m");
    expect(side.textContent).toContain("customerConfirmed · event 13");
    expect(side.textContent).toContain("first run");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a click shows a box on the side; double-click and its links open the workflow", async () => {
    const { container, onOpenWorkflow } = setup();
    await waitFor(() => nodeEl(container, "family-order-receipt") !== null, "the graph");
    await click(nodeEl(container, "family-order-receipt"));
    const picked = document.querySelector<HTMLElement>('section[aria-label="Selected workflow"]')!;
    expect(picked.textContent).toContain("family-order-receipt");
    await click(byRole("button", "Open workflow", picked));
    expect(onOpenWorkflow).toHaveBeenLastCalledWith("family-order-receipt", "run-family-order-receipt");
    nodeEl(container, "family-root")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onOpenWorkflow).toHaveBeenLastCalledWith("family-root", "run-family-root");
    // The current workflow is not opened again.
    onOpenWorkflow.mockClear();
    nodeEl(container, "family-order")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(onOpenWorkflow).not.toHaveBeenCalled();
  });

  test("Direct only asks again; the signals checkbox hides the signal; List them in Workflows opens the query", async () => {
    const { container, relations, onListWorkflows } = setup();
    await waitFor(() => nodeEl(container, "family-support") !== null, "the graph");
    await click(byRole("button", "Direct only"));
    await waitFor(() => relations.mock.calls.some((c) => c[0].scope === "direct") && byText("1 parent · 3 children") !== null, "the direct relations");
    await click(byRole("checkbox"));
    expect(nodeEl(container, "family-support")).toBeNull();
    await click(byRole("button", "List them in Workflows"));
    expect(onListWorkflows).toHaveBeenCalledWith('ParentWorkflowId = "family-order"');
  });

  test("a server without RootWorkflowId: Whole family disabled, the reason said", async () => {
    const old: WorkflowRelations = { ...FAMILY, family: { scope: "direct", supported: false, reason: "invalid search attribute: RootWorkflowId", drawn: 5, levels: 3, notDrawn: 0 } };
    const { container } = setup(() => old);
    await waitFor(() => nodeEl(container, "family-order") !== null, "the graph");
    expect(byRole("button", "Whole family")!.hasAttribute("disabled") || byRole("button", "Whole family")!.getAttribute("aria-disabled") === "true").toBe(true);
    expect(byText(/the server cannot list the whole family \(invalid search attribute: RootWorkflowId\)/)).not.toBeNull();
    expect(byRole("button", "List them in Workflows")!.hasAttribute("disabled")).toBe(true);
  });
});
