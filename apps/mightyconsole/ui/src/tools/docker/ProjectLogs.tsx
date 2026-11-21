// A Compose project's logs merged by time (TSK-81 batch 4b, mockup frame docker-project-logs,
// DOC-21 Open question 45 q), as `docker compose logs -f` shows them: one `docker.containers.logs`
// stream per container (followed while it runs, its tail read once when stopped), merged in the
// browser by Docker's timestamps (`project-logs.ts`), with a service column (a chart colour and the
// name) and a chip per service to hide or show it. A container of the project that starts later
// joins from its start (`docker.events`); one that stops leaves a line saying so. The merged view
// has no stdout and stderr apart: a container's own Logs has them.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { LogViewer, type LogLine, type LogViewerHandle } from "@/components/ui/log-viewer";
import { Select, SelectItem } from "@/components/ui/select";
import { ToggleButton } from "@/components/ui/toggle-button";
import { liveTimeout } from "@/app/client";
import { PageBar, chipClass } from "@/app/page";
import { LiveBadge } from "@/app/states";
import { useActiveGate, useActiveInterval } from "@/app/while-active";
import * as api from "@/gen/api";
import type { ContainerRow } from "@/gen/api";
import { Play, Stop } from "@/lib/icons";
import type { LiveState, TabActionHandlers, TabProps } from "../types";
import { type DockerLogLine, parseLines } from "./format";
import { useDockerEvents } from "./live";
import { LogMerger, type ProjectLine, labelColors, serviceLabels } from "./project-logs";

/** Lines the viewer keeps; older ones are dropped. */
export const MAX_PROJECT_LINES = 50_000;

/** How long lines wait to be put in order with the other streams'. */
export const MERGE_WINDOW_MS = 250;

/** At most this long the first lines wait for every stream's backlog. */
export const BACKLOG_WAIT_MS = 1500;

const TAILS = { "100": "Last 100 lines each", "1000": "Last 1,000 lines each", all: "Whole logs" } as const;
type Tail = keyof typeof TAILS;

/** The Compose labels Docker copies into a container's events. */
const PROJECT_LABEL = "com.docker.compose.project";
const SERVICE_LABEL = "com.docker.compose.service";

/**
 * The tab's actions while the view is shown: the shell keeps one registration per tab, taken on
 * mount and dropped on unmount, so it mounts and unmounts with the view.
 */
function ViewActions({ useActions, handlers }: { useActions: TabProps["useTabActions"]; handlers: TabActionHandlers }) {
  useActions(handlers);
  return null;
}

const toViewer = (l: ProjectLine): LogLine => ({ ts: l.ts, stream: l.label, text: l.text });

export interface ProjectLogsProps extends Pick<TabProps, "client" | "connId" | "note" | "onLive" | "useTabActions"> {
  project: string;
  /** Shown: the tab's actions (Stop, Refresh, Find) are its own; hidden, its streams go on. */
  active: boolean;
  /** The project's containers when the view opened (later ones join through the events). */
  rows: readonly ContainerRow[];
}

