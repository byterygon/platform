// What the screens do with the core (DBee spec §3.11 flows, §8 states): load and refresh
// connections, open sessions, browse the schema, run statements, export. Every call goes through
// the one client; every failure becomes a described error with its correlation id.
import { sourceFor } from "@byterygon/data-grid";
import type { Dispatch } from "react";
import type { ConnectionStatus, ConnectionSummary, ExecuteSummary } from "@/gen/api";
import { type Services, executeArrow } from "./client";
import { describeError } from "./messages";
import { type Action, type Run, type State, newId, tabOf } from "./store";

export interface Ctx {
  services: Services;
  state: State;
  dispatch: Dispatch<Action>;
}

export async function refreshConnections({ services, dispatch }: Ctx): Promise<ConnectionSummary[]> {
  try {
    const connections = await services.client.connections.list({});
    dispatch({ type: "connections", connections });
    for (const c of connections) dispatch({ type: "status", id: c.id, status: c.status });
    return connections;
  } catch (e) {
    dispatch({ type: "connectionsError", error: describeError(e) });
    return [];
  }
}

/** Opens a browser session for the tree (the status follows app.events; set it here too). */
export async function connect(ctx: Ctx, connectionId: string): Promise<boolean> {
  const { services, dispatch } = ctx;
  dispatch({ type: "status", id: connectionId, status: "connecting" });
  dispatch({ type: "connectError", id: connectionId, error: undefined });
  try {
    await services.client.sessions.open({ connectionId, purpose: "browser" });
    dispatch({ type: "status", id: connectionId, status: "connected" });
    dispatch({ type: "schemaForget", connectionId });
    void loadSchemas(ctx, connectionId);
    return true;
  } catch (e) {
    dispatch({ type: "status", id: connectionId, status: "error" });
    dispatch({ type: "connectError", id: connectionId, error: describeError(e, "connect") });
    return false;
  }
}

export async function loadSchemas(ctx: Ctx, connectionId: string): Promise<void> {
  ctx.dispatch({ type: "schemaLoading", connectionId, key: "" });
  try {
    const items = await ctx.services.client.schema.schemas({ connectionId });
    ctx.dispatch({ type: "schemas", connectionId, items });
  } catch (e) {
    ctx.dispatch({ type: "schemas", connectionId, error: describeError(e, "connect").title });
  }
}

export async function loadTables(ctx: Ctx, connectionId: string, schema: string): Promise<void> {
  ctx.dispatch({ type: "schemaLoading", connectionId, key: `t:${schema}` });
  try {
    const items = await ctx.services.client.schema.tables({ connectionId, schema });
    ctx.dispatch({ type: "tables", connectionId, schema, items });
  } catch (e) {
    ctx.dispatch({ type: "tables", connectionId, schema, error: describeError(e, "connect").title });
  }
}

export async function loadColumns(ctx: Ctx, connectionId: string, schema: string, table: string): Promise<void> {
  const key = `${schema}.${table}`;
  ctx.dispatch({ type: "schemaLoading", connectionId, key });
  try {
    const items = await ctx.services.client.schema.columns({ connectionId, schema, table });
    ctx.dispatch({ type: "columns", connectionId, key, items });
  } catch (e) {
    ctx.dispatch({ type: "columns", connectionId, key, error: describeError(e, "connect").title });
  }
}

/** A new query tab bound to `connectionId` with `sql`, made active. */
export function openTab(ctx: Ctx, connectionId: string | null, sql = ""): string {
  const id = newId();
  ctx.dispatch({ type: "openTab", tab: { id, connectionId, sql, maxRows: null } });
  return id;
}

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** The editor session of a tab, opened on the first run (Decision 10). */
async function sessionFor(ctx: Ctx, tabId: string): Promise<string> {
  const tab = tabOf(ctx.state, tabId);
  if (!tab) throw new Error("tab closed");
  if (tab.sessionId) return tab.sessionId;
  if (!tab.connectionId) throw new Error("no connection");
  const opened = await ctx.services.client.sessions.open({ connectionId: tab.connectionId, purpose: "editor" });
  ctx.dispatch({ type: "session", id: tabId, sessionId: opened.sessionId });
  ctx.dispatch({ type: "status", id: tab.connectionId, status: "connected" });
  return opened.sessionId;
}

