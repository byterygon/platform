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
  /** The Docker host's containers (TSK-81 batch 2b). */
  dockerContainers: api.ContainerRow[];
  /** Each container's log lines, by name. */
  dockerLogs: Map<string, { ts: string; stream: "stdout" | "stderr"; text: string }[]>;
  /** Containers whose logs stay open for pushed lines (as `follow` on a running one). */
  dockerFollow: Set<string>;
  /** Pushes `jsonl` lines to the open `docker.events` and followed logs streams (stats: `pushStats`). */
  dockerPush: { events: ((lines: object[]) => void)[]; logs: Map<string, ((lines: object[]) => void)[]> };
  /** Containers the next action refuses, with Docker's reason. */
  dockerRefuse: Map<string, string>;
  /** The samples `docker.containers.stats` sends first; more pushed through `dockerPush.stats`. */
  dockerStats: object[];
  /** The open exec: what was typed (decoded), its resizes; `exit(code)` ends it. */
  dockerExec: { input: string; resizes: { cols: number; rows: number }[]; output(text: string): void; exit(code: number): void } | null;
  /** The host's images, volumes and networks (TSK-81 batch 3); removes follow Docker's refusals. */
  dockerImages: api.ImageRow[];
  dockerVolumes: api.VolumeRow[];
  dockerNetworks: api.NetworkRow[];
  /** Why `/system/df` failed, to list the volumes without sizes. */
  dockerDfError: string | null;
}

/** The fake host's images: shop-api in use (two tags), an unused one, a digest-only one, a dangling one. */
export function fakeImages(): api.ImageRow[] {
  const image = (id: string, patch: Partial<api.ImageRow>): api.ImageRow => ({ id: `sha256:${id.padEnd(64, "0")}`, repoTags: [], repoDigests: [], created: 1795161000, size: 1000, dangling: false, labels: {}, usedBy: [], ...patch });
  return [
    image("a1", { repoTags: ["ghcr.io/acme/shop-api:2.4.1", "ghcr.io/acme/shop-api:latest"], size: 182_000_000, usedBy: [{ name: "shop-api-1", state: "running" }, { name: "migrate-7f3a", state: "created" }] }),
    image("b2", { repoTags: ["alpine:3.21"], size: 7_800_000, usedBy: [{ name: "nightly-backup", state: "exited" }] }),
    image("c3", { repoTags: ["registry.lan:5000/tools/jq:1.7"], size: 3_100_000 }),
    image("d4", { repoDigests: ["busybox@sha256:a7db"], size: 4_400_000 }),
    image("e5", { dangling: true, size: 412_000_000 }),
  ];
}

export function fakeVolumes(): api.VolumeRow[] {
  const volume = (name: string, patch: Partial<api.VolumeRow>): api.VolumeRow => ({ name, driver: "local", scope: "local", mountpoint: `/var/lib/docker/volumes/${name}/_data`, labels: {}, usedBy: [], ...patch });
  return [
    volume("shop_pgdata", { size: 1_900_000_000, project: "shop", labels: { "com.docker.compose.project": "shop" }, usedBy: [{ name: "shop-db-1", state: "running" }] }),
    volume("backup-cache", { size: 20_000_000, usedBy: [{ name: "nightly-backup", state: "exited" }] }),
    volume("old-cache", { size: 740_000_000 }),
  ];
}

export function fakeNetworks(): api.NetworkRow[] {
  const network = (name: string, patch: Partial<api.NetworkRow>): api.NetworkRow => ({ id: `${name}-id`, name, driver: "bridge", scope: "local", internal: false, attachable: false, ipv6: false, subnets: [], labels: {}, builtIn: false, usedBy: [], ...patch });
  return [
    network("bridge", { builtIn: true, subnets: [{ subnet: "172.17.0.0/16", gateway: "172.17.0.1" }] }),
    network("host", { builtIn: true, driver: "host" }),
    network("none", { builtIn: true, driver: "null" }),
    network("shop_default", { subnets: [{ subnet: "172.18.0.0/16", gateway: "172.18.0.1" }], project: "shop", usedBy: [{ name: "shop-api-1", state: "running" }] }),
    network("batch", { subnets: [{ subnet: "172.20.0.0/16" }], usedBy: [{ name: "nightly-backup", state: "exited" }] }),
  ];
}

