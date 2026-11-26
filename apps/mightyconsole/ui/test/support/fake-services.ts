// An in-memory mightyconsole-server behind the generated API: app.info, app.events and the echo
// tool, enough to drive the shell in jsdom. Every call is recorded. `drop()` makes the server
// unreachable (the events subscription fails with Unavailable, app.info fails) until `restore()`;
// the handles of the lost connection are gone, as on the real server.
import { RpcError, type StreamCall, type Subscription } from "@byterygon/ambidex";
import type * as api from "@/gen/api";
import type { MightyClient, Services } from "@/app/client";
import { MemoryStorage, type AppStorage } from "@/profiles/storage";
import { type ProfileRecord, ulid } from "@/profiles/record";
import { browserKey, serverKey } from "@/profiles/server";
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { ProgressBus } from "@/app/progress";

export interface FakeServer {
  calls: { procedure: string; input: unknown }[];
  /** Live handles by connId. */
  handles: Map<string, { greeting: string }>;
  down: boolean;
  /** The session ended (DOC-25 §3.2.4): every call and the events subscription answer `Unauthenticated`. */
  signedOut: boolean;
  /** What `app.me` answers; change it to test roles, limits and who is signed in. */
  me: api.Me;
  /** The person's own sessions (`app.sessions.list`). */
  sessions: api.SessionRow[];
  /** How many ticks a ticks stream sends before it waits to be cancelled. */
  ticks: number;
  /** The next echo.connect waits for this promise (to test the connecting state). */
  connectGate: Promise<void> | null;
  /** What echo.messages.tail streams (§5.1 IPC chunks) and its summary (TSK-80). */
  messageChunks: Uint8Array[];
  produced: api.EchoProduceInput[];
  /** The profile each Docker handle connected with (TSK-81). */
  dockerProfiles: Map<string, FakeDockerProfile>;
  /** Saved SSH hosts (TSK-144), with their secrets by field. */
  sshHosts: Map<string, { view: api.SshHostView; secrets: Record<string, string> }>;
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

const fakeEntry = (name: string, kind: api.FileKind, size: number, mode: number, linkTarget?: string): api.FileEntry => ({ name, kind, size, mode, mtimeMs: Date.parse("2026-11-18T07:12:00Z"), ...(linkTarget ? { linkTarget } : {}) });

/** A container's files as the fake host lists them (the same for every container). */
export const FAKE_FILES: { dirs: Record<string, api.FileEntry[]>; files: Record<string, { kind: api.FileKind; size: number; text?: string; linkTarget?: string }> } = {
  dirs: {
    "/": [fakeEntry("app", "dir", 0, 0o755), fakeEntry("etc", "dir", 0, 0o755), fakeEntry("big", "dir", 0, 0o755)],
    "/app": [fakeEntry("media", "dir", 0, 0o755), fakeEntry("config.json", "file", 17, 0o644)],
    "/app/media": [fakeEntry("invoices", "dir", 0, 0o755), fakeEntry("logo.png", "file", 1800, 0o644), fakeEntry("robots.txt", "file", 68, 0o644), fakeEntry("exports", "symlink", 13, 0o777, "../exports"), fakeEntry("huge.log", "file", 5_000_000, 0o640)],
    "/app/media/invoices": [],
    "/app/exports": [fakeEntry("orders.csv", "file", 120, 0o644)],
    "/etc": [fakeEntry("hostname", "file", 9, 0o644)],
    "/big": [fakeEntry("f0", "file", 1, 0o644)],
  },
  files: {
    "/app/config.json": { kind: "file", size: 17, text: '{ "debug": true }' },
    "/app/media/robots.txt": { kind: "file", size: 68, text: "User-agent: *\nDisallow: /api/\n" },
    "/app/media/logo.png": { kind: "file", size: 1800 },
    "/app/media/huge.log": { kind: "file", size: 5_000_000 },
    "/etc/hostname": { kind: "file", size: 9, text: "shop-web\n" },
  },
};

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

/** What the fake connects Docker with: the stored profile's fields, as the server builds them. */
export interface FakeDockerProfile {
  name: string;
  host: string;
  port: number;
  username: string;
  auth: api.DockerAuth;
  hostKey: api.HostKeyFingerprint | null;
  socketPath: string | null;
}

/** A Docker profile as the server builds it: the login of its SSH host (TSK-144), else its own fields (older tests). */
function fakeDocker(r: ProfileRecord, hosts?: FakeServer["sshHosts"]): FakeDockerProfile {
  const host = hosts?.get(typeof r.fields["sshHostId"] === "string" ? r.fields["sshHostId"] : "");
  const f = host ? { ...r.fields, ...host.view.fields } : r.fields;
  const text = (v: unknown) => (typeof v === "string" ? v : "");
  const key = f["hostKey"] as api.HostKeyFingerprint | null | undefined;
  return { name: r.name, host: text(f["host"]), port: typeof f["port"] === "number" ? f["port"] : 22, username: text(f["username"]), auth: (text(f["auth"]) || "privateKey") as api.DockerAuth, hostKey: key ?? null, socketPath: text(f["socketPath"]) || null };
}

/** What the fake connects echo with. */
function fakeEcho(r: ProfileRecord): { name: string; greeting: string | null; token: string | null } {
  const greeting = r.fields["greeting"];
  const token = r.secrets["token"];
  return { name: r.name, greeting: typeof greeting === "string" && greeting !== "" ? greeting : null, token: typeof token === "string" && token !== "" ? token : null };
}

/** The fake Docker host's facts. */
export function fakeHostInfo(profile: FakeDockerProfile): api.HostInfo {
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

/**
 * What the page stores in the browser: tabs, layout and settings in `storage` (the tests read them
 * there), its own profile records apart (`browser`, those waiting to move to the server; TSK-139):
 * the profiles in `storage` are the server's.
 */
function browserStorage(storage: AppStorage, browser: MemoryStorage): AppStorage {
  const routed = new Set(["listProfiles", "getProfile", "putProfile", "deleteProfile", "putMigrated", "listBackups", "deleteBackup"]);
  return new Proxy(storage, {
    get(target, key, receiver) {
      if (typeof key === "string" && routed.has(key)) {
        const method = (browser as unknown as Record<string, (...args: unknown[]) => unknown>)[key]!;
        return method.bind(browser);
      }
      const value: unknown = Reflect.get(target, key, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export interface FakeOptions {
  /** The browser's own profile records (IndexedDB), to move to the server. */
  browserProfiles?: MemoryStorage;
}

export function createFakeServices(storage: AppStorage = new MemoryStorage(), options: FakeOptions = {}) {
  const browser = options.browserProfiles ?? new MemoryStorage();
  const server: FakeServer = {
    calls: [],
    handles: new Map(),
    down: false,
    signedOut: false,
    me: {
      user: "human:account:01ADMIN",
      session: "ls_current",
      method: "password",
      account: true,
      username: "uy.son",
      displayName: "Uy Son",
      totp: false,
      mustChangePassword: false,
      mustEnrolTotp: false,
      idleExpiresMs: Date.now() + 60 * 60_000,
      absoluteExpiresMs: Date.now() + 12 * 60 * 60_000,
      email: "uy.son@corp.example",
      tenant: "default",
      roles: [{ role: "admin", scope: null, via: "pinned" }],
      permissions: [],
    },
    sessions: [
      { id: "ls_current", user: "human:account:01ADMIN", method: "password", createdMs: Date.now() - 3600_000, lastActivityMs: Date.now(), idleExpiresMs: 0, absoluteExpiresMs: 0, client: "10.0.4.21", current: true },
      { id: "ls_other", user: "human:account:01ADMIN", method: "password", createdMs: Date.now() - 7200_000, lastActivityMs: Date.now() - 600_000, idleExpiresMs: 0, absoluteExpiresMs: 0, client: "10.0.7.3", current: false },
    ],
    ticks: 3,
    connectGate: null,
    messageChunks: [],
    produced: [],
    dockerProfiles: new Map(),
    sshHosts: new Map(),
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
    if (server.signedOut) throw new RpcError("Unauthenticated", "sign in again", { correlation_id: "corr-auth" });
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


  // ---- Profiles on the server (TSK-139): the fake keeps them in `storage`, which the tests seed;
  // the page's own browser records are a separate store (`browserStorage` below).
  const etags = new Map<string, number>();
  const imported = new Map<string, string>();
  const profileGone = () => new RpcError("NotFound", "no such profile", { details: { kind: "NotFound", system: "profiles", message: "no such profile", retryable: false, resource: "profile" } });
  const nonEmpty = (secrets: Record<string, unknown>) => Object.keys(secrets).filter((k) => typeof secrets[k] === "string" && secrets[k] !== "");
  const view = (r: ProfileRecord): api.ProfileView => ({
    id: r.id,
    tool: r.tool,
    version: r.version,
    name: r.name,
    ...(r.color ? { color: r.color } : {}),
    fields: r.fields,
    extras: r.extras,
    owner: r.owner ?? { kind: "personal", user: "human:account:test" },
    etag: String(etags.get(r.id) ?? 1),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    createdBy: "human:account:test",
    updatedBy: "human:account:test",
    access: r.access ?? "owner",
    secrets: nonEmpty(r.secrets).map((k) => ({ field: serverKey(r.tool, k), set: true, version: 1, setBy: "human:account:test", setAt: 0 })),
  });
  const browserSecrets = (tool: string, secrets: Record<string, string> | null | undefined) => Object.fromEntries(Object.entries(secrets ?? {}).map(([k, v]) => [browserKey(tool, k), v]));
  const stored = async (id: string) => {
    const r = await storage.getProfile(id);
    if (!r) throw profileGone();
    return r;
  };
  const touch = async (r: ProfileRecord) => {
    etags.set(r.id, (etags.get(r.id) ?? 1) + 1);
    const { etag: _etag, access: _access, storedSecrets: _stored, ...plain } = r;
    await storage.putProfile({ ...plain, updatedAt: new Date().toISOString() });
    return view((await storage.getProfile(r.id))!);
  };
  /** A `<tool>.test`'s draft as a record, `basedOn`'s stored secrets filling the empty ones. */
  const draftRecord = async (tool: string, input: api.ToolTestInput): Promise<ProfileRecord> => {
    const base = input.basedOn ? await stored(input.basedOn) : null;
    const secrets = { ...(base?.secrets ?? {}), ...browserSecrets(tool, input.draft.secrets) };
    return { id: input.basedOn ?? "draft", tool, version: 1, name: input.draft.name ?? "draft", createdAt: "", updatedAt: "", fields: (input.draft.fields ?? {}) as Record<string, unknown>, extras: (input.draft.extras ?? {}) as Record<string, unknown>, secrets };
  };
  const profilesApi = {
    list: async (input: api.ProfilesListInput) => {
      record("profiles.list", input);
      reachable();
      const all = await storage.listProfiles();
      return { profiles: all.filter((r) => !input.tool || r.tool === input.tool).map(view) };
    },
    get: async (input: api.ProfileIdInput) => {
      record("profiles.get", input);
      return view(await stored(input.id));
    },
    create: async (input: api.ProfileCreateInput) => {
      record("profiles.create", input);
      reachable();
      const now = new Date().toISOString();
      const r: ProfileRecord = { id: ulid(), tool: input.tool, version: 1, name: input.name, ...(input.color ? { color: input.color } : {}), createdAt: now, updatedAt: now, fields: (input.fields ?? {}) as Record<string, unknown>, extras: (input.extras ?? {}) as Record<string, unknown>, secrets: browserSecrets(input.tool, input.secrets), ...(input.owner.kind === "shared" ? { owner: { kind: "shared" as const } } : {}) };
      await storage.putProfile(r);
      return view(r);
    },
    update: async (input: api.ProfileUpdateInput) => {
      record("profiles.update", input);
      reachable();
      const r = await stored(input.id);
      if (input.etag !== String(etags.get(r.id) ?? 1)) throw new RpcError("FailedPrecondition", "the profile changed since it was read: reload it", { details: { kind: "Conflict", system: "profiles", message: "stale", retryable: false } });
      const color = input.color === "" ? undefined : (input.color ?? r.color);
      const next: ProfileRecord = { ...r, name: input.name ?? r.name, fields: (input.fields ?? r.fields) as Record<string, unknown>, extras: (input.extras ?? r.extras) as Record<string, unknown>, secrets: { ...r.secrets, ...browserSecrets(r.tool, input.secrets) } };
      if (color === undefined) delete next.color;
      else next.color = color;
      return { profile: await touch(next), removedSecrets: [] };
    },
    duplicate: async (input: api.ProfileDuplicateInput) => {
      record("profiles.duplicate", input);
      const r = await stored(input.id);
      const now = new Date().toISOString();
      const copy: ProfileRecord = { ...structuredClone(r), id: ulid(), name: input.name, createdAt: now, updatedAt: now };
      await storage.putProfile(copy);
      return { profile: view(copy), secretsCopied: true };
    },
    delete: async (input: api.ProfileDeleteInput) => {
      record("profiles.delete", input);
      await stored(input.id);
      await storage.deleteProfile(input.id);
      return {};
    },
    import: async (input: api.ProfileImportInput) => {
      record("profiles.import", { ...input, secrets: Object.keys(input.secrets ?? {}) });
      reachable();
      const known = imported.get(input.sourceId);
      const existing = known ? await storage.getProfile(known) : undefined;
      if (existing) return { profile: view(existing), created: false };
      let fields = input.record.fields as Record<string, unknown>;
      let secrets = input.secrets ?? null;
      // A Docker record of version 1: its login becomes an SSH host, as the server does (TSK-144).
      if (input.record.tool === "docker" && input.record.version < 2 && typeof fields["host"] === "string") {
        const { host, port, username, auth, keepaliveSec, hostKey, ...rest } = fields;
        const hostId = ulid();
        const login = { host: host as string, port: (port as number | undefined) ?? 22, username: username as string, auth: (auth as api.DockerAuth | undefined) ?? "privateKey", keepaliveSec: (keepaliveSec as number | undefined) ?? null, hostKey: (hostKey as api.HostKeyFingerprint | undefined) ?? null };
        server.sshHosts.set(hostId, { view: { id: hostId, name: host as string, fields: login, owner: { kind: "personal" }, etag: "1", createdAt: "", updatedAt: "", createdBy: "human:account:test", updatedBy: "human:account:test", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 }, secrets: { ...(secrets ?? {}) } });
        fields = { ...rest, sshHostId: hostId };
        secrets = null;
      }
      const made = await profilesApi.create({ tool: input.record.tool, name: input.record.name, color: input.record.color ?? null, owner: input.owner, fields, extras: input.record.extras, secrets });
      imported.set(input.sourceId, made.id);
      return { profile: made, created: true };
    },
  };
  const secretsApi = {
    status: async (input: api.SecretOwnerInput) => {
      record("secrets.status", input);
      if (input.owner.kind === "sshHost") {
        const h = server.sshHosts.get(input.owner.id);
        if (!h) throw profileGone();
        return { secrets: Object.keys(h.secrets).map((field) => ({ field, set: true, version: 1, setBy: "human:account:test", setAt: 0 })) };
      }
      return { secrets: view(await stored(input.owner.id)).secrets };
    },
    remove: async (input: api.SecretFieldInput) => {
      record("secrets.remove", input);
      const r = await stored(input.owner.id);
      const key = browserKey(r.tool, input.field);
      const removed = key in r.secrets;
      delete r.secrets[key];
      await touch(r);
      return { removed };
    },
  };
  /** The fake's SSH host key check: `FAKE_HOST_KEY` is the lab host's. */
  const dockerHostKey = (profile: FakeDockerProfile) => {
    const trusted = profile.hostKey;
    if (trusted?.fingerprintSha256 !== FAKE_HOST_KEY.fingerprintSha256) {
      const changed = trusted != null;
      throw new RpcError("FailedPrecondition", changed ? "the host key of build-host changed" : "build-host is not trusted yet", {
        correlation_id: "corr-hk",
        details: { kind: "HostKey", system: "docker", message: "host key", retryable: false, hostKey: { state: changed ? "changed" : "unknown", ...FAKE_HOST_KEY, ...(changed ? { expected: trusted } : {}) } },
      });
    }
  };

  // ---- SSH hosts (TSK-144): kept in `server.sshHosts`; secrets write-only.
  const hostGone = () => new RpcError("NotFound", "no such SSH host", { details: { kind: "NotFound", system: "profiles", message: "no such SSH host", retryable: false, resource: "sshHost" } });
  const hostView = (h: { view: api.SshHostView; secrets: Record<string, string> }): api.SshHostView => {
    const usedBy: api.SshHostUser[] = [];
    for (const r of storageSnapshot) if (r.fields["sshHostId"] === h.view.id) usedBy.push({ id: r.id, tool: r.tool, name: r.name });
    return { ...h.view, usedBy, secrets: Object.keys(h.secrets).map((field) => ({ field, set: true, version: 1, setBy: "human:account:test", setAt: 0 })) };
  };
  let storageSnapshot: ProfileRecord[] = [];
  const snapshot = async () => {
    storageSnapshot = await storage.listProfiles();
  };
  const hostOf = (id: string) => {
    const h = server.sshHosts.get(id);
    if (!h) throw hostGone();
    return h;
  };
  const sshHostsApi = {
    list: async () => {
      record("sshHosts.list", {});
      await snapshot();
      return { hosts: [...server.sshHosts.values()].map(hostView) };
    },
    get: async (input: api.SshHostIdInput) => {
      record("sshHosts.get", input);
      await snapshot();
      return hostView(hostOf(input.id));
    },
    create: async (input: api.SshHostCreateInput) => {
      record("sshHosts.create", { ...input, secrets: Object.keys(input.secrets ?? {}) });
      const id = ulid();
      const view: api.SshHostView = { id, name: input.name, fields: input.fields, owner: input.owner, etag: "1", createdAt: "", updatedAt: "", createdBy: "human:account:test", updatedBy: "human:account:test", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 };
      server.sshHosts.set(id, { view, secrets: { ...(input.secrets ?? {}) } });
      await snapshot();
      return hostView(server.sshHosts.get(id)!);
    },
    update: async (input: api.SshHostUpdateInput) => {
      record("sshHosts.update", { ...input, secrets: Object.keys(input.secrets ?? {}) });
      const h = hostOf(input.id);
      if (input.etag !== h.view.etag) throw new RpcError("FailedPrecondition", "the SSH host changed since it was read: reload it", { details: { kind: "Conflict", system: "profiles", message: "stale", retryable: false } });
      h.view = { ...h.view, name: input.name ?? h.view.name, fields: input.fields ?? h.view.fields, etag: String(Number(h.view.etag) + 1) };
      h.secrets = { ...h.secrets, ...(input.secrets ?? {}) };
      await snapshot();
      return { host: hostView(h), removedSecrets: [] };
    },
    delete: async (input: api.SshHostDeleteInput) => {
      record("sshHosts.delete", input);
      await snapshot();
      const h = hostView(hostOf(input.id));
      if (h.usedBy.length > 0) throw new RpcError("FailedPrecondition", `${h.name} is in use`, { details: { kind: "Conflict", system: "profiles", message: "in use", retryable: false } });
      server.sshHosts.delete(input.id);
      return {};
    },
    test: async (input: api.SshHostTestInput) => {
      record("sshHosts.test", { ...input, secrets: Object.keys(input.secrets) });
      dockerHostKey({ name: "draft", host: input.fields.host, port: input.fields.port ?? 22, username: input.fields.username, auth: input.fields.auth ?? "privateKey", hostKey: input.fields.hostKey ?? null, socketPath: null });
      return { hostKey: FAKE_HOST_KEY, ms: 12 };
    },
  };

  const client = {
    profiles: profilesApi,
    secrets: secretsApi,
    sshHosts: sshHostsApi,
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
      me: async () => {
        record("app.me", {});
        reachable();
        return { ...server.me };
      },
      sessions: {
        list: async () => {
          record("app.sessions.list", {});
          reachable();
          return { sessions: server.sessions.map((row) => ({ ...row, current: row.id === server.me.session })) };
        },
        revoke: async (input: api.SessionIdInput) => {
          record("app.sessions.revoke", input);
          reachable();
          const before = server.sessions.length;
          server.sessions = server.sessions.filter((row) => row.id !== input.sessionId);
          return { revoked: before - server.sessions.length };
        },
      },
    },
    echo: {
      connect: async (input: api.EchoConnectInput) => {
        record("echo.connect", input);
        if (server.connectGate) await server.connectGate;
        reachable();
        const profile = fakeEcho(await stored(input.profileId));
        if (profile.token === "wrong") throw new RpcError("Unauthenticated", "the token was rejected", { correlation_id: "corr-1", details: { kind: "Auth", system: "echo", message: "the token was rejected", retryable: false } });
        const connId = `conn-${++ids}`;
        const greeting = profile.greeting ?? `hello from ${profile.name}`;
        server.handles.set(connId, { greeting });
        return { connId, greeting, schemaIssues: [] };
      },
      test: async (input: api.ToolTestInput) => {
        record("echo.test", { ...input, draft: { ...input.draft, secrets: Object.keys(input.draft.secrets) } });
        reachable();
        const profile = fakeEcho(await draftRecord("echo", input));
        if (profile.token === "wrong") throw new RpcError("Unauthenticated", "the token was rejected", { correlation_id: "corr-1", details: { kind: "Auth", system: "echo", message: "the token was rejected", retryable: false } });
        return {};
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
        reachable();
        const profile = fakeDocker(await stored(input.profileId), server.sshHosts);
        // With the profile the server built: what the Docker tests check.
        record("docker.connect", { ...input, profile });
        dockerHostKey(profile);
        const connId = `d${++ids}`;
        server.handles.set(connId, { greeting: "docker" });
        server.dockerProfiles.set(connId, profile);
        return { connId, host: fakeHostInfo(profile) };
      },
      test: async (input: api.ToolTestInput) => {
        record("docker.test", { ...input, draft: { ...input.draft, secrets: Object.keys(input.draft.secrets) } });
        reachable();
        dockerHostKey(fakeDocker(await draftRecord("docker", input), server.sshHosts));
        return {};
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
        df: async (input: api.DockerConnIdInput): Promise<api.DiskUsage> => {
          record("docker.host.df", input);
          dockerHandle(input.connId);
          if (server.dockerDfError) throw new RpcError("Unavailable", server.dockerDfError, { details: { kind: "Remote", system: "docker", message: server.dockerDfError, retryable: true } });
          return {
            images: { count: server.dockerImages.length, active: 3, size: 3_100_000_000, reclaimable: 1_200_000_000 },
            containers: { count: server.dockerContainers.length, active: server.dockerContainers.filter((r) => r.state === "running").length, size: 184_000_000, reclaimable: 31_000_000 },
            volumes: { count: server.dockerVolumes.length, active: 2, size: 12_500_000_000, reclaimable: 740_000_000 },
            buildCache: { count: 0, active: 0, size: 0, reclaimable: 0 },
          };
        },
        counts: async (input: api.DockerConnIdInput): Promise<api.HostCounts> => {
          record("docker.host.counts", input);
          dockerHandle(input.connId);
          return { images: server.dockerImages.length, volumes: server.dockerVolumes.length, networks: server.dockerNetworks.length };
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
        files: {
          list: async (input: api.FilesPathInput): Promise<api.FilesListOutput> => {
            record("docker.containers.files.list", input);
            dockerHandle(input.connId);
            dockerRow(input.id);
            const file = FAKE_FILES.files[input.path];
            if (file) return { path: input.path, kind: file.kind, ...(file.linkTarget ? { linkTarget: file.linkTarget } : {}), entries: [] };
            const entries = FAKE_FILES.dirs[input.path];
            if (!entries) throw new RpcError("NotFound", `Could not find the file ${input.path} in container ${input.id}`, { details: { kind: "NotFound", system: "docker", message: `Could not find the file ${input.path}`, retryable: false, resource: "path" } });
            return { path: input.path, kind: "dir", entries, ...(input.path === "/big" ? { truncated: "entries" as const } : {}) };
          },
          read: async (input: api.FilesPathInput): Promise<api.FileReadOutput> => {
            record("docker.containers.files.read", input);
            dockerHandle(input.connId);
            const file = FAKE_FILES.files[input.path];
            if (!file) throw new RpcError("InvalidArgument", `${input.path} is a folder`, { details: { kind: "Invalid", system: "docker", message: `${input.path} is a folder`, retryable: false, field: "path" } });
            return { path: input.path, size: file.size, ...(file.text !== undefined ? { text: file.text } : {}), binary: file.text === undefined && file.size <= 1024 * 1024, tooLarge: file.size > 1024 * 1024 };
          },
          download: (input: api.FilesDownloadInput) => {
            record("docker.containers.files.download", input);
            const encoder = new TextEncoder();
            const bytes = encoder.encode(`tar of ${input.path}`);
            let given = false;
            return {
              result: Promise.resolve({ bytes: bytes.byteLength }),
              cancel: () => undefined,
              async *chunks() {
                if (!given) {
                  given = true;
                  yield bytes;
                }
              },
            } as unknown as ReturnType<MightyClient["docker"]["containers"]["files"]["download"]>;
          },
        },
        top: async (input: api.ContainerIdInput): Promise<api.ContainerTop> => {
          record("docker.containers.top", input);
          dockerHandle(input.connId);
          const row = dockerRow(input.id);
          if (row.state !== "running") throw new RpcError("FailedPrecondition", `Container ${row.id} is not running`, { details: { kind: "Conflict", system: "docker", message: `Container ${row.id} is not running`, retryable: false } });
          return {
            titles: ["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"],
            processes: [
              ["app", "4121", "4100", "0", "07:12", "?", "00:00:01", "/usr/local/bin/python /usr/local/bin/gunicorn shop.wsgi"],
              ["app", "4188", "4121", "11", "07:12", "?", "00:02:13", "gunicorn: worker [shop.wsgi]"],
            ],
          };
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

  const services: Services = { client, storage: browserStorage(storage, browser), decoder: inThreadArrowDecoder(), progress: new ProgressBus() };
  return {
    services,
    server,
    storage,
    /** The page's own browser records (IndexedDB), apart from the server's profiles. */
    browser,
    /** Stores an SSH host on the (fake) server; its id, for a Docker profile's `sshHostId`. */
    storeSshHost(name: string, fields: api.SshHostFields, secrets: Record<string, string> = {}): string {
      const id = ulid();
      server.sshHosts.set(id, { view: { id, name, fields, owner: { kind: "personal" }, etag: "1", createdAt: "", updatedAt: "", createdBy: "human:account:test", updatedBy: "human:account:test", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 }, secrets });
      return id;
    },
    /** Stores a profile on the (fake) server; its id, for `<tool>.connect { profileId }`. */
    async storeProfile(tool: string, name: string, fields: Record<string, unknown>, secrets: Record<string, string> = {}): Promise<string> {
      const id = ulid();
      await storage.putProfile({ id, tool, version: 1, name, createdAt: "", updatedAt: "", fields, secrets, extras: {} });
      return id;
    },
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
    /** The session ends (idle, revoked, restart): the subscription fails with Unauthenticated. */
    endSession() {
      server.signedOut = true;
      server.handles.clear();
      subscriber?.fail(new RpcError("Unauthenticated", "the session ended", { correlation_id: "corr-ended" }));
      subscriber = null;
    },
    /** Someone signed in again (the person, or `as` another one) at the other tab. */
    signInAgain(as?: Partial<api.Me>) {
      server.signedOut = false;
      server.me = { ...server.me, ...as };
    },
  };
}
