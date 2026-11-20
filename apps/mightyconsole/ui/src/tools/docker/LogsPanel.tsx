// A container's Logs (Mightyconsole spec §10.4, TSK-81 mockup frame docker-logs): the LogViewer
// on `docker.containers.logs`, stderr marked on the left, Docker's timestamps, tail and since sent
// to Docker, the stream kept open while the container runs (follow, 12 h). A bar picks all,
// stdout or stderr (a TTY container has one stream, said in the bar), the tail, the since, the
// timestamps and wrapping; the viewer has its own search (Mod+F), follow and Download. Stop
// (Shift+Escape) ends the stream and Resume continues after the last line, as after a lost
// connection (spec §2.2).
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { LogViewer, type LogLine, type LogViewerHandle } from "@/components/ui/log-viewer";
import { Select, SelectItem } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { liveTimeout } from "@/app/client";
import { PageBar } from "@/app/page";
import { ErrorState, LiveBadge } from "@/app/states";
import * as api from "@/gen/api";
import { Play, Stop } from "@/lib/icons";
import type { DescribedError, LiveState, TabProps } from "../types";
import { type DockerLogLine, parseLines } from "./format";

/** Lines the viewer keeps; older ones are dropped. */
export const MAX_LOG_LINES = 50_000;

const TAILS = { "100": "Last 100 lines", "1000": "Last 1,000 lines", "10000": "Last 10,000 lines", all: "Whole log" } as const;
type Tail = keyof typeof TAILS;

const SINCES = { any: "Any time", "300": "Last 5 minutes", "3600": "Last hour", "86400": "Last 24 hours" } as const;
type Since = keyof typeof SINCES;

type StreamChoice = "all" | "stdout" | "stderr";

/** The lines of `stream` among `lines`. */
export function pickStream(lines: readonly DockerLogLine[], stream: StreamChoice): DockerLogLine[] {
  return stream === "all" ? [...lines] : lines.filter((l) => l.stream === stream);
}

/** After a reconnect: the lines of a resumed stream that were not shown yet (Docker's `since` is inclusive). */
export function newerThan(lines: readonly DockerLogLine[], lastTs: string, seenAtLast: number): DockerLogLine[] {
  let skip = seenAtLast;
  return lines.filter((l) => {
    if (l.ts === "" || l.ts > lastTs) return true;
    if (l.ts === lastTs && skip > 0) {
      skip -= 1;
      return false;
    }
    return l.ts >= lastTs;
  });
}

const toViewer = (l: DockerLogLine): LogLine => ({ ts: l.ts, stream: l.stream, text: l.text });

export interface LogsPanelProps extends Pick<TabProps, "client" | "connId" | "note" | "onLive" | "useTabActions"> {
  /** The container's name or id. */
  container: string;
  /** Whether it runs: a stopped container's log is read once. */
  running: boolean;
}