/** A container row as the fake host lists it. */
export function fakeContainer(name: string, patch: Partial<api.ContainerRow> = {}): api.ContainerRow {
  return {
    id: `${name.replace(/[^a-z0-9]/g, "")}${"0".repeat(64)}`.slice(0, 64),
    name,
    image: "busybox:1.37",
    imageId: "sha256:b",
    command: "sh",
    created: 1795161601,
    state: "running",
    status: "Up 3 hours",
    ports: [],
    labels: {},
    ...patch,
  };
}

/** The fake host's containers: the project shop, a stopped one, a TTY one. */
export function fakeContainers(): api.ContainerRow[] {
  const shop = (service: string, patch: Partial<api.ContainerRow> = {}) =>
    fakeContainer(`shop-${service}-1`, {
      project: "shop",
      service,
      labels: { "com.docker.compose.project": "shop", "com.docker.compose.service": service, "com.docker.compose.project.working_dir": "/srv/shop" },
      ...patch,
    });
  return [
    shop("web", { status: "Up 3 hours (healthy)", health: "healthy", ports: [{ privatePort: 8080, protocol: "tcp", ip: "127.0.0.1", publicPort: 18080 }] }),
    shop("worker", { state: "restarting", status: "Restarting (1) 12 seconds ago" }),
    fakeContainer("stopped", { state: "exited", status: "Exited (3) 2 hours ago", exitCode: 3 }),
    fakeContainer("tty"),
  ];
}

/** `docker inspect` of a fake container, with the Overview read from it. */
export function fakeInspect(row: api.ContainerRow): api.ContainerInspectOutput {
  const overview: api.ContainerOverview = {
    id: row.id,
    name: row.name,
    image: row.image,
    imageId: row.imageId,
    created: "2026-11-20T07:00:00Z",
    state: row.state,
    running: row.state === "running",
    paused: row.state === "paused",
    restarting: row.state === "restarting",
    ...(row.state === "running" ? { startedAt: "2026-11-20T07:00:01Z" } : { startedAt: "2026-11-20T07:00:01Z", finishedAt: "2026-11-20T07:00:02Z", exitCode: row.exitCode ?? 0 }),
    oomKilled: false,
    restartCount: 0,
    restartPolicy: "unless-stopped",
    command: ["sh", "-c", "echo hi; sleep 1000"],
    entrypoint: [],
    workingDir: "/app",
    user: "app",
    tty: row.name === "tty",
    env: [
      { name: "LOG_LEVEL", value: "info" },
      { name: "STRIPE_API_KEY", value: "sk_test_hidden" },
    ],
    labels: row.labels,
    mounts: [{ kind: "volume", name: "shop_media", source: "/var/lib/docker/volumes/shop_media/_data", destination: "/app/media", readWrite: true }],
    networks: [{ name: "shop_default", ipAddress: "172.20.0.4", gateway: "172.20.0.1", aliases: [] }],
    ports: [{ port: "8080/tcp", published: ["127.0.0.1:18080"] }],
    ...(row.health ? { health: { status: row.health, failingStreak: 0, test: ["CMD-SHELL", "wget -qO- localhost:8080"], intervalSec: 10, log: [{ start: "2026-11-20T08:00:00Z", end: "2026-11-20T08:00:00.1Z", exitCode: 0, output: "ok" }] } } : {}),
    ...(row.project ? { project: row.project } : {}),
    ...(row.service ? { service: row.service } : {}),
  };
  return { overview, inspect: { Id: row.id, Name: `/${row.name}`, Config: { Env: overview.env.map((e) => `${e.name}=${e.value}`) } } };
}

/**
 * A `jsonl` stream call: `first` as one chunk, then (when `pushers` is given) more lines pushed by
 * the test until it is cancelled, else the summary.
 */