export function ProjectLogs({ client, connId, note, onLive, useTabActions, active, project, rows }: ProjectLogsProps) {
  const gate = useActiveGate(active);
  const viewer = useRef<LogViewerHandle>(null);
  const [tail, setTail] = useState<Tail>("1000");
  const [timestamps, setTimestamps] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [following, setFollowing] = useState<readonly string[]>([]);
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(new Map());
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(() => serviceLabels(rows));
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;
  const noteRef = useRef(note);
  noteRef.current = note;
  const merger = useRef(new LogMerger());
  const all = useRef<ProjectLine[]>([]);
  /** The open stream per container; `ending` once Docker said it died (a restart's new run opens another). */
  const streams = useRef(new Map<string, { id: number; follow: boolean; ending: boolean; cancel(): void }>());
  const nextId = useRef(0);
  const waiting = useRef(new Set<string>());
  const startedAt = useRef(0);
  const run = useRef(0);

  /** Says which containers are followed now. */
  const report = useCallback(() => {
    const names = [...streams.current].filter(([, s]) => s.follow && !s.ending).map(([n]) => n).sort();
    setFollowing(names);
    onLive(names.length > 0 ? { status: "live" } : { status: "ended", reason: "no container is running" });
  }, [onLive]);

  /** One container's stream; its lines go to the merger. */
  const open = useCallback(
    (name: string, label: string, options: { follow: boolean; tail: number | null; since: string | null; after?: string | undefined }) => {
      if (connId === null) return;
      const mine = run.current;
      const id = ++nextId.current;
      const call = client.docker.containers.logs({ connId, id: name, follow: options.follow, tail: options.tail, since: options.since, streamId: crypto.randomUUID() }, liveTimeout(api.procedures.docker.containers.logs));
      let cancelled = false;
      streams.current.set(name, {
        id,
        follow: options.follow,
        ending: false,
        cancel: () => {
          cancelled = true;
          call.cancel();
        },
      });
      report();
      const decoder = new TextDecoder();
      let first = true;
      void (async () => {
        try {
          for await (const chunk of call.chunks()) {
            // Hidden (TSK-107): lines wait in the streams' credits, nothing is merged or drawn.
            await gate.idle();
            if (mine !== run.current) return;
            merger.current.push(name, label, parseLines<DockerLogLine>(chunk, decoder), first ? options.after : undefined);
            first = false;
            waiting.current.delete(name);
          }
          await call.result;
        } catch (e) {
          if (cancelled || mine !== run.current) return;
          const d = noteRef.current(e);
          if (d.code !== "Cancelled") setFailures((f) => new Map(f).set(name, d.title));
        } finally {
          waiting.current.delete(name);
          // A newer stream of the container (its next run) stays.
          if (mine === run.current && streams.current.get(name)?.id === id) {
            streams.current.delete(name);
            report();
          }
        }
      })();
    },
    [client, connId, report, gate],
  );

  /** Every container's log again from its tail. */
  const startAll = useCallback(() => {
    run.current += 1;
    for (const s of streams.current.values()) s.cancel();
    streams.current.clear();
    merger.current = new LogMerger();
    all.current = [];
    viewer.current?.clear();
    setFailures(new Map());
    const current = rowsRef.current;
    const names = serviceLabels(current);
    setLabels(names);
    waiting.current = new Set(current.map((r) => r.name));
    startedAt.current = Date.now();
    for (const row of current) {
      const running = row.state === "running" || row.state === "restarting";
      open(row.name, names.get(row.name) ?? row.name, { follow: running, tail: tail === "all" ? null : Number(tail), since: null });
    }
  }, [open, report, tail]);

  const stopAll = useCallback(() => {
    run.current += 1;
    for (const s of streams.current.values()) s.cancel();
    streams.current.clear();
    waiting.current.clear();
    setFollowing([]);
    onLive({ status: "ended", reason: "stopped" });
  }, [onLive]);

  useEffect(() => {
    startAll();
    return () => {
      run.current += 1;
      for (const s of streams.current.values()) s.cancel();
      streams.current.clear();
    };
  }, [startAll]);
  useEffect(() => () => onLive(null), [onLive]);

  // Lines are handed to the viewer in order every MERGE_WINDOW_MS; the first ones wait for every
  // stream's backlog (or BACKLOG_WAIT_MS).
  // Hidden (TSK-107), the viewer is not fed; it is fed at once when shown.
  useActiveInterval(() => {
    if (merger.current.size === 0) return;
    if (waiting.current.size > 0 && Date.now() - startedAt.current < BACKLOG_WAIT_MS) return;
    waiting.current.clear();
    const lines = merger.current.take();
    all.current.push(...lines);
    if (all.current.length > MAX_PROJECT_LINES * 1.2) all.current = all.current.slice(-MAX_PROJECT_LINES);
    const shown = lines.filter((l) => !hiddenRef.current.has(l.label));
    if (shown.length > 0) viewer.current?.append(shown.map(toViewer));
  }, MERGE_WINDOW_MS, active);

  // A container of the project that starts joins from its start; one that stops leaves a line.
  const events = useDockerEvents({
    client,
    connId,
    active,
    types: ["container"],
    onEvent: (event) => {
      if (event.attributes[PROJECT_LABEL] !== project || !event.name) return;
      const name = event.name;
      const action = event.action.split(":")[0]!.trim();
      const stream = streams.current.get(name);
      if (action === "start" && (stream === undefined || stream.ending)) {
        const known = rowsRef.current.some((r) => r.name === name);
        const label = labels.get(name) ?? (known ? name : (event.attributes[SERVICE_LABEL] ?? name));
        if (!labels.has(name)) setLabels((m) => new Map(m).set(name, label));
        open(name, label, { follow: true, tail: null, since: String(Math.floor(event.timeMs / 1000)), after: merger.current.lastKey(name) });
      } else if (action === "die") {
        if (stream) stream.ending = true;
        report();
        const label = labels.get(name) ?? name;
        const code = event.attributes["exitCode"];
        merger.current.push(name, label, [{ ts: new Date(event.timeMs).toISOString(), stream: "stdout", text: `[${name} stopped${code !== undefined ? `, exit code ${code}` : ""}]` }]);
      }
    },
  });

  // The services filter redraws from what was received.
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    viewer.current?.clear();
    viewer.current?.append(all.current.filter((l) => !hidden.has(l.label)).map(toViewer));
  }, [hidden]);



  const colors = useMemo(() => labelColors(labels.values()), [labels]);
  const services = Object.keys(colors);

  const download = (text: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const live: LiveState | null = following.length > 0 ? { status: "live" } : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {active ? <ViewActions useActions={useTabActions} handlers={{ stop: stopAll, refresh: startAll, find: () => viewer.current?.openSearch() }} /> : null}
      <PageBar aria-label="Log options" className="pb-stack-sm">
        <span role="group" aria-label="Services" className="flex flex-wrap items-center gap-inline-xs">
          {services.map((label) => (
            <ToggleButton
              key={label}
              size="small"
              appearance="outline"
              pressed={!hidden.has(label)}
              onPressedChange={(on) =>
                setHidden((h) => {
                  const next = new Set(h);
                  if (on) next.delete(label);
                  else next.add(label);
                  return next;
                })
              }
              className={chipClass}
            >
              {label}
            </ToggleButton>
          ))}
        </span>
        <Select aria-label="Tail" size="small" items={TAILS} value={tail} onValueChange={(v) => setTail(v as Tail)} className="w-auto">
          {(Object.keys(TAILS) as Tail[]).map((t) => (
            <SelectItem key={t} value={t}>
              {TAILS[t]}
            </SelectItem>
          ))}
        </Select>
        <label className="flex items-center gap-inline-sm text-body-1 text-fg">
          <Checkbox checked={timestamps} onCheckedChange={(c) => setTimestamps(c === true)} /> Timestamps
        </label>
        <label className="flex items-center gap-inline-sm text-body-1 text-fg">
          <Checkbox checked={wrap} onCheckedChange={(c) => setWrap(c === true)} /> Wrap
        </label>
        <span className="flex-1" />
        {live ? <LiveBadge live={live} unit="lines/s" /> : null}
        {following.length > 0 ? (
          <Button appearance="subtle" size="small" onClick={stopAll}>
            <Icon icon={Stop} /> Stop
          </Button>
        ) : (
          <Button appearance="subtle" size="small" onClick={startAll}>
            <Icon icon={Play} /> Follow again
          </Button>
        )}
      </PageBar>
      {failures.size > 0 ? (
        <p role="alert" className="px-inset-lg pb-stack-sm text-body-1 text-danger-fg">
          {[...failures].map(([name, why]) => `${name}: ${why}`).join(" · ")}
        </p>
      ) : null}
      <LogViewer
        ref={viewer}
        aria-label={`${project} logs`}
        maxLines={MAX_PROJECT_LINES}
        defaultFollow
        wrap={wrap}
        timestamps={timestamps}
        streamColumn
        streamColors={colors}
        onDownload={download}
        emptyText={following.length > 0 ? "Waiting for the first line…" : "No lines."}
        className="min-h-0 flex-1 border-t border-border-subtle"
      />
      <div className="flex shrink-0 items-center gap-inline-md border-t border-border-subtle px-inset-lg py-stack-sm text-caption-1 text-fg-muted">
        <span>
          {following.length > 0 ? `Following ${following.length} of ${labels.size} ${labels.size === 1 ? "container" : "containers"}` : `Not following (${labels.size} ${labels.size === 1 ? "container" : "containers"} read)`} · ordered by Docker's timestamps
          {events.live ? "" : " · events not live"}
        </span>
        <span className="flex-1" />
        <span>A container that starts later joins; one that stops leaves a line</span>
      </div>
    </div>
  );
}
