// Assistants (grouped by graph) and an assistant's Graph, Schemas, Config and Versions (spec §11.2,
// §11.2.1; the Graph's node pane and Versions are TSK-96).
import type { LinkEvent } from "../types";
import { linkTo } from "@/app/tab-view";
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { Button } from "@/components/ui/button";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { RelativeTime } from "@/components/ui/relative-time";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton, LinkButton, PageBar, PageHeader, gutterTable, linkHandlers } from "@/app/page";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectItem } from "@/components/ui/select";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { useTabView } from "@/app/tab-view";
import { cn } from "@/lib/cn";
import type * as api from "@/gen/api";
import { Add, ArrowClockwise, History } from "@/lib/icons";
import type { TabProps } from "../types";
import { GraphPanel, type XrayChoice, xrayOf } from "./assistant-graph";
import { SchemasPanel } from "./assistant-schemas";
import { VersionsPanel } from "./assistant-versions";
import { shortId, useLoad } from "./shared";

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** Every assistant, grouped by graph id, with a graph and a text filter; a row opens the assistant. */
export function AssistantsTab({ tab, profile, connId, client, useTabActions, note, openTab, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const { data, error, loading, reload } = useLoad(connId ? () => client.langgraph.assistants.search({ connId, graphId: null, metadata: null, limit: 1000, offset: null }) : null, [connId], note);
  useTabActions({ refresh: () => void reload() });
  const [graphFilter, setGraphFilter] = useState<string>(ANY_GRAPH);
  const [query, setQuery] = useState("");
  const graphs = useMemo(() => [...new Set((data ?? []).map((a) => a.graphId))].sort((a, b) => a.localeCompare(b)), [data]);
  const groups = useMemo(() => {
    const words = query.trim().toLowerCase();
    const byGraph = new Map<string, api.Assistant[]>();
    for (const a of data ?? []) {
      if (graphFilter !== ANY_GRAPH && a.graphId !== graphFilter) continue;
      if (words && !`${a.name} ${a.description ?? ""} ${a.assistantId}`.toLowerCase().includes(words)) continue;
      byGraph.set(a.graphId, [...(byGraph.get(a.graphId) ?? []), a]);
    }
    return [...byGraph.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data, graphFilter, query]);
  const open = (a: api.Assistant, event?: LinkEvent) => go({ kind: "langgraph.assistant", params: { assistantId: a.assistantId, name: a.name }, title: `Assistant ${a.name} · ${profile.name}` }, event);
  const graphItems = { [ANY_GRAPH]: "Graph: Any", ...Object.fromEntries(graphs.map((g) => [g, `Graph: ${g}`])) };
  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-label={tab.title}>
      <PageHeader
        title="Assistants"
        subtitle={`${profile.name}${data ? ` · ${data.length} assistant${data.length === 1 ? "" : "s"} on ${graphs.length} graph${graphs.length === 1 ? "" : "s"}` : ""}`}
        actions={
          <Button appearance="subtle" loading={loading} onClick={() => void reload()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      <PageBar aria-label="Assistant filters">
        <Select aria-label="Graph" value={graphFilter} onValueChange={(v) => setGraphFilter((v as string) ?? ANY_GRAPH)} items={graphItems}>
          {Object.entries(graphItems).map(([id, label]) => (
            <SelectItem key={id} value={id}>
              {label}
            </SelectItem>
          ))}
        </Select>
        <SearchInput aria-label="Filter by name or description" placeholder="Filter by name or description" value={query} onValueChange={setQuery} className="min-w-0 flex-1" />
      </PageBar>
      <div className="mt-stack-md flex min-h-0 flex-1 flex-col overflow-auto border-t border-border-subtle">
        {error ? <ErrorState error={error} onRetry={() => void reload()} onRefresh={() => void reload()} /> : null}
        {loading && data === null ? <LoadingRows label="Loading assistants" /> : null}
        {data !== null && data.length === 0 ? <EmptyLine>No assistants on this server.</EmptyLine> : null}
        {data !== null && data.length > 0 && groups.length === 0 ? <EmptyLine>No assistant matches the filter.</EmptyLine> : null}
        {groups.length > 0 ? (
          <Table aria-label="Assistants" className={gutterTable}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Assistant ID</TableHead>
                <TableHead className="text-end">Version</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead>Description</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.flatMap(([graph, list]) => [
                <TableRow key={`graph:${graph}`} data-group="">
                  <TableCell colSpan={5} className="text-caption-1 text-fg-muted">
                    graph <span className="text-caption-1-strong text-fg">{graph}</span>
                  </TableCell>
                </TableRow>,
                ...list.map((a) => (
                  <TableRow key={a.assistantId} onDoubleClick={(e) => open(a, e)}>
                    <TableCell>
                      <span className="flex items-center gap-inline-xs">
                        <LinkButton onOpen={(e) => open(a, e)}>{a.name}</LinkButton>
                        <CopyButton value={a.assistantId} what="assistant ID" />
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-code" title={a.assistantId}>
                      {shortId(a.assistantId)}
                    </TableCell>
                    <TableCell className="text-end">{a.version !== undefined ? `v${a.version}` : ""}</TableCell>
                    <TableCell>{a.updatedAt ? <RelativeTime date={a.updatedAt} /> : null}</TableCell>
                    <TableCell className="max-w-panel-sm truncate" title={a.description ?? undefined}>
                      {a.description ?? ""}
                    </TableCell>
                  </TableRow>
                )),
              ])}
            </TableBody>
          </Table>
        ) : null}
      </div>
    </div>
  );
}

const ANY_GRAPH = "any";

/** The assistant's sections, the view words of its URL (DOC-21 §3.7). */
export const ASSISTANT_VIEWS = ["graph", "schemas", "config", "versions"] as const;

/** One assistant (DOC-21 §11.2.1): its graph with the node pane, schemas, config and versions. */
export function AssistantTab({ tab, profile, connId, client, useTabActions, note, openTab, navigate, go: goProp }: TabProps) {
  const go = linkTo({ openTab, ...(goProp ? { go: goProp } : {}) });
  const toast = useToast();
  const [section, setSection] = useTabView({ tab, navigate }, ASSISTANT_VIEWS, "graph");
  const assistantId = text(tab.params["assistantId"]);
  const [xray, setXray] = useState<XrayChoice>("1");
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const assistant = useLoad(connId ? () => client.langgraph.assistants.get({ connId, assistantId }) : null, [connId, assistantId], note);
  const graph = useLoad(connId ? () => client.langgraph.assistants.graph({ connId, assistantId, xray: xrayOf(xray) }) : null, [connId, assistantId, xray], note);
  const schemas = useLoad(connId ? () => client.langgraph.assistants.schemas({ connId, assistantId }) : null, [connId, assistantId], note);
  const versions = useLoad(connId ? () => client.langgraph.assistants.versions({ connId, assistantId, limit: 20, offset: null }) : null, [connId, assistantId], note);
  // Read from the runs' checkpoints on the server: only once the Graph is shown.
  const [statsWanted, setStatsWanted] = useState(section === "graph");
  useEffect(() => {
    if (section === "graph") setStatsWanted(true);
  }, [section]);
  const stats = useLoad(connId && statsWanted ? () => client.langgraph.assistants.nodeStats({ connId, assistantId, runs: 50 }) : null, [connId, assistantId, statsWanted], note);
  const reload = () => {
    void assistant.reload();
    void graph.reload();
    void schemas.reload();
    void versions.reload();
    if (statsWanted) void stats.reload();
  };
  useTabActions({ refresh: reload });
  const a = assistant.data;
  const threadsOf = (event?: LinkEvent) => go({ kind: "langgraph.threads", params: {}, title: "Threads" }, event);
  const openThread = (threadId: string, event?: LinkEvent, input?: string) => go({ kind: "langgraph.thread", params: { threadId, ...(input ? { input } : {}) }, title: `Thread ${shortId(threadId)} · ${profile.name}` }, event);
  /** A new thread that names this assistant, so its Run form starts with it. */
  const newThread = async (input?: string) => {
    if (!connId || !a) return;
    setCreating(true);
    try {
      const t = await client.langgraph.threads.create({ connId, metadata: { assistant_id: a.assistantId, graph_id: a.graphId } });
      // "Start a thread with it": the example input goes into the new thread's Run form.
      openThread(t.threadId, undefined, input);
    } catch (e) {
      toast.add({ title: "The thread was not created", description: note(e).title, type: "error" });
    } finally {
      setCreating(false);
    }
  };
  const schemaCount = schemas.data ? [schemas.data.inputSchema, schemas.data.outputSchema, schemas.data.stateSchema, schemas.data.configSchema, schemas.data.contextSchema].filter((x) => x !== undefined && x !== null).length : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={a?.name ?? (typeof tab.params["name"] === "string" ? tab.params["name"] : "Assistant")}
        adornment={
          a ? (
            <>
              <CopyButton value={a.assistantId} what="assistant ID" />
              {a.version !== undefined ? (
                <Badge appearance="tint" variant="neutral">
                  v{a.version}
                </Badge>
              ) : null}
            </>
          ) : null
        }
        subtitle={
          a ? (
            <>
              Graph <span className="text-body-1-strong text-fg">{a.graphId}</span> · assistant <span className="font-mono">{shortId(a.assistantId)}</span>
              {a.updatedAt ? (
                <>
                  {" "}
                  · updated <RelativeTime date={a.updatedAt} />
                </>
              ) : null}{" "}
              · {profile.name}
            </>
          ) : (
            profile.name
          )
        }
        actions={
          <>
            <Button appearance="subtle" onClick={reload}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="secondary" {...linkHandlers(threadsOf)}>
              <Icon icon={History} /> Threads
            </Button>
            <Button appearance="primary" loading={creating} disabled={!a} onClick={() => void newThread()}>
              <Icon icon={Add} /> New thread
            </Button>
          </>
        }
      />
      {assistant.error ? <ErrorState error={assistant.error} onRetry={reload} onRefresh={reload} /> : null}
      <Tabs value={section} onValueChange={(v) => setSection(v as typeof section)} className="mt-stack-md flex min-h-0 flex-1 flex-col">
        <TabsList aria-label="Assistant views" className="px-inset-lg">
          <TabsTrigger value="graph">Graph</TabsTrigger>
          <TabsTrigger value="schemas" count={schemaCount} countLabel={["schema", "schemas"]}>
            Schemas
          </TabsTrigger>
          <TabsTrigger value="config">Config</TabsTrigger>
          <TabsTrigger value="versions" count={versions.data?.items.length} countMore={versions.data?.next !== undefined && versions.data.next !== null} countLabel={["version", "versions"]}>
            Versions
          </TabsTrigger>
        </TabsList>
        <TabsContent value="graph" className="flex min-h-0 flex-1 flex-col p-0">
          <GraphPanel name={a?.name ?? assistantId} graph={graph} stats={stats} xray={xray} onXray={setXray} selected={selected} onSelect={setSelected} onThread={openThread} />
        </TabsContent>
        <TabsContent value="schemas" className="flex min-h-0 flex-1 flex-col p-0">
          <SchemasPanel schemas={schemas} starting={creating} onStart={(input) => void newThread(input)} />
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
              <h3 className="flex items-center gap-inline-sm text-subtitle-2 text-fg">
                Config <CopyButton value={JSON.stringify(a.config, null, 2)} what="the config" />
              </h3>
              <JsonViewer value={a.config} aria-label="Config" className="h-panel-xs" />
              <h3 className="flex items-center gap-inline-sm text-subtitle-2 text-fg">
                Context <CopyButton value={JSON.stringify(a.context, null, 2)} what="the context" />
              </h3>
              <JsonViewer value={a.context} aria-label="Context" className="h-panel-xs" />
              <h3 className="flex items-center gap-inline-sm text-subtitle-2 text-fg">
                Metadata <CopyButton value={JSON.stringify(a.metadata, null, 2)} what="the metadata" />
              </h3>
              <JsonViewer value={a.metadata} aria-label="Metadata" className="h-panel-xs" />
            </>
          ) : assistant.loading ? (
            <LoadingRows label="Loading the assistant" />
          ) : null}
        </TabsContent>
        <TabsContent value="versions" className="flex min-h-0 flex-1 flex-col p-0">
          <VersionsPanel assistantId={assistantId} connId={connId} client={client} note={note} first={versions} current={a?.version} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