function jsonlCall<T>(first: readonly object[], summary: T, pushers?: ((lines: object[]) => void)[]): StreamCall<T, Uint8Array> {
  const encoder = new TextEncoder();
  const encode = (lines: readonly object[]) => encoder.encode(lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
  const queue: Uint8Array[] = first.length > 0 ? [encode(first)] : [];
  let wake: (() => void) | null = null;
  let cancelled = false;
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const result = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  result.catch(() => {});
  const push = (lines: object[]) => {
    queue.push(encode(lines));
    wake?.();
  };
  pushers?.push(push);
  return {
    result,
    cancel() {
      cancelled = true;
      if (pushers) pushers.splice(pushers.indexOf(push), 1);
      reject(new RpcError("Cancelled", "cancelled", { local: true }));
      wake?.();
    },
    async *chunks() {
      for (;;) {
        if (cancelled) return;
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (!pushers) break;
        await new Promise<void>((r) => (wake = r));
        wake = null;
      }
      resolve(summary);
    },
  } as unknown as StreamCall<T, Uint8Array>;
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
  const server: FakeServer = {
    calls: [],
    handles: new Map(),
    down: false,
    ticks: 3,
    connectGate: null,
    messageChunks: [],
    produced: [],
    dockerProfiles: new Map(),
    dockerContainers: fakeContainers(),
    dockerLogs: new Map(),
    dockerFollow: new Set(),
    dockerPush: { events: [], logs: new Map() },
    dockerRefuse: new Map(),
    dockerStats: [],
    dockerExec: null,
    dockerImages: fakeImages(),
    dockerVolumes: fakeVolumes(),
    dockerNetworks: fakeNetworks(),
    dockerDfError: null,
  };
  const statsPushers: ((lines: object[]) => void)[] = [];
  const dockerGone = () => new RpcError("NotFound", "this connection is closed; connect again", { details: { kind: "NotFound", system: "docker", message: "gone", retryable: false, resource: "connection" } });
  const dockerHandle = (connId: string) => {
    if (!server.dockerProfiles.has(connId)) throw dockerGone();
  };
  const dockerRow = (id: string) => {
    const row = server.dockerContainers.find((r) => r.name === id || r.id === id);
    if (!row) throw new RpcError("NotFound", `No such container: ${id}`, { details: { kind: "NotFound", system: "docker", message: `No such container: ${id}`, retryable: false, resource: "container" } });
    return row;
  };
  const dockerAct = (procedure: string, input: { connId: string; ids: string[] }, change: (row: api.ContainerRow) => void): api.ContainerActionResult[] => {
    record(procedure, input);
    dockerHandle(input.connId);
    return input.ids.map((id) => {
      const refused = server.dockerRefuse.get(id);
      if (refused) return { id, error: refused };
      const row = server.dockerContainers.find((r) => r.id === id || r.name === id);
      if (!row) return { id, error: `No such container: ${id}` };
      change(row);
      return { id };
    });
  };
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
    term: {
      write: async (input: api.TermWriteInput) => {
        record("term.write", input);
        const exec = server.dockerExec;
        if (!exec) throw new RpcError("NotFound", "this terminal has ended", { details: { kind: "NotFound", system: "term", message: "ended", retryable: false, resource: "terminal" } });
        exec.input += new TextDecoder().decode(Uint8Array.from(atob(input.data), (c) => c.charCodeAt(0)));
        return {};
      },
      resize: async (input: api.TermResizeInput) => {
        record("term.resize", input);
        server.dockerExec?.resizes.push({ cols: input.cols, rows: input.rows });
        return {};
      },
      signal: async (input: api.TermSignalInput) => {
        record("term.signal", input);
        return {};
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
      images: {
        list: async (input: api.ImagesListInput) => {
          record("docker.images.list", input);
          dockerHandle(input.connId);
          return server.dockerImages.map((i) => ({ ...i }));
        },
        inspect: async (input: api.ImageRefInput) => {
          record("docker.images.inspect", input);
          dockerHandle(input.connId);
          const image = server.dockerImages.find((i) => i.id === input.id || i.repoTags.includes(input.id));
          if (!image) throw new RpcError("NotFound", `No such image: ${input.id}`, { details: { kind: "NotFound", system: "docker", message: `No such image: ${input.id}`, retryable: false, resource: "image" } });
          return { inspect: { Id: image.id, RepoTags: image.repoTags, Size: image.size } };
        },
        remove: async (input: api.ImagesRemoveInput) => {
          record("docker.images.remove", input);
          dockerHandle(input.connId);
          return input.ids.map((id): api.ImageRemoveResult => {
            const image = server.dockerImages.find((i) => i.id === id || i.repoTags.includes(id));
            if (!image) return { id, untagged: [], deleted: [], error: `No such image: ${id}` };
            if (image.usedBy.some((u) => u.state === "running")) return { id, untagged: [], deleted: [], error: `conflict: unable to delete ${id} (cannot be forced) - image is being used by running container` };
            if (image.repoTags.includes(id) && image.repoTags.length > 1) {
              image.repoTags = image.repoTags.filter((t) => t !== id);
              return { id, untagged: [id], deleted: [] };
            }
            if (image.usedBy.length > 0 && !input.force) return { id, untagged: [], deleted: [], error: `conflict: unable to delete ${id} (must be forced) - image is being used by stopped container` };
            server.dockerImages = server.dockerImages.filter((i) => i !== image);
            return { id, untagged: image.repoTags, deleted: [image.id] };
          });
        },
      },
      volumes: {
        list: async (input: api.VolumesListInput) => {
          record("docker.volumes.list", input);
          dockerHandle(input.connId);
          const volumes = server.dockerVolumes.map((v) => {
            const copy = { ...v };
            if (server.dockerDfError !== null) delete copy.size;
            return copy;
          });
          return { volumes, ...(server.dockerDfError !== null ? { sizeError: server.dockerDfError } : {}) };
        },
        inspect: async (input: api.VolumeNameInput) => {
          record("docker.volumes.inspect", input);
          dockerHandle(input.connId);
          return { inspect: { Name: input.name, Driver: "local" } };
        },
        remove: async (input: api.VolumesRemoveInput) => {
          record("docker.volumes.remove", input);
          dockerHandle(input.connId);
          return input.names.map((name): api.ContainerActionResult => {
            const volume = server.dockerVolumes.find((v) => v.name === name);
            if (!volume) return { id: name, error: `get ${name}: no such volume` };
            if (volume.usedBy.length > 0) return { id: name, error: `remove ${name}: volume is in use` };
            server.dockerVolumes = server.dockerVolumes.filter((v) => v !== volume);
            return { id: name };
          });
        },
      },
      networks: {
        list: async (input: api.NetworksListInput) => {
          record("docker.networks.list", input);
          dockerHandle(input.connId);
          return server.dockerNetworks.map((n) => ({ ...n }));
        },
        inspect: async (input: api.NetworkIdInput) => {
          record("docker.networks.inspect", input);
          dockerHandle(input.connId);
          const network = server.dockerNetworks.find((n) => n.id === input.id || n.name === input.id);
          return { inspect: { Id: network?.id ?? input.id, Name: network?.name ?? input.id } };
        },
        remove: async (input: api.NetworksRemoveInput) => {
          record("docker.networks.remove", input);
          dockerHandle(input.connId);
          return input.ids.map((id): api.ContainerActionResult => {
            const network = server.dockerNetworks.find((n) => n.id === id || n.name === id);
            if (!network) return { id, error: `network ${id} not found` };
            if (network.builtIn) return { id, error: `${network.name} is a pre-defined network and cannot be removed` };
            server.dockerNetworks = server.dockerNetworks.filter((n) => n !== network);
            return { id };
          });
        },
      },
      host: {
        info: async (input: api.DockerConnIdInput) => {
          record("docker.host.info", input);
          const p = server.dockerProfiles.get(input.connId);
          if (!p) throw new RpcError("NotFound", "this connection is closed; connect again", { details: { kind: "NotFound", system: "docker", message: "gone", retryable: false, resource: "connection" } });
          return fakeHostInfo(p);
        },
      },
      containers: {
        list: async (input: api.ContainersListInput) => {
          record("docker.containers.list", input);
          dockerHandle(input.connId);
          return server.dockerContainers.map((r) => ({ ...r }));
        },
        inspect: async (input: api.ContainerIdInput) => {
          record("docker.containers.inspect", input);
          dockerHandle(input.connId);
          return fakeInspect(dockerRow(input.id));
        },
        start: async (input: api.ContainersActionInput) =>
          dockerAct("docker.containers.start", input, (r) => {
            r.state = "running";
            r.status = "Up 1 second";
            delete r.exitCode;
          }),
        stop: async (input: api.ContainersActionInput) =>
          dockerAct("docker.containers.stop", input, (r) => {
            r.state = "exited";
            r.status = "Exited (0) 1 second ago";
            r.exitCode = 0;
          }),
        restart: async (input: api.ContainersActionInput) =>
          dockerAct("docker.containers.restart", input, (r) => {
            r.state = "running";
            r.status = "Up 1 second";
          }),
        remove: async (input: api.ContainersRemoveInput) => {
          const removed: string[] = [];
          const out = dockerAct("docker.containers.remove", input, (r) => removed.push(r.id));
          server.dockerContainers = server.dockerContainers.filter((r) => !removed.includes(r.id));
          return out;
        },
        stats: (input: api.ContainersStatsInput) => {
          record("docker.containers.stats", input);
          return jsonlCall(server.dockerStats, { samples: server.dockerStats.length, dropped: 0 }, statsPushers);
        },
        exec: (input: api.ContainersExecInput) => {
          record("docker.containers.exec", input);
          const encoder = new TextEncoder();
          const queue: Uint8Array[] = [];
          let wake: (() => void) | null = null;
          let resolve!: (v: api.ContainersExecSummary) => void;
          let reject!: (e: unknown) => void;
          const result = new Promise<api.ContainersExecSummary>((res, rej) => {
            resolve = res;
            reject = rej;
          });
          result.catch(() => {});
          let done = false;
          const out = (text: string) => {
            queue.push(Uint8Array.of(1, ...encoder.encode(text)));
            wake?.();
          };
          const exec = {
            input: "",
            resizes: [] as { cols: number; rows: number }[],
            output: out,
            exit(code: number) {
              done = true;
              server.dockerExec = null;
              wake?.();
              setTimeout(() => resolve({ exitCode: code }), 0);
            },
          };
          server.dockerExec = exec;
          out("$ ");
          return {
            result,
            cancel() {
              done = true;
              server.dockerExec = null;
              reject(new RpcError("Cancelled", "cancelled", { local: true }));
              wake?.();
            },
            async *chunks() {
              for (;;) {
                const next = queue.shift();
                if (next) {
                  yield next;
                  continue;
                }
                if (done) return;
                await new Promise<void>((r) => (wake = r));
                wake = null;
              }
            },
          } as unknown as StreamCall<api.ContainersExecSummary, Uint8Array>;
        },
        logs: (input: api.ContainersLogsInput) => {
          record("docker.containers.logs", input);
          const row = server.dockerContainers.find((r) => r.name === input.id || r.id === input.id);
          const lines = server.dockerLogs.get(input.id) ?? [];
          const tail = input.tail === null || input.tail === undefined ? lines : lines.slice(-input.tail);
          const since = input.since ?? null;
          const shown = since !== null && since.includes("T") ? tail.filter((l) => l.ts >= since) : tail;
          const follow = input.follow && server.dockerFollow.has(input.id);
          const pushers = server.dockerPush.logs.get(input.id) ?? [];
          server.dockerPush.logs.set(input.id, pushers);
          return jsonlCall(shown, { lines: shown.length, tty: row?.name === "tty", endReason: "end" }, follow ? pushers : undefined);
        },
      },
      events: (input: api.DockerEventsInput) => {
        record("docker.events", input);
        return jsonlCall([], {}, server.dockerPush.events);
      },
      compose: {
        projects: async (input: api.DockerConnIdInput) => {
          record("docker.compose.projects", input);
          dockerHandle(input.connId);
          return [];
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
    /** Pushes samples to the open `docker.containers.stats` streams. */
    pushStats(samples: object[]) {
      for (const push of [...statsPushers]) push(samples);
    },
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