export interface RunHandle {
  cancel: () => void;
  done: Promise<void>;
}

/** How often the run's row count reaches the store while streaming, in ms (the status line). */
const PROGRESS_INTERVAL_MS = 250;

/**
 * Runs `sql` in the tab. The decoded stream goes into the tab's run and the data grid pulls its
 * batches (spec §6): the grid's pull rate is the backpressure and its memory budget bounds what
 * the browser holds. Here the run follows the grid's source for the row count and the outcome.
 */
export function runStatement(ctx: Ctx, tabId: string, sql: string, getState: () => State): RunHandle {
  const { dispatch } = ctx;
  const startedAt = performance.now();
  const controller = new AbortController();
  let run: Run = { status: "running", startedAt, elapsedMs: 0, fields: [], rows: 0 };
  const update = (patch: Partial<Run>) => {
    run = { ...run, ...patch, elapsedMs: performance.now() - startedAt };
    dispatch({ type: "run", id: tabId, run });
  };
  update({});
  const done = (async () => {
    let sessionId: string;
    try {
      sessionId = await sessionFor(ctx, tabId);
    } catch (e) {
      update({ status: "error", error: describeError(e, "connect") });
      const tab = tabOf(getState(), tabId);
      if (tab?.connectionId) dispatch({ type: "connectError", id: tab.connectionId, error: describeError(e, "connect") });
      return;
    }
    const tab = tabOf(getState(), tabId);
    const stream = executeArrow(ctx.services, { sessionId, sql, maxRows: tab?.maxRows ?? null }, controller.signal);
    // The grid's source of this stream; subscribing here starts it even before the grid mounts.
    const source = sourceFor(stream);
    let reported = 0;
    let finished!: () => void;
    const sourceEnded = new Promise<void>((resolve) => (finished = resolve));
    const unsubscribe = source.subscribe(() => {
      const progress = source.progress;
      const now = performance.now();
      if (!source.live) finished();
      if (run.status !== "running") return;
      const paused = progress.state === "paused";
      if (paused || now - reported >= PROGRESS_INTERVAL_MS) {
        reported = now;
        update({ rows: progress.rows, note: paused ? `Loaded ${progress.rows.toLocaleString("en-US")} rows, scroll for more` : undefined });
      }
    });
    try {
      const fields = await stream.schema;
      update({ fields, stream });
      // The server's end can arrive before the grid took the last batches: wait for both.
      const [summary] = await Promise.all([stream.result, sourceEnded]);
      if (source.state === "error") {
        update({ status: "error", rows: source.index.rowCount, error: { title: "Could not decode the result", description: "The result is not an Arrow stream." } });
      } else update({ status: "done", summary, rows: source.index.rowCount, note: undefined });
    } catch (e) {
      const described = describeError(e, "run");
      const rows = source.index.rowCount;
      const cancelled = described.code === "Cancelled" || controller.signal.aborted;
      if (cancelled && source.state === "error" && !controller.signal.aborted) {
        // decodeArrow cancels the call when the bytes are not Arrow (spec §8, grid streaming).
        update({ status: "error", rows, error: { title: "Could not decode the result", description: "The result is not an Arrow stream." } });
      } else if (cancelled) {
        source.cancel();
        update({ status: "cancelled", rows, note: `Cancelled after ${((performance.now() - startedAt) / 1000).toFixed(1)} s, ${rows.toLocaleString("en-US")} rows kept` });
      } else {
        update({ status: "error", rows, error: described });
        if (described.code === "Unavailable" || described.remedy === "reconnect") dispatch({ type: "session", id: tabId, sessionId: null });
      }
    } finally {
      unsubscribe();
    }
  })();
  return { cancel: () => controller.abort(), done };
}

export function statusAfter(status: ConnectionStatus | undefined): string {
  switch (status) {
    case "connected":
      return "connected";
    case "connecting":
      return "connecting…";
    case "error":
      return "error";
    case "expired":
      return "expired";
    default:
      return "disconnected";
  }
}
