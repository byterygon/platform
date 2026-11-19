// Assistants (grouped by graph) and an assistant's Graph, Schemas and Config (spec §11.2).
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { GraphView } from "@/components/ui/graph-view";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { RelativeTime } from "@/components/ui/relative-time";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton, PageHeader, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { useTabView } from "@/app/tab-view";
import { cn } from "@/lib/cn";
import type * as api from "@/gen/api";
import { ArrowClockwise, History } from "@/lib/icons";
import type { TabProps } from "../types";
import { shortId, toGraphView, useLoad } from "./shared";

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Every assistant, grouped by graph id; a row opens the assistant. */
export function AssistantsTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
  const { data, error, loading, reload } = useLoad(connId ? () => client.langgraph.assistants.search({ connId, graphId: null, metadata: null, limit: 1000, offset: null }) : null, [connId], note);
  useTabActions({ refresh: () => void reload() });
  const groups = useMemo(() => {
    const byGraph = new Map<string, api.Assistant[]>();
    for (const a of data ?? []) byGraph.set(a.graphId, [...(byGraph.get(a.graphId) ?? []), a]);
    return [...byGraph.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data]);
  const open = (a: api.Assistant) => openTab({ kind: "langgraph.assistant", params: { assistantId: a.assistantId, name: a.name }, title: `Assistant ${a.name} · ${profile.name}` });
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={tab.title}>
      <PageHeader
        title="Assistants"
        subtitle={`${profile.name}${data ? ` · ${data.length} assistant${data.length === 1 ? "" : "s"} in ${groups.length} graph${groups.length === 1 ? "" : "s"}` : ""}`}
        actions={
          <Button appearance="subtle" loading={loading} onClick={() => void reload()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      <div className="mt-stack-md flex min-h-0 flex-1 flex-col border-t border-border-subtle">
      {error ? <ErrorState error={error} onRetry={() => void reload()} onRefresh={() => void reload()} /> : null}
      {loading && data === null ? <LoadingRows label="Loading assistants" /> : null}
      {data !== null && data.length === 0 ? <EmptyLine>No assistants on this server.</EmptyLine> : null}
      {groups.length > 0 ? (
        <Table aria-label="Assistants" className={cn("min-h-0 flex-1", gutterTable)}>
          <TableHeader>
            <TableRow>
              <TableHead>Graph</TableHead>
              <TableHead>Assistant</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Id</TableHead>
              <TableHead>Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.flatMap(([graph, list]) =>
              list.map((a, i) => (
                <TableRow key={a.assistantId} onDoubleClick={() => open(a)}>
                  <TableCell>{i === 0 ? graph : ""}</TableCell>
                  <TableCell>
                    <Button appearance="transparent" size="small" onClick={() => open(a)}>
                      {a.name}
                    </Button>
                  </TableCell>
                  <TableCell>{a.version ?? ""}</TableCell>
                  <TableCell className="font-mono text-code">{shortId(a.assistantId)}</TableCell>
                  <TableCell>{a.updatedAt ? <RelativeTime date={a.updatedAt} /> : null}</TableCell>
                </TableRow>
              )),
            )}
          </TableBody>
        </Table>
      ) : null}
      </div>
    </div>
  );
}

/** One assistant: its graph (xray for subgraphs), schemas and config. */
/** The assistant's sections, the view words of its URL (DOC-21 §3.7). */
export const ASSISTANT_VIEWS = ["graph", "schemas", "config"] as const;