export function LogsPanel({ client, connId, note, onLive, useTabActions, container, running }: LogsPanelProps) {
  const viewer = useRef<LogViewerHandle>(null);
  const [tail, setTail] = useState<Tail>("1000");
  const [since, setSince] = useState<Since>("any");
  const [stream, setStream] = useState<StreamChoice>("all");
  const [timestamps, setTimestamps] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [tty, setTty] = useState(false);
  const [live, setLive] = useState<LiveState | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  // Every line received (the stream filter shows some of them).
  const all = useRef<DockerLogLine[]>([]);
  const streamRef = useRef(stream);
  streamRef.current = stream;
  const run = useRef<{ cancel(): void } | null>(null);
  const lastTs = useRef<string>("");
  const atLast = useRef(0);

  const report = useCallback(
    (next: LiveState | null) => {
      setLive(next);
      onLive(next);
    },
    [onLive],
  );

  /** Starts the stream; `resume` continues after the last line instead of starting over. */
  const start = useCallback(
    (resume: boolean) => {
      if (connId === null) return;
      run.current?.cancel();
      setError(null);
      if (!resume) {
        all.current = [];
        lastTs.current = "";
        atLast.current = 0;
        viewer.current?.clear();
      }
      const resumeFrom = resume && lastTs.current !== "" ? lastTs.current : null;
      const seenAtLast = atLast.current;
      const sinceSec = since === "any" ? null : String(Math.floor(Date.now() / 1000) - Number(since));
      const call = client.docker.containers.logs(
        {
          connId,
          id: container,
          follow: running,
          tail: resumeFrom !== null || tail === "all" ? null : Number(tail),
          since: resumeFrom ?? sinceSec,
          streamId: crypto.randomUUID(),
        },
        liveTimeout(api.procedures.docker.containers.logs),
      );
      let cancelled = false;
      run.current = {
        cancel: () => {
          cancelled = true;
          call.cancel();
        },
      };
      report(running ? { status: "live" } : null);
      const decoder = new TextDecoder();
      let first = resumeFrom !== null;
      void (async () => {
        try {
          let received = 0;
          let since0 = Date.now();
          let backlog = true;
          for await (const chunk of call.chunks()) {
            let lines = parseLines<DockerLogLine>(chunk, decoder);
            if (first) {
              lines = newerThan(lines, resumeFrom!, seenAtLast);
              first = false;
            }
            if (lines.length === 0) continue;
            for (const l of lines) {
              if (l.ts === "") continue;
              if (l.ts === lastTs.current) atLast.current += 1;
              else {
                lastTs.current = l.ts;
                atLast.current = 1;
              }
            }
            all.current.push(...lines);
            if (all.current.length > MAX_LOG_LINES * 1.2) all.current = all.current.slice(-MAX_LOG_LINES);
            const shown = pickStream(lines, streamRef.current);
            if (shown.length > 0) viewer.current?.append(shown.map(toViewer));
            // The first chunk is the log's backlog (the tail): the rate counts new lines only.
            if (backlog) {
              backlog = false;
              since0 = Date.now();
              continue;
            }
            received += lines.length;
            const elapsed = (Date.now() - since0) / 1000;
            if (running && elapsed >= 1) {
              report({ status: "live", ratePerSec: received / elapsed });
              received = 0;
              since0 = Date.now();
            }
          }
          const summary = await call.result;
          setTty(summary.tty);
          report(running ? { status: "ended", reason: "the container stopped" } : null);
        } catch (e) {
          if (cancelled) {
            report({ status: "ended", reason: "stopped" });
            return;
          }
          const d = note(e);
          if (d.code === "Cancelled") report({ status: "ended", reason: "stopped" });
          else {
            setError(d);
            report({ status: "ended", reason: d.title });
          }
        } finally {
          if (run.current && cancelled) run.current = null;
        }
      })();
    },
    [client, connId, container, note, report, running, since, tail],
  );

  // A new container, connection, tail or since: the log again from the start.
  useEffect(() => {
    start(false);
    return () => run.current?.cancel();
  }, [start]);
  useEffect(() => () => onLive(null), [onLive]);

  // The stream filter redraws from what was received.
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    viewer.current?.clear();
    viewer.current?.append(pickStream(all.current.slice(-MAX_LOG_LINES), stream).map(toViewer));
  }, [stream]);

  const stop = () => run.current?.cancel();
  const resume = () => start(true);
  useTabActions({ stop, refresh: () => start(false), find: () => viewer.current?.openSearch() });

  const download = (text: string) => {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${container}.log`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const streaming = live?.status === "live";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="Log options" className="pb-stack-sm">
        {tty ? (
          <span className="text-body-1 text-fg-muted">TTY: one stream, stdout and stderr together</span>
        ) : (
          <ToggleGroup aria-label="Streams" size="small" value={[stream]} onValueChange={(v) => v[0] && setStream(v[0] as StreamChoice)}>
            <ToggleGroupItem value="all">All</ToggleGroupItem>
            <ToggleGroupItem value="stdout">stdout</ToggleGroupItem>
            <ToggleGroupItem value="stderr">stderr</ToggleGroupItem>
          </ToggleGroup>
        )}
        <Select aria-label="Tail" size="small" items={TAILS} value={tail} onValueChange={(v) => setTail(v as Tail)} className="w-auto">
          {(Object.keys(TAILS) as Tail[]).map((t) => (
            <SelectItem key={t} value={t}>
              {TAILS[t]}
            </SelectItem>
          ))}
        </Select>
        <Select aria-label="Since" size="small" items={SINCES} value={since} onValueChange={(v) => setSince(v as Since)} className="w-auto">
          {(Object.keys(SINCES) as Since[]).map((s) => (
            <SelectItem key={s} value={s}>
              {SINCES[s]}
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
        {running ? (
          streaming ? (
            <Button appearance="subtle" size="small" onClick={stop}>
              <Icon icon={Stop} /> Stop
            </Button>
          ) : (
            <Button appearance="subtle" size="small" onClick={resume}>
              <Icon icon={Play} /> Resume
            </Button>
          )
        ) : null}
      </PageBar>
      {error ? (
        <div className="px-inset-lg pb-stack-sm">
          <ErrorState error={error} onRetry={resume} />
        </div>
      ) : null}
      <LogViewer
        ref={viewer}
        aria-label={`${container} logs`}
        maxLines={MAX_LOG_LINES}
        defaultFollow
        wrap={wrap}
        timestamps={timestamps}
        onDownload={download}
        emptyText={streaming ? "Waiting for the first line…" : "No lines."}
        className="min-h-0 flex-1 border-t border-border-subtle"
      />
    </div>
  );
}
