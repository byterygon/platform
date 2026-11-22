// Loads one workflow run for its tab (Mightyconsole spec §9.3, §9.6.1): `describe`, the history
// page by page into a HistoryStore (outside React state, TSK-109), and, while the run is open, the
// history followed live through `followHistory`. The first page shows as soon as it arrives; the
// next ones load in the background up to AUTO_EVENTS, then as the views ask. Newest first reads
// the newest page first and follows at once; oldest first reads from event 1 and follows once the
// end is reached. The loaded events stay one run of ids without gaps or repeats; closing the tab,
// a disconnect or a refresh stops the stream. Not a component: the tab and its tests share it.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { liveTimeout, type MightyClient } from "@/app/client";
import { useActiveGate } from "@/app/while-active";
import * as api from "@/gen/api";
import type { HistoryEvent, WorkflowDetail } from "@/gen/api";
import type { DescribedError, LiveState } from "../types";
import { AUTO_EVENTS, HistoryStore } from "./history-store";

/** The order of History and the Timeline (TSK-109): newest first by default. */
export type HistoryOrder = "newest" | "oldest";

/** The most events a page may hold; the server also stops a page at 4 MiB (DOC-21 §9.6.1). */
const PAGE = 1000;

export interface WorkflowTarget {
  client: MightyClient;
  connId: string | null;
  namespace: string;
  workflowId: string;
  /** The latest run when absent. */
  runId?: string | undefined;
  note(error: unknown): DescribedError;
  onLive(live: LiveState | null): void;
  /**
   * The tab is shown (default true). A followed history keeps its stream while hidden but reads no
   * further chunk, so the server's credits run out and nothing is lost; it catches up when shown (TSK-107).
   * The background pages wait too.
   */
  active?: boolean;
  /** Which end the history is read from (default oldest first). */
  order?: HistoryOrder;
}

export interface WorkflowState {
  detail: WorkflowDetail | null;
  /** The loaded events; read it during render, `version` says when it changed. */
  store: HistoryStore;
  version: number;
  /** More history exists than was read (older newest first, newer oldest first). */
  hasMore: boolean;
  loading: boolean;
  /** A page beyond the first is being read. */
  loadingMore: boolean;
  error: DescribedError | null;
  /** The history is being followed. */
  following: boolean;
  /** Reads the next page, unless one is being read. */
  loadMore(): void;
  /** Reads pages until the event is loaded; false when the history has no such event. */
  loadUntil(eventId: number): Promise<boolean>;
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
  const order: HistoryOrder = target.order ?? "oldest";
  const gate = useActiveGate(target.active ?? true);
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [store, setStore] = useState(() => new HistoryStore(workflowId));
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [following, setFollowing] = useState(false);
  const version = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // A newer load (refresh, another run, another order) drops what an older one still brings.
  const generation = useRef(0);
  const stream = useRef<{ cancel(): void } | null>(null);
  const run = useRef<string>(runId ?? "");
  const current = useRef(store);
  const token = useRef<string | null>(null);
  const running = useRef(false);
  const reading = useRef<Promise<void> | null>(null);
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
      if (connId === null || stream.current) return;
      const s = current.current;
      const call = client.temporal.workflows.followHistory(
        { connId, namespace, workflowId, runId: run.current, fromEventId: s.hi, streamId: crypto.randomUUID() },
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
            // Hidden: leave the chunk and ask for no more until the tab is shown.
            await gate.idle();
            if (mine !== generation.current) return;
            const split = splitLines(carry, decoder.decode(chunk));
            carry = split.carry;
            // Added once, in order, without copying what is loaded (TSK-109).
            const added = s.append(split.lines.map((l) => JSON.parse(l) as HistoryEvent));
            if (added === 0) continue;
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
          if (stream.current === call) stream.current = null;
        }
      })();
    },
    [client, connId, namespace, workflowId, note, onLive, redescribe, gate],
  );

  /** Reads the next page into the store; one at a time. */
  const nextPage = useCallback(
    (mine: number): Promise<void> => {
      if (reading.current) return reading.current;
      if (connId === null || token.current === null) return Promise.resolve();
      setLoadingMore(true);
      const s = current.current;
      const page = (async () => {
        try {
          const out = await client.temporal.workflows.history({ connId, namespace, workflowId, runId: run.current, pageSize: PAGE, nextPageToken: token.current, reverse: order === "newest" });
          if (mine !== generation.current) return;
          if (order === "newest") s.prepend(out.events);
          else s.append(out.events);
          token.current = out.nextPageToken ?? null;
          setHasMore(token.current !== null);
          // Oldest first: the end is reached, so an open run is followed from here.
          if (order === "oldest" && token.current === null && running.current) follow(mine);
        } catch (e) {
          if (mine === generation.current) setError(note(e));
          throw e;
        } finally {
          reading.current = null;
          if (mine === generation.current) setLoadingMore(false);
        }
      })();
      reading.current = page;
      return page;
    },
    [client, connId, namespace, workflowId, order, follow, note],
  );

  const load = useCallback(async () => {
    if (connId === null) return;
    stop();
    const mine = ++generation.current;
    const s = new HistoryStore(workflowId);
    current.current = s;
    token.current = null;
    reading.current = null;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    setFollowing(false);
    try {
      const d = await client.temporal.workflows.describe({ connId, namespace, workflowId, runId: runId ?? null });
      if (mine !== generation.current) return;
      run.current = d.workflow.runId;
      running.current = d.workflow.status === "Running";
      const out = await client.temporal.workflows.history({ connId, namespace, workflowId, runId: run.current, pageSize: PAGE, nextPageToken: null, reverse: order === "newest" });
      if (mine !== generation.current) return;
      if (order === "newest") s.prepend(out.events);
      else s.append(out.events);
      token.current = out.nextPageToken ?? null;
      setDetail(d);
      setStore(s);
      setHasMore(token.current !== null);
      setLoading(false);
      if (running.current && (order === "newest" || token.current === null)) follow(mine);
      else if (!running.current) onLive(null);
      // The run's start (input, task queue, timeouts) when the newest page does not reach it.
      if (order === "newest" && s.lo > 1) {
        client.temporal.workflows.history({ connId, namespace, workflowId, runId: run.current, pageSize: 1, nextPageToken: null }).then(
          (first) => {
            if (mine === generation.current && first.events[0]) s.setFirst(first.events[0]);
          },
          () => undefined,
        );
      }
      // The next pages in the background, up to AUTO_EVENTS; waiting while the tab is hidden.
      while (token.current !== null && s.size < AUTO_EVENTS) {
        await gate.idle();
        if (mine !== generation.current) return;
        await nextPage(mine);
        if (mine !== generation.current) return;
      }
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, namespace, workflowId, runId, order, stop, follow, nextPage, note, onLive, gate]);

  const loadMore = useCallback(() => {
    void nextPage(generation.current).catch(() => undefined);
  }, [nextPage]);

  const loadUntil = useCallback(
    async (eventId: number) => {
      const mine = generation.current;
      const s = current.current;
      while (!s.get(eventId) && token.current !== null && mine === generation.current) {
        // Oldest first, pages bring newer events; newest first, older ones.
        if (order === "oldest" ? eventId < s.lo : eventId > s.hi) break;
        try {
          await nextPage(mine);
        } catch {
          return false;
        }
      }
      return s.get(eventId) !== undefined;
    },
    [nextPage, order],
  );

  useEffect(() => {
    void load();
    return stop;
  }, [load, stop]);

  return { detail, store, version, hasMore, loading, loadingMore, error, following, loadMore, loadUntil, refresh: () => void load() };
}
