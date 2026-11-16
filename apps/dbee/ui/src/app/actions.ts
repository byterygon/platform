// What the screens do with the core (DBee spec §3.11 flows, §8 states): load and refresh
// connections, open sessions, browse the schema, run statements, export. Every call goes through
// the one client; every failure becomes a described error with its correlation id.
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

/** The memory budget of the minimal table: rows kept in the browser (spec Decision 13, Open question 4). */
export const ROW_BUDGET = 200_000;

/** Runs `sql` in the tab: rows stream into the tab's run as Arrow batches arrive. */
export function runStatement(ctx: Ctx, tabId: string, sql: string, getState: () => State): RunHandle {
  const { dispatch } = ctx;
  const startedAt = performance.now();
  const controller = new AbortController();
  let run: Run = { status: "running", startedAt, elapsedMs: 0, fields: [], batches: [], rows: 0 };
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
    try {
      const fields = await stream.schema;
      update({ fields });
      for await (const batch of stream.batches()) {
        if (run.rows >= ROW_BUDGET) {
          // The budget pauses what the table keeps; the stream is cancelled, the rows stay.
          stream.cancel();
          update({ note: `Loaded ${run.rows.toLocaleString("en-US")} rows (memory budget); the rest was not fetched` });
          break;
        }
        update({ batches: [...run.batches, batch], rows: run.rows + batch.numRows });
      }
      const summary: ExecuteSummary = await stream.result;
      update({ status: "done", summary });
    } catch (e) {
      const described = describeError(e, "run");
      if (described.code === "Cancelled" || controller.signal.aborted) {
        update({ status: "cancelled", note: `Cancelled after ${((performance.now() - startedAt) / 1000).toFixed(1)} s, ${run.rows.toLocaleString("en-US")} rows kept` });
      } else if (run.note !== undefined && described.code === "Cancelled") {
        update({ status: "done" });
      } else {
        update({ status: "error", error: described });
        if (described.code === "Unavailable" || described.remedy === "reconnect") dispatch({ type: "session", id: tabId, sessionId: null });
      }
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
