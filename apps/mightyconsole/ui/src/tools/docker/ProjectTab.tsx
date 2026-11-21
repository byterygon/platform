// `docker.project { project, view }` (TSK-81 batch 4b, mockup frame docker-project-logs, DOC-21
// Open question 45 q): a Compose project's tab. The header names the project, its containers and
// its working dir; Logs merges its containers' logs by time (ProjectLogs), Containers is the
// Containers list kept to the project, with its menu that starts, stops or restarts them all. The
// project is read from the containers' labels and follows the host's container events.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Page, PageHeader } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { useTabView } from "@/app/tab-view";
import { str } from "@/app/router";
import type { ContainerRow } from "@/gen/api";
import type { DescribedError, TabProps } from "../types";
import { ContainersTab } from "./ContainersTab";
import { changesRows, countWords } from "./format";
import { useDockerEvents } from "./live";
import { ProjectLogs } from "./ProjectLogs";
import { RELOAD_DEBOUNCE_MS } from "./resources";

/** The project's views, the last word of its URL (DOC-21 §3.7). */
export const PROJECT_VIEWS = ["logs", "containers"] as const;
type ProjectView = (typeof PROJECT_VIEWS)[number];

const WORKING_DIR_LABEL = "com.docker.compose.project.working_dir";

export function ProjectTab(props: TabProps) {
  const { tab, profile, connId, client, note, onLive, useTabActions, navigate } = props;
  const project = str(tab.params["project"]);
  const [view, setView] = useTabView({ tab, navigate }, PROJECT_VIEWS, "logs");
  const [rows, setRows] = useState<ContainerRow[] | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Logs stay mounted once opened, so its streams (and the lines a restart leaves) go on while
  // Containers is shown.
  const [logsSeen, setLogsSeen] = useState(view === "logs");
  useEffect(() => {
    if (view === "logs") setLogsSeen(true);
  }, [view]);

  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const list = await client.docker.containers.list({ connId, all: true });
      if (mine !== generation.current) return;
      setRows(list.filter((r) => r.project === project).sort((a, b) => a.name.localeCompare(b.name)));
      setError(null);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, note, project]);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useDockerEvents({
    client,
    connId,
    types: ["container"],
    onEvent: (event) => {
      if (event.attributes["com.docker.compose.project"] !== project || !changesRows(event)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), RELOAD_DEBOUNCE_MS);
    },
  });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const workingDir = rows?.map((r) => r.labels[WORKING_DIR_LABEL]).find(Boolean);
  return (
    <Page>
      <PageHeader
        title={project}
        adornment={
          <Badge appearance="tint" variant="neutral">
            Compose project
          </Badge>
        }
        subtitle={[profile.name, rows ? countWords(rows) : null, workingDir ?? null].filter(Boolean).join(" · ")}
      />
      {error ? (
        <div className="px-inset-lg pt-stack-md">
          <ErrorState error={error} onRetry={() => void load()} />
        </div>
      ) : null}
      {rows === null && loading ? <LoadingRows label="Loading the project's containers" /> : null}
      {rows !== null && rows.length === 0 ? <EmptyLine>No container of {project} on {profile.name}: the project is down or gone.</EmptyLine> : null}
      {rows !== null && rows.length > 0 ? (
        <Tabs value={view} onValueChange={(v) => setView(v as ProjectView)} className="mt-stack-md flex min-h-0 flex-1 flex-col gap-0">
          <TabsList aria-label="Project views" className="gap-inline-xs px-inset-lg [&_[data-slot=tabs-trigger]]:h-control-lg [&_[data-slot=tabs-trigger]]:px-inline-md [&_[data-slot=tabs-item]:first-child]:-ms-inline-md">
            <TabsTrigger value="containers">
              Containers <span className="text-fg-muted tabular-nums">{rows.length}</span>
            </TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
          </TabsList>
          <TabsContent value="logs" keepMounted={logsSeen} className="flex min-h-0 flex-1 flex-col">
            {logsSeen ? <ProjectLogs client={client} connId={connId} note={note} onLive={onLive} useTabActions={useTabActions} active={view === "logs"} project={project} rows={rows} /> : null}
          </TabsContent>
          <TabsContent value="containers" className="flex min-h-0 flex-1 flex-col border-t border-border-subtle">
            {view === "containers" ? <ContainersTab {...props} project={project} /> : null}
          </TabsContent>
        </Tabs>
      ) : null}
    </Page>
  );
}
