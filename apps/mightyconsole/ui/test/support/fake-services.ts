// An in-memory mightyconsole-server behind the generated API: app.info, app.events and the echo
// tool, enough to drive the shell in jsdom. Every call is recorded. `drop()` makes the server
// unreachable (the events subscription fails with Unavailable, app.info fails) until `restore()`;
// the handles of the lost connection are gone, as on the real server.
import { RpcError, type StreamCall, type Subscription } from "@byterygon/ambidex";
import type * as api from "@/gen/api";
import type { MightyClient, Services } from "@/app/client";
import { MemoryStorage, type AppStorage } from "@/profiles/storage";
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { ProgressBus } from "@/app/progress";

export interface FakeServer {
  calls: { procedure: string; input: unknown }[];
  /** Live handles by connId. */
  handles: Map<string, { greeting: string }>;
  down: boolean;
  /** How many ticks a ticks stream sends before it waits to be cancelled. */
  ticks: number;
  /** The next echo.connect waits for this promise (to test the connecting state). */
  connectGate: Promise<void> | null;
  /** What echo.messages.tail streams (§5.1 IPC chunks) and its summary (TSK-80). */
  messageChunks: Uint8Array[];
  produced: api.EchoProduceInput[];
  /** The profile each Docker handle connected with (TSK-81). */
  dockerProfiles: Map<string, api.ConnectDockerProfile>;
}

/** The key the fake Docker host presents (TSK-81). */
export const FAKE_HOST_KEY: api.HostKeyFingerprint = { algorithm: "ssh-ed25519", fingerprintSha256: "SHA256:q7Lw3Gm0bX9yT2vR8cKpN5sUe1JhAa4FzQ6dWiYoV0E" };

/** The fake Docker host's facts. */
export function fakeHostInfo(profile: api.ConnectDockerProfile): api.HostInfo {
  return {
    ssh: { target: `${profile.username}@${profile.host}:${profile.port ?? 22}`, hostKey: FAKE_HOST_KEY, socketPath: profile.socketPath ?? "/var/run/docker.sock", auth: profile.auth ?? "privateKey" },
    apiVersion: "1.47",
    serverApiVersion: "1.47",
    minApiVersion: "1.24",
    pingMs: 3,
    name: "build-host",
    operatingSystem: "Debian GNU/Linux 12 (bookworm)",
    osType: "linux",
    kernelVersion: "6.1.0-28-amd64",
    architecture: "x86_64",
    cpus: 8,
    memoryBytes: 33_600_000_000,
    serverVersion: "27.4.1",
    containerdVersion: "1.7.24",
    storageDriver: "overlay2",
    storageBackingFilesystem: "extfs",
    loggingDriver: "json-file",
    cgroupVersion: "2",
    cgroupDriver: "systemd",
    securityOptions: ["apparmor", "seccomp"],
    rootless: false,
    dockerRootDir: "/var/lib/docker",
    containers: 11,
    containersRunning: 7,
    containersPaused: 0,
    containersStopped: 4,
    images: 14,
    warnings: [],
  };
}

const unavailable = () => new RpcError("Unavailable", "connection closed", { retryable: true, local: true });

export function createFakeServices(storage: AppStorage = new MemoryStorage()) {
  const server: FakeServer = { calls: [], handles: new Map(), down: false, ticks: 3, connectGate: null, messageChunks: [], produced: [], dockerProfiles: new Map() };
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
        return { connId, greeting, schemaIssues: [] };
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
      messages: {
        tail: (input: api.EchoTailInput) => {
          record("echo.messages.tail", input);
          const chunks = server.messageChunks;
          let cancelled = false;
          return {
            chunks: async function* () {
              for (const c of chunks) {
                if (cancelled) return;
                yield c.slice();
              }
            },
            result: Promise.resolve({ scanned: 0, matched: 0, dropped: 0, decodeErrors: 0, endReason: "end", lastPositions: [] }),
            cancel: () => {
              cancelled = true;
            },
          } as unknown as StreamCall<api.TailSummary, Uint8Array>;
        },
        produce: async (input: api.EchoProduceInput) => {
          record("echo.messages.produce", input);
          server.produced.push(input);
          return { partition: input.partition ?? 0, offset: String(server.produced.length - 1), size: input.value.text.length };
        },
        get: async (input: api.EchoGetInput) => {
          record("echo.messages.get", input);
          return { partition: input.partition, offset: input.offset, payload: btoa("full"), size: 4 };
        },
      },
    },
    docker: {
      connect: async (input: api.DockerConnectInput) => {
        record("docker.connect", input);
        reachable();
        const trusted = input.profile.hostKey;
        if (trusted?.fingerprintSha256 !== FAKE_HOST_KEY.fingerprintSha256) {
          const changed = trusted != null;
          throw new RpcError("FailedPrecondition", changed ? "the host key of build-host changed" : "build-host is not trusted yet", {
            correlation_id: "corr-hk",
            details: { kind: "HostKey", system: "docker", message: "host key", retryable: false, hostKey: { state: changed ? "changed" : "unknown", ...FAKE_HOST_KEY, ...(changed ? { expected: trusted } : {}) } },
          });
        }
        const connId = `d${++ids}`;
        server.handles.set(connId, { greeting: "docker" });
        server.dockerProfiles.set(connId, input.profile);
        return { connId, host: fakeHostInfo(input.profile) };
      },
      disconnect: async (input: api.DockerConnIdInput) => {
        record("docker.disconnect", input);
        server.handles.delete(input.connId);
        return {};
      },
      host: {
        info: async (input: api.DockerConnIdInput) => {
          record("docker.host.info", input);
          const p = server.dockerProfiles.get(input.connId);
          if (!p) throw new RpcError("NotFound", "this connection is closed; connect again", { details: { kind: "NotFound", system: "docker", message: "gone", retryable: false, resource: "connection" } });
          return fakeHostInfo(p);
        },
      },
    },
    messaging: {
      filter: {
        check: async (input: api.FilterCheckInput) => {
          record("messaging.filter.check", input);
          return { ok: true, errors: [] };
        },
      },
      encode: async (input: api.EncodeInput) => {
        record("messaging.encode", input);
        return { bytes: btoa(input.payload.text), size: input.payload.text.length };
      },
      schemas: {
        inspect: async (input: api.InspectInput) => {
          record("messaging.schemas.inspect", input);
          return { type: "jsonschema", messageTypes: [], jsonSchema: {}, example: "{}", text: "", errors: [] };
        },
      },
    },
    $close: () => {},
  } as unknown as MightyClient;

  const services: Services = { client, storage, decoder: inThreadArrowDecoder(), progress: new ProgressBus() };
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
