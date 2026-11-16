// An in-memory DBee core behind the generated API: enough of spec §5 for the screens to be driven
// end to end in jsdom (prepare, create, list, open sessions, schema, classify, execute as Arrow
// IPC, export, events). Every call is recorded; errors are injected per procedure.
import { RpcError, type StreamCall, type Subscription } from "@byterygon/ambidex";
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { Table, tableFromArrays, tableToIPC } from "apache-arrow";
import type * as api from "@/gen/api";
import type { DbeeClient, Services } from "@/app/client";

export interface FakeState {
  connections: api.ConnectionSummary[];
  secrets: Record<string, boolean>;
  sessions: Record<string, { connectionId: string; purpose: api.SessionPurpose }>;
  calls: { procedure: string; input: unknown }[];
  /** Thrown by the named procedure on its next call. */
  failNext: Partial<Record<keyof api.Procedures, RpcError>>;
  /** Rows the fake returns for any select. */
  rows: number;
  events: ((event: api.AppEvent) => void)[];
  resolved: string[];
}

export const PREVIEW_DIGEST = "sha256:preview";

let ids = 0;
const id = (p: string) => `${p}-${++ids}`;

function digest(draft: api.ConnectionDraft): string {
  return `${PREVIEW_DIGEST}-${draft.host}:${draft.port ?? 5432}`;
}

/** Arrow IPC chunks of `rows` rows: schema, one batch, end of stream. */
export function sampleIpc(rows: number): Uint8Array[] {
  const table = tableFromArrays({
    id: BigInt64Array.from(Array.from({ length: rows }, (_, i) => BigInt(i + 1))),
    name: Array.from({ length: rows }, (_, i) => (i % 3 === 1 ? null : `row ${i + 1}`)),
    active: Array.from({ length: rows }, (_, i) => i % 2 === 0),
  });
  const bytes = tableToIPC(table, "stream");
  // Two chunks like the driver sends them: the schema message first, then the rest. An IPC
  // message is a 0xFFFFFFFF continuation, an int32 metadata length, the metadata (padded to 8).
  const metadata = new DataView(bytes.buffer, bytes.byteOffset).getInt32(4, true);
  const cut = 8 + metadata;
  return [bytes.subarray(0, cut), bytes.subarray(cut)];
}

/** The stream of a statement without a result set: an empty schema, nothing else (the driver's NoData). */
export function emptyIpc(): Uint8Array[] {
  return [tableToIPC(new Table(), "stream")];
}

function stream<T>(chunks: Uint8Array[], result: T, delayMs = 0, signal?: AbortSignal): StreamCall<T, Uint8Array> {
  let cancelled = false;
  let wake: (() => void) | undefined;
  let resolveResult!: (v: T) => void;
  let rejectResult!: (e: unknown) => void;
  const resultPromise = new Promise<T>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });
  resultPromise.catch(() => {});
  const call: StreamCall<T, Uint8Array> = {
    async *chunks() {
      for (const chunk of chunks) {
        if (cancelled) return;
        yield chunk;
        // The delay sits after the schema chunk, like a slow statement whose rows never come.
        if (delayMs) {
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, delayMs);
          });
          if (cancelled) return;
        }
      }
      if (!cancelled) resolveResult(result);
    },
    result: resultPromise,
    cancel() {
      if (cancelled) return;
      cancelled = true;
      rejectResult(new RpcError("Cancelled", "cancelled", { local: true, correlation_id: "corr-cancel" }));
      wake?.();
    },
  };
  // As the runtime does: aborting the call's signal cancels it.
  signal?.addEventListener("abort", () => call.cancel());
  return call;
}

