// An in-memory mightyconsole-server behind the generated API: app.info, app.events and the echo
// tool, enough to drive the shell in jsdom. Every call is recorded. `drop()` makes the server
// unreachable (the events subscription fails with Unavailable, app.info fails) until `restore()`;
// the handles of the lost connection are gone, as on the real server.
import { RpcError, type StreamCall, type Subscription } from "@byterygon/ambidex";
import type * as api from "@/gen/api";
import type { MightyClient, Services } from "@/app/client";
import { MemoryStorage, type AppStorage } from "@/profiles/storage";

export interface FakeServer {
  calls: { procedure: string; input: unknown }[];
  /** Live handles by connId. */
  handles: Map<string, { greeting: string }>;
  down: boolean;
  /** How many ticks a ticks stream sends before it waits to be cancelled. */
  ticks: number;
  /** The next echo.connect waits for this promise (to test the connecting state). */
  connectGate: Promise<void> | null;
}

const unavailable = () => new RpcError("Unavailable", "connection closed", { retryable: true, local: true });

export function createFakeServices(storage: AppStorage = new MemoryStorage()) {
  const server: FakeServer = { calls: [], handles: new Map(), down: false, ticks: 3, connectGate: null };
  let ids = 0;
  let subscriber: { push(e: api.AppEvent): void; fail(e: unknown): void } | null = null;
  const record = (procedure: string, input: unknown) => server.calls.push({ procedure, input });
  const reachable = () => {
    if (server.down) throw unavailable();
  };

  const info = (): api.AppInfo => ({
    version: "0.1.0",
    apiVersion: "0.1.0",
    schemaHash: "sha256:test",
    listen: "127.0.0.1:7443",
    publicOrigin: "https://localhost:7443",
    certificateFingerprint: "AB:CD",
    os: "linux",
    tools: [{ id: "echo", version: "0.1.0" }],
    codecs: [],
  });

  function events(): Subscription<api.AppEvent> {
    const queue: api.AppEvent[] = [];
    let wake: (() => void) | null = null;
    let failure: unknown = null;
    let done = false;
    const me = {
      push(e: api.AppEvent) {
        queue.push(e);
        wake?.();
      },
      fail(e: unknown) {
        failure = e;
        wake?.();
      },
    };
    subscriber = me;
    return {
      unsubscribe() {
        done = true;
        wake?.();
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (failure !== null) throw failure;
          if (done) return;
          const next = queue.shift();
          if (next) {
            yield next;
            continue;
          }
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    };
  }

  function ticks(input: api.EchoTicksInput): StreamCall<api.EchoTicksSummary, Uint8Array> {
    let cancelled = false;
    let wake: (() => void) | null = null;
    let resolve!: (v: api.EchoTicksSummary) => void;
    let reject!: (e: unknown) => void;
    const result = new Promise<api.EchoTicksSummary>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    result.catch(() => {});
    const encoder = new TextEncoder();
    return {
      result,
      cancel() {
        cancelled = true;
        reject(new RpcError("Cancelled", "cancelled", { local: true }));
        wake?.();
      },
      async *chunks() {
        if (!server.handles.has(input.connId)) {
          const e = new RpcError("NotFound", "this connection is closed; connect again", { details: { kind: "NotFound", system: "echo", message: "gone", retryable: false, resource: "connection" } });
          reject(e);
          throw e;
        }
        let seq = 0;
        for (; seq < server.ticks; seq++) {
          if (cancelled) return;
          yield encoder.encode(`${JSON.stringify({ seq })}\n`);
        }
        await new Promise<void>((r) => (wake = r));
        if (input.count !== null && input.count !== undefined) resolve({ sent: seq });
      },
    };
  }

  const client = {
    app: {
      info: async () => {
        record("app.info", {});
        reachable();
        return info();
      },
      events: () => {
        record("app.events", {});
        return events();
      },
    },
    echo: {
      connect: async (input: api.EchoConnectInput) => {
        record("echo.connect", input);
        if (server.connectGate) await server.connectGate;
        reachable();
        if (input.profile.token === "wrong") throw new RpcError("Unauthenticated", "the token was rejected", { correlation_id: "corr-1", details: { kind: "Auth", system: "echo", message: "the token was rejected", retryable: false } });
        const connId = `conn-${++ids}`;
        const greeting = input.profile.greeting ?? `hello from ${input.profile.name}`;
        server.handles.set(connId, { greeting });
        return { connId, greeting };
      },
      disconnect: async (input: api.EchoConnIdInput) => {
        record("echo.disconnect", input);
        reachable();
        server.handles.delete(input.connId);
        subscriber?.push({ kind: "ConnectionStatus", tool: "echo", connId: input.connId, status: "closed" });
        return {};
      },
      ping: async (input: api.EchoPingInput) => {
        record("echo.ping", input);
        reachable();
        const handle = server.handles.get(input.connId);
        if (!handle) throw new RpcError("NotFound", "this connection is closed; connect again", { details: { kind: "NotFound", system: "echo", message: "gone", retryable: false, resource: "connection" } });
        return { greeting: handle.greeting, text: input.text };
      },
      ticks: (input: api.EchoTicksInput) => {
        record("echo.ticks", input);
        return ticks(input);
      },
    },
    $close: () => {},
  } as unknown as MightyClient;

  const services: Services = { client, storage };
  return {
    services,
    server,
    storage,
    /** Pushes an event to the page's subscription. */
    emit(event: api.AppEvent) {
      subscriber?.push(event);
    },
    /** The server goes away: the subscription fails, the handles are released. */
    drop() {
      server.down = true;
      server.handles.clear();
      subscriber?.fail(unavailable());
      subscriber = null;
    },
    restore() {
      server.down = false;
    },
  };
}
