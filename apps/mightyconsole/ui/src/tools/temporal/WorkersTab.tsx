// `temporal.workers { namespace }` (Mightyconsole spec §9.3 "Workers", TSK-92): every worker
// polling the namespace's task queues, from the pollers of each queue seen in its latest
// workflows and of the queues typed here (`temporal.workers.list`). Refreshed every 10 seconds
// while the tab is shown. A worker whose last poll is over 2 minutes old is amber; the server
// forgets a poller after 5. Filters: task queue, what it polls for, text over identity and build.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RelativeTime } from "@/components/ui/relative-time";
import { CopyButton, Page, PageBar, PageFooter, PageHeader, PageRegion, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import { cn } from "@/lib/cn";
import type { WorkerRow, WorkersListOutput } from "@/gen/api";
import { Add, ArrowClockwise } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { namespaceOf } from "./profile";

/** How often the list refreshes while shown, and when a worker turns amber. */
export const REFRESH_MS = 10_000;
export const IDLE_MS = 2 * 60_000;

type Kind = "any" | "workflow" | "activity";
const ALL = "*";

/** What a worker polls for, in words. */
export function pollsFor(w: Pick<WorkerRow, "pollsWorkflows" | "pollsActivities">): string {
  if (w.pollsWorkflows && w.pollsActivities) return "Workflow, activity";
  return w.pollsWorkflows ? "Workflow" : "Activity";
}

/** Whether the worker's last poll is older than IDLE_MS at `now`. */
export function isIdle(w: Pick<WorkerRow, "lastAccessTime">, now: number): boolean {
  const t = w.lastAccessTime ? Date.parse(w.lastAccessTime) : Number.NaN;
  return Number.isNaN(t) || now - t > IDLE_MS;
}

/** The rows the filters keep. */
export function filterWorkers(rows: readonly WorkerRow[], queue: string, kind: Kind, text: string): WorkerRow[] {
  const needle = text.trim().toLowerCase();
  return rows.filter(
    (w) =>
      (queue === ALL || w.taskQueue === queue) &&
      (kind === "any" || (kind === "workflow" ? w.pollsWorkflows : w.pollsActivities)) &&
      (needle === "" || [w.identity, w.buildId ?? "", w.deploymentName ?? ""].some((v) => v.toLowerCase().includes(needle))),
  );
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function WorkersTab({ tab, profile, connId, client, useTabActions, note, openTab, active }: TabProps) {
  const namespace = text(tab.params["namespace"]) || namespaceOf(profile);
  const [out, setOut] = useState<WorkersListOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [typed, setTyped] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [queue, setQueue] = useState(ALL);
  const [kind, setKind] = useState<Kind>("any");
  const [filter, setFilter] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const o = await client.temporal.workers.list({ connId, namespace, taskQueues: typed.length > 0 ? typed : null });
      if (mine === generation.current) {
        setOut(o);
        setError(null);
        setNow(Date.now());
      }
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, namespace, typed, note]);

  useEffect(() => {
    void load();
  }, [load]);
  // Refresh while the tab is shown; a hidden tab stops asking.
  useEffect(() => {
    if (!active || connId === null) return;
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, connId, load]);
  useTabActions({ refresh: () => void load() });

  const rows = useMemo(() => filterWorkers(out?.workers ?? [], queue, kind, filter), [out, queue, kind, filter]);

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const workers = out?.workers ?? [];
  const queues = out?.taskQueues ?? [];
  const idle = workers.filter((w) => isIdle(w, now)).length;
  const polled = new Set(workers.map((w) => w.taskQueue)).size;
  const failed = queues.filter((q) => q.error !== undefined);
  const add = () => {
    const name = adding.trim();
    if (name !== "" && !typed.includes(name)) setTyped([...typed, name]);
    setAdding("");
  };

  return (
    <Page>
      <PageHeader
        title="Workers"
        subtitle={
          <>
            {profile.name} · namespace <span className="text-fg">{namespace}</span>
            {out ? ` · ${formatCount(workers.length)} ${workers.length === 1 ? "worker" : "workers"} polling ${formatCount(polled)} of ${formatCount(queues.length)} task ${queues.length === 1 ? "queue" : "queues"}` : ""}
            {idle > 0 ? ` · ${formatCount(idle)} idle` : ""}
          </>
        }
        actions={
          <Button appearance="subtle" onClick={() => void load()} loading={loading && out !== null}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      <PageBar aria-label="Filters">
        <Select aria-label="Task queue" value={queue} onValueChange={(v) => setQueue(String(v))} items={{ [ALL]: "All task queues", ...Object.fromEntries(queues.map((q) => [q.name, q.name])) }} className="w-panel-xs shrink-0">
          <SelectItem value={ALL}>All task queues</SelectItem>
          {queues.map((q) => (
            <SelectItem key={q.name} value={q.name}>
              {q.name}
            </SelectItem>
          ))}
        </Select>
        <Select aria-label="Polls for" value={kind} onValueChange={(v) => setKind(v as Kind)} items={{ any: "Any type", workflow: "Workflow", activity: "Activity" }} className="w-panel-xs shrink-0">
          <SelectItem value="any">Any type</SelectItem>
          <SelectItem value="workflow">Workflow</SelectItem>
          <SelectItem value="activity">Activity</SelectItem>
        </Select>
        <SearchInput aria-label="Filter by identity or build" placeholder="Filter by identity or build" value={filter} onValueChange={setFilter} className="min-w-0 flex-1" />
        <form
          className="flex items-center gap-inline-sm"
          aria-label="Add a task queue"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <Input aria-label="Task queue to add" placeholder="Task queue" value={adding} onValueChange={setAdding} autoComplete="off" spellCheck={false} className="w-panel-xs" />
          <Button type="submit" appearance="secondary" disabled={adding.trim() === ""}>
            <Icon icon={Add} /> Add
          </Button>
        </form>
      </PageBar>
      <PageRegion>
        {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
        {out === null && loading ? (
          <LoadingRows label="Loading workers" />
        ) : out !== null && queues.length === 0 ? (
          <EmptyLine>No task queue seen in {namespace}'s latest workflows. Type a task queue.</EmptyLine>
        ) : out !== null && workers.length === 0 ? (
          <EmptyLine>No worker is polling these task queues.</EmptyLine>
        ) : out !== null && rows.length === 0 ? (
          <EmptyLine>No worker matches the filters.</EmptyLine>
        ) : rows.length > 0 ? (
          <Table aria-label="Workers" className={cn("min-h-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Identity</TableHead>
                <TableHead>Task queue</TableHead>
                <TableHead>Polls for</TableHead>
                <TableHead>Version</TableHead>
                <TableHead>Last poll</TableHead>
                <TableHead align="end">Tasks per second</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((w) => {
                const stale = isIdle(w, now);
                return (
                  <TableRow key={`${w.identity}/${w.taskQueue}`} className="group">
                    <TableCell>
                      <span className="flex items-center gap-inline-xs">
                        <span role="img" aria-label={stale ? "idle" : "polling"} className={cn("size-icon-xs shrink-0 rounded-full", stale ? "bg-warning" : "bg-success")} />
                        <span className="font-mono text-code">{w.identity}</span>
                        {stale ? <Badge variant="warning">Idle</Badge> : null}
                        <CopyButton value={w.identity} what="worker identity" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" />
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button size="small" appearance="transparent" className="text-fg-link" onClick={() => openTab({ kind: "temporal.taskQueue", params: { namespace, name: w.taskQueue }, title: `Task queue ${w.taskQueue}` })}>
                        {w.taskQueue}
                      </Button>
                    </TableCell>
                    <TableCell>{pollsFor(w)}</TableCell>
                    <TableCell>{w.buildId || w.deploymentName ? <span className="font-mono text-code text-fg-muted">{[w.deploymentName, w.buildId].filter(Boolean).join(" · ")}</span> : <span className="text-fg-muted">—</span>}</TableCell>
                    <TableCell>{w.lastAccessTime ? <RelativeTime date={w.lastAccessTime} /> : <span className="text-fg-muted">—</span>}</TableCell>
                    <TableCell align="end">{w.ratePerSecond > 0 ? w.ratePerSecond.toFixed(2) : "0"}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        ) : null}
        {out !== null ? (
          <PageFooter>
            <span>
              From the pollers of each task queue (DescribeTaskQueue), refreshed every 10 s while this tab is shown. A worker idle for 2 minutes turns amber; the server forgets it after 5.
              {out.truncated ? " Only the first 50 task queues are read." : ""}
              {failed.length > 0 ? ` Could not read ${failed.map((q) => `${q.name} (${q.error})`).join(", ")}.` : ""}
            </span>
          </PageFooter>
        ) : null}
      </PageRegion>
    </Page>
  );
}
