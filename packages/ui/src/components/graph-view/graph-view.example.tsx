import { useState } from "react";
import { GraphView, type GraphViewEdge, type GraphViewGroup, type GraphViewNode } from "@/components/graph-view/graph-view";

const PIPELINE_NODES: GraphViewNode[] = [
  { id: "extract", label: "extract" },
  { id: "transform", label: "transform" },
  { id: "load", label: "load" },
];
const PIPELINE_EDGES: GraphViewEdge[] = [
  { source: "extract", target: "transform" },
  { source: "transform", target: "load" },
];

/** The smallest useful GraphView: three steps in a row. */
export function GraphViewMinimal() {
  return <GraphView aria-label="Pipeline" nodes={PIPELINE_NODES} edges={PIPELINE_EDGES} direction="LR" className="h-panel-xs" />;
}

// A LangGraph agent drawn with xray: a conditional edge, a loop back from the tool node, a
// subgraph's nodes in their group; a run is on "approve" after plan and tools.
const AGENT_NODES: GraphViewNode[] = [
  { id: "__start__", label: "start", kind: "start" },
  { id: "plan", label: "plan" },
  { id: "tools", label: "tools" },
  { id: "approve", label: "approve" },
  { id: "summarize:remember", label: "remember", group: "summarize" },
  { id: "summarize:format", label: "format", group: "summarize" },
  { id: "__end__", label: "end", kind: "end" },
];
const AGENT_EDGES: GraphViewEdge[] = [
  { source: "__start__", target: "plan" },
  { source: "plan", target: "tools", conditional: true, label: "tools" },
  { source: "plan", target: "approve", conditional: true },
  { source: "tools", target: "plan" },
  { source: "approve", target: "summarize:remember" },
  { source: "summarize:remember", target: "summarize:format" },
  { source: "summarize:format", target: "__end__" },
];
const AGENT_GROUPS: GraphViewGroup[] = [{ id: "summarize", label: "summarize" }];

/** An assistant's graph during a run: visited nodes, the running one, a selected node. */
export function GraphViewRealistic() {
  const [selected, setSelected] = useState<string | null>("tools");
  return (
    <div className="flex flex-col gap-stack-sm">
      <GraphView
        aria-label="Graph of the agent assistant"
        nodes={AGENT_NODES}
        edges={AGENT_EDGES}
        groups={AGENT_GROUPS}
        visitedIds={["__start__", "plan", "tools"]}
        activeIds={["approve"]}
        selectedId={selected}
        onNodeSelect={setSelected}
        className="h-panel-md"
      />
      <p className="text-caption-1 text-fg-muted">Selected: {selected ?? "none"}</p>
    </div>
  );
}
