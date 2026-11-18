// A message stream as a live view (Mightyconsole spec §5.5): start, pause (the grid stops pulling,
// so no credit reaches the server), stop, restart from where it stopped, and the counters the
// server publishes once a second (rate, scanned, matched, dropped, decode errors).
import type { StreamCall } from "@byterygon/ambidex";
import { type ArrowStream, decodeArrow } from "@byterygon/ambidex/arrow";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Services } from "@/app/client";
import type { StreamProgressEvent } from "@/app/progress";
import type { LastPosition, TailSummary } from "@/gen/api";
import type { DescribedError, LiveState } from "@/tools/types";

export type TailStatus = "idle" | "live" | "paused" | "ended";

export interface LiveTail {
  status: TailStatus;
  /** The decoded stream of the current run (a new one per start). */
  stream: ArrowStream<TailSummary> | null;
  /** While true the grid holds: nothing is pulled. */
  hold: boolean;
  progress: StreamProgressEvent | null;
  summary: TailSummary | null;
  error: DescribedError | null;
  /** Starts a run; `resume` is where the last one stopped (Restart). */
  start(resume?: boolean): void;
  stop(): void;
  pause(): void;
  /** Where the view last was (MessageViewer reports it after every batch), for Restart after Stop. */
  remember(positions: readonly LastPosition[]): void;
}

/**
 * `open(streamId, resume)` makes the stream call (the tool's procedure with its decode options
 * and filter); `resume` is the last run's `lastPositions` when restarting.
 */
export function useLiveTail(
  services: Pick<Services, "decoder" | "progress">,
  open: ((streamId: string, resume: readonly LastPosition[] | null) => StreamCall<TailSummary, Uint8Array>) | null,
  note: (error: unknown) => DescribedError,
  onLive?: (live: LiveState | null) => void,
): LiveTail {
  const [status, setStatus] = useState<TailStatus>("idle");
  const [stream, setStream] = useState<ArrowStream<TailSummary> | null>(null);
  const [hold, setHold] = useState(false);
  const [progress, setProgress] = useState<StreamProgressEvent | null>(null);
  const [summary, setSummary] = useState<TailSummary | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const run = useRef<{ stream: ArrowStream<TailSummary>; unsubscribe: () => void } | null>(null);
  const last = useRef<readonly LastPosition[] | null>(null);
  const report = useRef(onLive);
  report.current = onLive;

  useEffect(() => {
    const p = progress;
    const live: LiveState | null =
      status === "idle"
        ? null
        : status === "ended"
          ? { status: "ended", ...(summary ? { reason: summary.endReason } : error ? { reason: error.title } : {}) }
          : { status, ...(p ? { ratePerSec: p.ratePerSec, dropped: p.dropped } : {}) };
    report.current?.(live);
  }, [status, progress, summary, error]);

  const start = useCallback(
    (resume = false) => {
      if (open === null || run.current !== null) return;
      const streamId = crypto.randomUUID();
      const call = open(streamId, resume ? last.current : null);
      last.current = null;
      const decoded = decodeArrow(call, services.decoder);
      const unsubscribe = services.progress.subscribe(streamId, setProgress);
      run.current = { stream: decoded, unsubscribe };
      setStream(decoded);
      setHold(false);
      setProgress(null);
      setSummary(null);
      setError(null);
      setStatus("live");
      decoded.result.then(
        (s) => {
          if (s.lastPositions.length > 0) last.current = s.lastPositions;
          setSummary(s);
        },
        (e: unknown) => {
          const d = note(e);
          if (d.code !== "Cancelled") setError(d);
        },
      ).finally(() => {
        unsubscribe();
        if (run.current?.stream === decoded) run.current = null;
        setStatus("ended");
        setHold(false);
      });
    },
    [open, services, note],
  );

  const stop = useCallback(() => run.current?.stream.cancel(), []);
  const pause = useCallback(() => {
    if (run.current === null) return;
    setHold((h) => {
      setStatus(h ? "live" : "paused");
      return !h;
    });
  }, []);

  // A run ends with the view.
  useEffect(() => () => run.current?.stream.cancel(), []);

  const remember = useCallback((positions: readonly LastPosition[]) => {
    last.current = positions;
  }, []);

  return { status, stream, hold, progress, summary, error, start, stop, pause, remember };
}
