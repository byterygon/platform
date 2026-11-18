// Loads one workflow run for its tab (Mightyconsole spec §9.3): `describe`, the history page by
// page, and, while the run is open, the history followed live through `followHistory`. The events
// are kept in order without gaps or repeats; closing the tab, a disconnect or a refresh stops the
// stream. Not a component: the tab and its tests share it.
import { useCallback, useEffect, useRef, useState } from "react";
import { liveTimeout, type MightyClient } from "@/app/client";
import * as api from "@/gen/api";
import type { HistoryEvent, WorkflowDetail } from "@/gen/api";
import type { DescribedError, LiveState } from "../types";

/** Pages read on their own before "Load more events" (1,000 events each). */
export const AUTO_PAGES = 10;

export interface WorkflowTarget {
  client: MightyClient;
  connId: string | null;
  namespace: string;
  workflowId: string;
  /** The latest run when absent. */
  runId?: string | undefined;
  note(error: unknown): DescribedError;
  onLive(live: LiveState | null): void;
}

export interface WorkflowState {
  detail: WorkflowDetail | null;
  events: HistoryEvent[];
  /** More history exists than was read. */
  hasMore: boolean;
  loading: boolean;
  error: DescribedError | null;
  /** The history is being followed. */
  following: boolean;
  loadMore(): void;
  refresh(): void;
}

/** One `jsonl` chunk's lines, with a partial line carried to the next chunk. */
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const parts = (carry + chunk).split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts.filter((l) => l.trim() !== ""), carry: rest };
}

export function useWorkflow(target: WorkflowTarget): WorkflowState {
  const { client, connId, namespace, workflowId, runId, note, onLive } = target;
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [following, setFollowing] = useState(false);
  // A newer load (refresh, another run) drops what an older one still brings.
  const generation = useRef(0);
  const stream = useRef<{ cancel(): void } | null>(null);
  const run = useRef<string>(runId ?? "");
  const lastId = useRef(0);
  const describeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    stream.current?.cancel();
    stream.current = null;
    if (describeTimer.current) clearTimeout(describeTimer.current);
    describeTimer.current = null;
  }, []);

  const redescribe = useCallback(
    (mine: number) => {
      if (connId === null) return;
      client.temporal.workflows.describe({ connId, namespace, workflowId, runId: run.current || null }).then(
        (d) => {
          if (mine === generation.current) setDetail(d);
        },
        () => undefined,
      );
    },
    [client, connId, namespace, workflowId],
  );

  const follow = useCallback(
    (mine: number) => {
      if (connId === null) return;
      const call = client.temporal.workflows.followHistory(
        { connId, namespace, workflowId, runId: run.current, fromEventId: lastId.current, streamId: crypto.randomUUID() },
        liveTimeout(api.procedures.temporal.workflows.followHistory),
      );
      stream.current = call;
      setFollowing(true);
      onLive({ status: "live" });
      void (async () => {
        const decoder = new TextDecoder();
        let carry = "";
        try {
          for await (const chunk of call.chunks()) {
            if (mine !== generation.current) return;
            const split = splitLines(carry, decoder.decode(chunk));
            carry = split.carry;
            const fresh = split.lines.map((l) => JSON.parse(l) as HistoryEvent).filter((e) => e.eventId > lastId.current);
            if (fresh.length === 0) continue;
            lastId.current = fresh[fresh.length - 1]!.eventId;
            setEvents((prev) => [...prev, ...fresh]);
            // The pending activities and the status move with the history: ask again, once.
            if (describeTimer.current) clearTimeout(describeTimer.current);
            describeTimer.current = setTimeout(() => redescribe(mine), 400);
          }
          await call.result;
          if (mine !== generation.current) return;
          onLive({ status: "ended", reason: "run closed" });
          redescribe(mine);
        } catch (e) {
          if (mine !== generation.current) return;
          const described = note(e);
          if (described.code === "Cancelled") onLive({ status: "ended", reason: "stopped" });
          else {
            setError(described);
            onLive({ status: "ended", reason: described.title });
          }
        } finally {
          if (mine === generation.current) setFollowing(false);
          stream.current = null;
        }
      })();
    },
    [client, connId, namespace, workflowId, note, onLive, redescribe],
  );

  const load = useCallback(async () => {
    if (connId === null) return;
    stop();
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    setFollowing(false);
    try {
      const d = await client.temporal.workflows.describe({ connId, namespace, workflowId, runId: runId ?? null });
      if (mine !== generation.current) return;
      run.current = d.workflow.runId;
      const all: HistoryEvent[] = [];
      let next: string | null = null;
      for (let page = 0; page < AUTO_PAGES; page++) {
        const out: api.WorkflowHistoryOutput = await client.temporal.workflows.history({ connId, namespace, workflowId, runId: run.current, pageSize: 1000, nextPageToken: next });
        if (mine !== generation.current) return;
        all.push(...out.events);
        next = out.nextPageToken ?? null;
        if (next === null) break;
      }
      lastId.current = all.length > 0 ? all[all.length - 1]!.eventId : 0;
      setDetail(d);
      setEvents(all);
      setToken(next);
      if (next === null && d.workflow.status === "Running") follow(mine);
      else onLive(null);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, namespace, workflowId, runId, stop, follow, note, onLive]);

  const loadMore = useCallback(() => {
    if (connId === null || token === null) return;
    const mine = generation.current;
    client.temporal.workflows.history({ connId, namespace, workflowId, runId: run.current, pageSize: 1000, nextPageToken: token }).then(
      (out) => {
        if (mine !== generation.current) return;
        lastId.current = out.events.length > 0 ? out.events[out.events.length - 1]!.eventId : lastId.current;
        setEvents((prev) => [...prev, ...out.events]);
        setToken(out.nextPageToken ?? null);
        if (out.nextPageToken === undefined && detail?.workflow.status === "Running") follow(mine);
      },
      (e: unknown) => {
        if (mine === generation.current) setError(note(e));
      },
    );
  }, [client, connId, namespace, workflowId, token, detail, follow, note]);

  useEffect(() => {
    void load();
    return stop;
  }, [load, stop]);

  return { detail, events, hasMore: token !== null, loading, error, following, loadMore, refresh: () => void load() };
}
