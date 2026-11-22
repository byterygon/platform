// An assistant's Graph (DOC-21 §11.2.1, the TSK-91 mockup's langgraph-assistant-graph, TSK-96):
// the GraphView with xray at a depth, and the selected node's pane: its edges in and out (with
// their branch), its metadata, and its statistics over the assistant's last runs
// (`langgraph.assistants.nodeStats`, Open question 45 (n)) with the threads that passed through it.
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { GraphView } from "@/components/ui/graph-view";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Select, SelectItem } from "@/components/ui/select";
import { LinkButton, PageBar } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import type { LinkEvent } from "../types";
import { formatDuration } from "./state-diff";
import { preview, shortId, toGraphView, type useLoad } from "./shared";

/** The xray choices: off, a depth, or every level. */
export type XrayChoice = "off" | "1" | "2" | "all";
const DEPTHS = { "1": "Depth: 1", "2": "Depth: 2", all: "Depth: all" } as const;

/** What the server's `xray` takes for a choice. */
export function xrayOf(choice: XrayChoice): api.Xray {
  return choice === "off" ? false : choice === "all" ? true : Number(choice);
}

export interface GraphPanelProps {
  name: string;
  graph: ReturnType<typeof useLoad<api.AssistantGraph>>;
  stats: ReturnType<typeof useLoad<api.NodeStats>>;
  xray: XrayChoice;
  onXray: (choice: XrayChoice) => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Opens a thread that passed through the node. */
  onThread: (threadId: string, event?: LinkEvent) => void;
}

