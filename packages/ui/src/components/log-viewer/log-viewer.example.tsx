import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/button/button";
import { LogViewer, type LogLine, type LogViewerHandle } from "@/components/log-viewer/log-viewer";
import { ToggleButton } from "@/components/toggle-button/toggle-button";

const ESC = "\u001b";

/** The smallest useful LogViewer: a few lines appended through its ref. */
export function LogViewerMinimal() {
  const ref = useRef<LogViewerHandle>(null);
  useEffect(() => {
    ref.current?.append([{ text: "listening on :8080" }, { text: "GET /health 200 1ms" }]);
  }, []);
  return <LogViewer ref={ref} aria-label="api logs" timestamps={false} className="h-panel-xs" />;
}

/** A web service's log as Docker sends it: timestamps, stderr marked, ANSI levels. */
const SAMPLE: LogLine[] = [
  { ts: "2026-11-20T08:00:01.120458Z", stream: "stdout", text: `${ESC}[32mINFO${ESC}[0m  server listening on :8080` },
  { ts: "2026-11-20T08:00:01.402113Z", stream: "stdout", text: `${ESC}[32mINFO${ESC}[0m  connected to ${ESC}[1mpostgres${ESC}[22m at db:5432` },
  { ts: "2026-11-20T08:00:02.981374Z", stream: "stdout", text: `${ESC}[36mDEBUG${ESC}[0m GET /api/orders?status=PAID ${ESC}[2m(12 ms)${ESC}[0m` },
  { ts: "2026-11-20T08:00:03.004921Z", stream: "stderr", text: `${ESC}[33mWARN${ESC}[0m  slow query: SELECT * FROM orders WHERE status = 'PAID' (842 ms)` },
  { ts: "2026-11-20T08:00:04.551007Z", stream: "stderr", text: `${ESC}[1;31mERROR${ESC}[0m payment provider timed out for ${ESC}[4mord-1042${ESC}[24m after 3 attempts` },
  { ts: "2026-11-20T08:00:05.000000Z", stream: "stdout", text: `${ESC}[35mTRACE${ESC}[0m retry scheduled ${ESC}[3min 30 s${ESC}[23m` },
  { ts: "2026-11-20T08:00:05.120000Z", stream: "stdout", text: `${ESC}[34mINFO${ESC}[0m  ${ESC}[7m maintenance ${ESC}[27m window starts at 09:00` },
];

/** A container's Logs tab: follow, wrap and timestamps in a toolbar, more lines on demand, download. */
export function LogViewerRealistic() {
  const ref = useRef<LogViewerHandle>(null);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [timestamps, setTimestamps] = useState(true);
  const [downloaded, setDownloaded] = useState<number | null>(null);
  useEffect(() => {
    ref.current?.append(SAMPLE);
  }, []);
  const more = () => {
    const now = Date.now();
    ref.current?.append(Array.from({ length: 20 }, (_, i) => ({ ts: now + i, stream: i % 7 === 6 ? "stderr" : "stdout", text: `GET /api/orders/${1000 + i} 200 ${(i % 5) + 1} ms` })));
  };
  return (
    <div className="flex flex-col gap-stack-sm">
      <div className="flex flex-wrap items-center gap-inline-sm">
        <ToggleButton size="small" pressed={follow} onPressedChange={setFollow}>
          Follow
        </ToggleButton>
        <ToggleButton size="small" pressed={wrap} onPressedChange={setWrap}>
          Wrap
        </ToggleButton>
        <ToggleButton size="small" pressed={timestamps} onPressedChange={setTimestamps}>
          Timestamps
        </ToggleButton>
        <Button appearance="secondary" size="small" onClick={more}>
          Twenty more lines
        </Button>
        <Button appearance="subtle" size="small" onClick={() => ref.current?.openSearch()}>
          Search
        </Button>
      </div>
      <LogViewer
        ref={ref}
        aria-label="orders-api logs"
        follow={follow}
        onFollowChange={setFollow}
        wrap={wrap}
        timestamps={timestamps}
        onDownload={(text) => setDownloaded(text.split("\n").length)}
        className="h-panel-sm"
      />
      {downloaded === null ? null : <p className="text-caption-1 text-fg-muted">Downloaded {downloaded} lines.</p>}
      <LogViewer
        aria-label="shop project logs"
        streamColumn
        streamColors={{ web: "cat-1", worker: "cat-2", db: "cat-3" }}
        ref={(handle) => {
          if (handle && handle.lines().length === 0)
            handle.append([
              { ts: "2026-11-20T08:00:01Z", stream: "db", text: "database system is ready to accept connections" },
              { ts: "2026-11-20T08:00:02Z", stream: "web", text: "listening on :8080" },
              { ts: "2026-11-20T08:00:03Z", stream: "worker", text: "picked up job 17" },
            ]);
        }}
        className="h-panel-xs"
      />
    </div>
  );
}