export function AssistantTab({ tab, profile, connId, client, useTabActions, note, openTab, navigate }: TabProps) {
  const [section, setSection] = useTabView({ tab, navigate }, ASSISTANT_VIEWS, "graph");
  const assistantId = text(tab.params["assistantId"]);
  const [xray, setXray] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const assistant = useLoad(connId ? () => client.langgraph.assistants.get({ connId, assistantId }) : null, [connId, assistantId], note);
  const graph = useLoad(connId ? () => client.langgraph.assistants.graph({ connId, assistantId, xray }) : null, [connId, assistantId, xray], note);
  const schemas = useLoad(connId ? () => client.langgraph.assistants.schemas({ connId, assistantId }) : null, [connId, assistantId], note);
  const reload = () => {
    void assistant.reload();
    void graph.reload();
    void schemas.reload();
  };
  useTabActions({ refresh: reload });
  const view = useMemo(() => (graph.data ? toGraphView(graph.data) : null), [graph.data]);
  const a = assistant.data;
  const threadsOf = () => openTab({ kind: "langgraph.threads", params: {}, title: tab.title.replace(/^Assistant/, "Threads") });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={a?.name ?? (typeof tab.params["name"] === "string" ? tab.params["name"] : "Assistant")}
        adornment={a ? <CopyButton value={a.assistantId} what="assistant ID" /> : null}
        subtitle={a ? `Assistant · graph ${a.graphId}${a.version !== undefined ? ` · version ${a.version}` : ""} · ${profile.name}` : profile.name}
        actions={
          <>
            <Button appearance="subtle" onClick={reload}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="secondary" onClick={threadsOf}>
              <Icon icon={History} /> Threads
            </Button>
          </>
        }
      />
      {assistant.error ? <ErrorState error={assistant.error} onRetry={reload} onRefresh={reload} /> : null}
      <Tabs value={section} onValueChange={(v) => setSection(v as typeof section)} className="mt-stack-md flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Assistant views" className="px-inset-lg">
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="schemas">Schemas</TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
        </TabsList>
        <TabsContent value="graph" className="flex min-h-0 flex-1 flex-col gap-stack-md px-inset-lg py-inset-md">
          <div className="flex items-center gap-inline-md">
            <label className="flex items-center gap-inline-sm text-body-1 text-fg">
              <Switch checked={xray} onCheckedChange={setXray} />
              Show subgraphs (xray)
            </label>
            {selected ? <span className="text-caption-1 text-fg-muted">Selected: {selected}</span> : null}
          </div>
          {graph.error ? <ErrorState error={graph.error} onRetry={() => void graph.reload()} onRefresh={() => void graph.reload()} /> : null}
          {graph.loading && !view ? <LoadingRows label="Loading the graph" /> : null}
          {view && view.nodes.length === 0 ? <EmptyLine>The server returned a graph with no nodes.</EmptyLine> : null}
          {view && view.nodes.length > 0 ? <GraphView aria-label={`Graph of ${a?.name ?? assistantId}`} nodes={view.nodes} edges={view.edges} groups={view.groups} selectedId={selected} onNodeSelect={setSelected} className="min-h-0 flex-1" /> : null}
        </TabsContent>
        <TabsContent value="schemas" className="flex min-h-0 flex-1 flex-col gap-stack-md overflow-auto p-inset-sm">
          {schemas.error ? <ErrorState error={schemas.error} onRetry={() => void schemas.reload()} /> : null}
          {schemas.data
            ? (
                [
                  ["Input", schemas.data.inputSchema],
                  ["Output", schemas.data.outputSchema],
                  ["State", schemas.data.stateSchema],
                  ["Config", schemas.data.configSchema],
                  ["Context", schemas.data.contextSchema],
                ] as const
              ).map(([label, schema]) =>
                schema === undefined || schema === null ? null : (
                  <section key={label} className="flex flex-col gap-stack-xs">
                    <h3 className="text-subtitle-2 text-fg">{label} schema</h3>
                    <JsonViewer value={schema} aria-label={`${label} schema`} className="h-panel-xs" />
                  </section>
                ),
              )
            : null}
        </TabsContent>
        <TabsContent value="config" className="flex min-h-0 flex-1 flex-col gap-stack-md overflow-auto p-inset-sm">
          {a ? (
            <>
              <DescriptionList>
                <DescriptionListItem>
                  <DescriptionListTerm>Name</DescriptionListTerm>
                  <DescriptionListDetails>{a.name}</DescriptionListDetails>
                </DescriptionListItem>
                <DescriptionListItem>
                  <DescriptionListTerm>Assistant id</DescriptionListTerm>
                  <DescriptionListDetails className="font-mono text-code">{a.assistantId}</DescriptionListDetails>
                </DescriptionListItem>
                <DescriptionListItem>
                  <DescriptionListTerm>Graph</DescriptionListTerm>
                  <DescriptionListDetails>{a.graphId}</DescriptionListDetails>
                </DescriptionListItem>
                <DescriptionListItem>
                  <DescriptionListTerm>Version</DescriptionListTerm>
                  <DescriptionListDetails>{a.version ?? "—"}</DescriptionListDetails>
                </DescriptionListItem>
                {a.description ? (
                  <DescriptionListItem>
                    <DescriptionListTerm>Description</DescriptionListTerm>
                    <DescriptionListDetails>{a.description}</DescriptionListDetails>
                  </DescriptionListItem>
                ) : null}
              </DescriptionList>
              <h3 className="text-subtitle-2 text-fg">Config</h3>
              <JsonViewer value={a.config} aria-label="Config" className="h-panel-xs" />
              <h3 className="text-subtitle-2 text-fg">Context</h3>
              <JsonViewer value={a.context} aria-label="Context" className="h-panel-xs" />
              <h3 className="text-subtitle-2 text-fg">Metadata</h3>
              <JsonViewer value={a.metadata} aria-label="Metadata" className="h-panel-xs" />
            </>
          ) : assistant.loading ? (
            <LoadingRows label="Loading the assistant" />
          ) : null}
        </TabsContent>
      </Tabs>
    </div>
  );
}