export function GraphPanel({ name, graph, stats, xray, onXray, selected, onSelect, onThread }: GraphPanelProps) {
  const view = useMemo(() => (graph.data ? toGraphView(graph.data) : null), [graph.data]);
  const node = graph.data?.nodes.find((n) => n.id === selected) ?? null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="Graph options" className="pb-stack-sm">
        <label className="flex items-center gap-inline-sm text-body-1 text-fg">
          <Checkbox checked={xray !== "off"} onCheckedChange={(on) => onXray(on ? "1" : "off")} />
          Show subgraphs (xray)
        </label>
        <Select aria-label="Xray depth" value={xray === "off" ? "1" : xray} onValueChange={(v) => onXray(v as XrayChoice)} items={DEPTHS} disabled={xray === "off"}>
          {Object.entries(DEPTHS).map(([id, label]) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </Select>
        <span className="flex-1" />
        <span className="text-caption-1 text-fg-muted">— edge · - - conditional</span>
      </PageBar>
      <Resizable orientation="horizontal" className="min-h-0 flex-1 border-t border-border-subtle">
        <ResizablePanel defaultSize={70} minSize={40}>
          <div className="flex h-full min-h-0 flex-col px-inset-lg py-inset-md">
            {graph.error ? <ErrorState error={graph.error} onRetry={() => void graph.reload()} onRefresh={() => void graph.reload()} /> : null}
            {graph.loading && !view ? <LoadingRows label="Loading the graph" /> : null}
            {view && view.nodes.length === 0 ? <EmptyLine>The server returned a graph with no nodes.</EmptyLine> : null}
            {view && view.nodes.length > 0 ? <GraphView aria-label={`Graph of ${name}`} nodes={view.nodes} edges={view.edges} groups={view.groups} selectedId={selected} onNodeSelect={(id) => onSelect(id === selected ? null : id)} className="min-h-0 flex-1" /> : null}
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={22}>
          <div className="h-full overflow-auto px-inset-lg py-inset-md">{node && graph.data ? <NodePane node={node} graph={graph.data} stats={stats} onThread={onThread} /> : <p className="text-body-1 text-fg-muted">Select a node to see its edges and how it ran in the last runs.</p>}</div>
        </ResizablePanel>
      </Resizable>
    </div>
  );
}

/** "classify when intent in (billing, account)". */
function edgeText(e: api.GraphEdge, end: string): string {
  return e.label ? `${end} when ${e.label}` : e.conditional ? `${end} (conditional)` : end;
}

function NodePane({ node, graph, stats, onThread }: { node: api.GraphNode; graph: api.AssistantGraph; stats: GraphPanelProps["stats"]; onThread: GraphPanelProps["onThread"] }) {
  const inside = graph.nodes.filter((n) => n.id.startsWith(`${node.id}:`)).map((n) => n.id.slice(node.id.length + 1));
  const from = graph.edges.filter((e) => e.target === node.id);
  const to = graph.edges.filter((e) => e.source === node.id);
  // Statistics are kept by the node's own name (a subgraph's inner nodes run in its own checkpoints).
  const stat = stats.data?.nodes.find((s) => s.node === node.id || s.node === node.name) ?? null;
  const metadata = node.metadata && typeof node.metadata === "object" && Object.keys(node.metadata).length > 0 ? node.metadata : null;
  return (
    <section aria-label={`Node ${node.name}`} className="flex flex-col gap-stack-md">
      <div className="flex flex-col gap-stack-xs">
        <h3 className="flex items-center gap-inline-sm text-body-1-strong text-fg">
          {node.name}
          {inside.length > 0 ? (
            <Badge appearance="tint" variant="info">
              subgraph
            </Badge>
          ) : null}
        </h3>
        {inside.length > 0 ? (
          <p className="text-body-1 text-fg-muted">
            {inside.length} node{inside.length === 1 ? "" : "s"} inside: {inside.join(", ")}
          </p>
        ) : null}
      </div>
      <DescriptionList>
        <DescriptionListItem>
          <DescriptionListTerm>From</DescriptionListTerm>
          <DescriptionListDetails>{from.length > 0 ? from.map((e) => edgeText(e, e.source)).join("; ") : "—"}</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>To</DescriptionListTerm>
          <DescriptionListDetails>{to.length > 0 ? to.map((e) => edgeText(e, e.target)).join("; ") : "—"}</DescriptionListDetails>
        </DescriptionListItem>
        {metadata ? (
          <DescriptionListItem>
            <DescriptionListTerm>Metadata</DescriptionListTerm>
            <DescriptionListDetails className="font-mono text-code">{preview(metadata, 200)}</DescriptionListDetails>
          </DescriptionListItem>
        ) : null}
      </DescriptionList>
      {node.kind === "node" ? <NodeStatsSection stat={stat} stats={stats} onThread={onThread} /> : null}
    </section>
  );
}

/** "In the last 50 runs": visits, times, errors and the threads, or why there are none. */
function NodeStatsSection({ stat, stats, onThread }: { stat: api.NodeStat | null; stats: GraphPanelProps["stats"]; onThread: GraphPanelProps["onThread"] }) {
  const data = stats.data;
  const heading = data ? (data.runs === 0 ? "In the last runs" : `In the last ${data.runs} run${data.runs === 1 ? "" : "s"}`) : "In the last runs";
  return (
    <section aria-label={heading} className="flex flex-col gap-stack-sm">
      <h4 className="text-body-1-strong text-fg">{heading}</h4>
      {stats.error ? <ErrorState error={stats.error} onRetry={() => void stats.reload()} /> : null}
      {stats.loading && !data ? <LoadingRows label="Reading the last runs" /> : null}
      {data && data.runs === 0 ? <p className="text-body-1 text-fg-muted">No runs of this assistant on its threads yet.{data.reason ? ` ${data.reason}.` : ""}</p> : null}
      {data && data.runs > 0 && data.runs < 50 ? <p className="text-caption-1 text-fg-muted">Only {data.runs} run{data.runs === 1 ? "" : "s"} of this assistant exist on {data.threads} thread{data.threads === 1 ? "" : "s"}.</p> : null}
      {data?.partial && data.runs > 0 ? <p className="text-caption-1 text-warning-fg">Partial: {data.reason}.</p> : null}
      {data && data.runs > 0 ? (
        stat ? (
          <>
            <DescriptionList>
              <DescriptionListItem>
                <DescriptionListTerm>Visited</DescriptionListTerm>
                <DescriptionListDetails>
                  {stat.runs} run{stat.runs === 1 ? "" : "s"}
                  {stat.visits !== stat.runs ? ` (${stat.visits} steps)` : ""}
                </DescriptionListDetails>
              </DescriptionListItem>
              <DescriptionListItem>
                <DescriptionListTerm>Median time</DescriptionListTerm>
                <DescriptionListDetails>{formatDuration(stat.medianMs ?? null)}</DescriptionListDetails>
              </DescriptionListItem>
              <DescriptionListItem>
                <DescriptionListTerm>95th percentile</DescriptionListTerm>
                <DescriptionListDetails>{formatDuration(stat.p95Ms ?? null)}</DescriptionListDetails>
              </DescriptionListItem>
              <DescriptionListItem>
                <DescriptionListTerm>Errors</DescriptionListTerm>
                <DescriptionListDetails>{stat.errors}</DescriptionListDetails>
              </DescriptionListItem>
            </DescriptionList>
            {stat.threadIds.length > 0 ? (
              <div className="flex flex-col gap-stack-xs">
                <span className="text-caption-1 text-fg-muted">Threads that passed here</span>
                <ul className="flex flex-col gap-stack-xs">
                  {stat.threadIds.map((t) => (
                    <li key={t}>
                      <LinkButton className="font-mono text-code" onOpen={(e) => onThread(t, e)} title={t}>
                        {shortId(t)}
                      </LinkButton>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <p className="text-body-1 text-fg-muted">This node did not run in these runs.</p>
        )
      ) : null}
    </section>
  );
}