function subscription<E>(state: FakeState): Subscription<E> {
  const queue: E[] = [];
  let wake: (() => void) | null = null;
  let closed = false;
  const push = (e: E) => {
    queue.push(e);
    wake?.();
  };
  state.events.push(push as (event: api.AppEvent) => void);
  return {
    unsubscribe() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (!closed) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
}

export function createFakeServices(overrides: Partial<FakeState> = {}): Services & { state: FakeState; emit: (event: api.AppEvent) => void } {
  const state: FakeState = {
    connections: [],
    secrets: {},
    sessions: {},
    calls: [],
    failNext: {},
    rows: 5,
    events: [],
    resolved: ["127.0.0.1"],
    ...overrides,
  };
  const record = <K extends keyof api.Procedures>(procedure: K, input: unknown) => {
    state.calls.push({ procedure, input });
    const fail = state.failNext[procedure];
    if (fail) {
      delete state.failNext[procedure];
      throw fail;
    }
  };
  const info: api.AppInfo = {
    version: "0.0.0-test",
    apiVersion: "0.0.0",
    schemaHash: "sha256:test",
    mode: "standalone",
    platform: "linux",
    drivers: [{ id: "com.byterygon.dbee.postgres", name: "PostgreSQL", version: "0.0.0", digest: "sha256:driver", firstParty: true }],
    secretStore: "keychain",
    secretStoreNote: null,
    workspacePath: "/tmp/dbee/workspace",
    auditLogPath: "/tmp/dbee/workspace/audit/log.jsonl",
  };
  const client: DbeeClient = {
    app: {
      info: async (input) => {
        record("app.info", input);
        return info;
      },
      events: (input) => {
        record("app.events", input);
        return subscription<api.AppEvent>(state);
      },
    },
    connections: {
      list: async (input) => {
        record("connections.list", input);
        return state.connections;
      },
      prepare: async (draft) => {
        record("connections.prepare", draft);
        if (draft.host.trim() === "") throw new RpcError("InvalidArgument", "host", { details: { kind: "InvalidTarget", field: "host", message: "must not be empty" }, correlation_id: "corr-1" });
        const preview: api.GrantPreview = {
          driver: info.drivers[0]!,
          template: "db-transport",
          host: draft.host,
          port: draft.port ?? 5432,
          resolvedAddresses: state.resolved,
          proposedAddresses: draft.allowedAddresses ?? state.resolved.map((a) => (a.includes(":") ? `${a}/128` : `${a}/32`)),
          tls: { kind: draft.tls.kind, serverName: draft.tls.kind === "plaintext" ? null : draft.host, pinned: draft.tls.kind === "pinned-cert" ? [draft.tls.fingerprint] : [] },
          allowCancelConnection: draft.allowCancelConnection ?? true,
          expiresAt: draft.expiresAt ?? null,
          secretBinding: draft.hasSecret ?? false,
          approver: "human:local:tester",
          previewDigest: digest(draft),
        };
        return preview;
      },
      create: async (input) => {
        record("connections.create", input);
        if (input.previewDigest !== digest(input.draft)) throw new RpcError("FailedPrecondition", "stale", { details: { kind: "PreviewStale" }, correlation_id: "corr-stale" });
        const existing = input.replaces ? state.connections.find((c) => c.id === input.replaces) : undefined;
        const summary: api.ConnectionSummary = {
          id: existing?.id ?? id("conn"),
          name: input.draft.name,
          description: input.draft.description ?? null,
          colour: input.draft.colour ?? null,
          driver: info.drivers[0]!.id,
          host: input.draft.host,
          port: input.draft.port ?? 5432,
          database: input.draft.database,
          user: input.draft.user,
          tls: input.draft.tls.kind,
          hasSecret: input.secret !== null && input.secret !== undefined ? true : (input.draft.hasSecret ?? false),
          allowCancelConnection: input.draft.allowCancelConnection ?? true,
          status: "disconnected",
          grant: { id: id("grant"), state: "active", expiresAt: input.draft.expiresAt ?? null, createdAt: Date.now() },
        };
        state.connections = [...state.connections.filter((c) => c.id !== summary.id), summary];
        if (input.secret) state.secrets[summary.id] = true;
        return summary;
      },
      update: async (input) => {
        record("connections.update", input);
        const c = state.connections.find((x) => x.id === input.id);
        if (!c) throw new RpcError("NotFound", "no such connection", { details: { kind: "NotFound" }, correlation_id: "corr-nf" });
        const updated: api.ConnectionSummary = { ...c, name: input.name ?? c.name, description: input.description === "" ? null : (input.description ?? c.description), colour: input.colour === "" ? null : (input.colour ?? c.colour) };
        state.connections = state.connections.map((x) => (x.id === c.id ? updated : x));
        return updated;
      },
      setSecret: async (input) => {
        record("connections.setSecret", input);
        state.secrets[input.id] = input.password !== null;
        state.connections = state.connections.map((c) => (c.id === input.id ? { ...c, hasSecret: input.password !== null } : c));
        return { hasSecret: input.password !== null };
      },
      delete: async (input) => {
        record("connections.delete", input);
        state.connections = state.connections.filter((c) => c.id !== input.id);
        for (const [sid, s] of Object.entries(state.sessions)) if (s.connectionId === input.id) delete state.sessions[sid];
        return {};
      },
    },
    sessions: {
      open: async (input) => {
        record("sessions.open", input);
        const c = state.connections.find((x) => x.id === input.connectionId);
        if (!c) throw new RpcError("NotFound", "no such connection", { details: { kind: "NotFound" }, correlation_id: "corr-nf" });
        const sessionId = id("session");
        state.sessions[sessionId] = { connectionId: input.connectionId, purpose: input.purpose };
        return { sessionId, serverVersion: "16.1 (fake)" };
      },
      close: async (input) => {
        record("sessions.close", input);
        delete state.sessions[input.sessionId];
        return {};
      },
    },
    schema: {
      schemas: async (input) => {
        record("schema.schemas", input);
        return ["public", "sales", "pg_catalog", "information_schema"];
      },
      tables: async (input) => {
        record("schema.tables", input);
        return input.schema === "public" ? [{ schema: "public", name: "orders", kind: "table" }, { schema: "public", name: "customers", kind: "table" }, { schema: "public", name: "order_totals", kind: "view" }] : [];
      },
      columns: async (input) => {
        record("schema.columns", input);
        return [{ name: "id", typeName: "int8", nullable: false }, { name: "name", typeName: "text", nullable: true }, { name: "created_at", typeName: "timestamptz", nullable: false }];
      },
    },
    query: {
      classify: async (input) => {
        record("query.classify", input);
        const first = input.sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "";
        const risk: api.SqlRisk = /^(DROP|TRUNCATE)$/.test(first) ? "Destructive" : /^(SELECT|WITH|SHOW|EXPLAIN|VALUES|TABLE)$/.test(first) ? "Read" : "Write";
        return { risk, statements: input.sql.split(";").filter((s) => s.trim()).length, kind: first === "DROP" ? "DROP TABLE" : first };
      },
      execute: (input, opts) => {
        record("query.execute", input);
        if (!state.sessions[input.sessionId]) throw new RpcError("NotFound", "no session", { details: { kind: "NotFound" }, correlation_id: "corr-ns" });
        if (/syntax error/i.test(input.sql)) {
          const error = new RpcError("InvalidArgument", 'syntax error at or near "error"', { details: { kind: "Syntax", message: 'syntax error at or near "error"', position: 8, sqlstate: "42601" }, correlation_id: "corr-syntax" });
          const result = Promise.reject<api.ExecuteSummary>(error);
          result.catch(() => {});
          return {
            async *chunks() {
              throw error;
            },
            result,
            cancel() {},
          };
        }
        if (/^\s*update/i.test(input.sql)) return stream<api.ExecuteSummary>(emptyIpc(), { rowsAffected: 42, rowsReturned: null, elapsedMs: 12, notices: [], truncated: false, statementKind: "UPDATE", risk: "Write" });
        const slow = /pg_sleep/i.test(input.sql);
        const rows = input.maxRows !== null && input.maxRows !== undefined ? Math.min(state.rows, input.maxRows) : state.rows;
        return stream<api.ExecuteSummary>(sampleIpc(rows), { rowsAffected: null, rowsReturned: rows, elapsedMs: 7, notices: rows > 3 ? ["NOTICE: fake"] : [], truncated: rows < state.rows, statementKind: "SELECT", risk: "Read" }, slow ? 5_000 : 0, opts?.signal);
      },
    },
    export: {
      run: (input) => {
        record("export.run", input);
        const text = input.format === "jsonl" ? '{"id":1}\n{"id":2}\n' : `id${input.format === "csv" ? "," : "\t"}name\n1${input.format === "csv" ? "," : "\t"}a\n`;
        const bytes = new TextEncoder().encode(text);
        return stream<api.ExportSummary>([bytes], { rows: 2, bytes: bytes.length, path: input.destination.kind === "file" ? "/tmp/out.csv" : null });
      },
    },
    files: {
      chooseSavePath: async (input) => {
        record("files.chooseSavePath", input);
        return { handle: "handle-1", displayName: input.suggestedName };
      },
    },
  };
  return {
    client,
    decoder: inThreadArrowDecoder(),
    state,
    emit: (event) => {
      for (const push of state.events) push(event);
    },
  };
}
