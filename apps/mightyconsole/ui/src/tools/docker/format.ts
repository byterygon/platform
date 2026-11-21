// What the Docker screens show of a container (Mightyconsole spec §10.4, TSK-81 mockup frames
// docker-containers and docker-overview): its state as a tone and a word, its ports, the filter
// chips' categories, the grouping by Compose project, and the `jsonl` lines of
// `docker.containers.logs` and `docker.events` (chunk lines are not in the generated API).
import type { ContainerPort, ContainerRow } from "@/gen/api";

/** One line of `docker.containers.logs` (the server's `LogLine`). */
export interface DockerLogLine {
  /** Docker's RFC 3339 time with nanoseconds; empty for a piece of a cut long line. */
  ts: string;
  stream: "stdout" | "stderr";
  text: string;
}

/** One line of `docker.events` (the server's `DockerEvent`). */
export interface DockerEvent {
  kind: "container" | "image" | "volume" | "network" | string;
  action: string;
  id: string;
  name?: string;
  attributes: Record<string, string>;
  timeMs: number;
}

/** The complete `jsonl` lines of a chunk (the server sends whole lines only). */
export function parseLines<T>(bytes: Uint8Array, decoder: TextDecoder = new TextDecoder()): T[] {
  const out: T[] = [];
  for (const line of decoder.decode(bytes).split("\n")) {
    if (line !== "") out.push(JSON.parse(line) as T);
  }
  return out;
}

export type Tone = "success" | "warning" | "danger" | "info" | "neutral";

/** What the state badge needs of a container (a list row or an inspect). */
export interface StateFacts {
  state: string;
  exitCode?: number | undefined;
  health?: string | undefined;
}

/** The tone of a container's state: a dead one or one that exited with an error is danger. */
export function stateTone(row: StateFacts): Tone {
  switch (row.state) {
    case "running":
      return row.health === "unhealthy" ? "danger" : "success";
    case "restarting":
      return "warning";
    case "paused":
      return "info";
    case "dead":
      return "danger";
    case "exited":
      return row.exitCode !== undefined && row.exitCode !== 0 ? "danger" : "neutral";
    default:
      return "neutral";
  }
}

/** `Running`, `Exited`, ... */
export function stateLabel(state: string): string {
  return state === "" ? "Unknown" : state[0]!.toUpperCase() + state.slice(1);
}

/** `127.0.0.1:8080→80/tcp`, `8000/tcp` (an exposed port only), IPv6 addresses in brackets. */
export function formatPort(p: ContainerPort): string {
  const inner = `${p.privatePort}/${p.protocol}`;
  if (p.publicPort === undefined) return inner;
  const ip = p.ip === undefined || p.ip === "0.0.0.0" || p.ip === "::" ? "" : p.ip.includes(":") ? `[${p.ip}]:` : `${p.ip}:`;
  return `${ip}${p.publicPort}→${inner}`;
}

/** The ports of a row, the same port on 0.0.0.0 and :: shown once. */
export function formatPorts(ports: readonly ContainerPort[]): string {
  return [...new Set(ports.map(formatPort))].join(", ");
}

export type ContainerFilter = "all" | "running" | "stopped" | "problems";

/** Restarting, unhealthy, dead, or exited with a code other than 0 (the mockup's Problems chip). */
export function isProblem(row: ContainerRow): boolean {
  return row.state === "restarting" || row.state === "dead" || row.health === "unhealthy" || (row.state === "exited" && row.exitCode !== undefined && row.exitCode !== 0);
}

export function matchesFilter(row: ContainerRow, filter: ContainerFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "running":
      return row.state === "running";
    case "stopped":
      return row.state === "exited" || row.state === "created" || row.state === "dead";
    case "problems":
      return isProblem(row);
  }
}

/** The search box: the name, the image, the id's start, or a label's key or value. */
export function matchesSearch(row: ContainerRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (q === "") return true;
  if (row.name.toLowerCase().includes(q) || row.image.toLowerCase().includes(q) || row.id.startsWith(q)) return true;
  return Object.entries(row.labels).some(([k, v]) => k.toLowerCase().includes(q) || v.toLowerCase().includes(q) || `${k}=${v}`.toLowerCase().includes(q));
}

/** Running first, then by name: the order of the tree and the table (spec §10.4). */
export function byStateThenName(a: ContainerRow, b: ContainerRow): number {
  const rank = (r: ContainerRow) => (r.state === "running" ? 0 : r.state === "restarting" || r.state === "paused" ? 1 : 2);
  return rank(a) - rank(b) || a.name.localeCompare(b.name);
}

export interface ContainerGroup {
  /** The Compose project; `null` for the containers outside any project. */
  project: string | null;
  /** The project's working dir from its label. */
  workingDir?: string;
  rows: ContainerRow[];
}

/** Projects by name, then the containers outside a project (the mockup's "No project" last). */
export function groupByProject(rows: readonly ContainerRow[]): ContainerGroup[] {
  const projects = new Map<string, ContainerRow[]>();
  const loose: ContainerRow[] = [];
  for (const row of rows) {
    if (row.project === undefined) loose.push(row);
    else projects.set(row.project, [...(projects.get(row.project) ?? []), row]);
  }
  const groups: ContainerGroup[] = [...projects.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, list]) => {
      const workingDir = list.map((r) => r.labels["com.docker.compose.project.working_dir"]).find((d) => d !== undefined);
      return { project, ...(workingDir ? { workingDir } : {}), rows: [...list].sort(byStateThenName) };
    });
  if (loose.length > 0) groups.push({ project: null, rows: [...loose].sort(byStateThenName) });
  return groups;
}

/** `5 containers · 4 running · 1 restarting`. */
export function countWords(rows: readonly ContainerRow[]): string {
  const n = rows.length;
  const parts = [`${n} ${n === 1 ? "container" : "containers"}`];
  const running = rows.filter((r) => r.state === "running").length;
  if (running > 0) parts.push(`${running} running`);
  const restarting = rows.filter((r) => r.state === "restarting").length;
  if (restarting > 0) parts.push(`${restarting} restarting`);
  const paused = rows.filter((r) => r.state === "paused").length;
  if (paused > 0) parts.push(`${paused} paused`);
  return parts.join(" · ");
}

/** The container events that change a list row (the others, `exec_*`, `attach`, `top`, leave it). */
export function changesRows(event: DockerEvent): boolean {
  if (event.kind !== "container") return false;
  const action = event.action.split(":")[0]!.trim();
  return ["create", "start", "restart", "stop", "die", "kill", "pause", "unpause", "destroy", "rename", "update", "health_status", "oom"].includes(action);
}

/**
 * An event as the Host page's list says it (TSK-81 mockup frame docker-host): the action without
 * its argument (`exec_start: sh -c …` is `exec_start`), and what it was about: the object's name,
 * then the exit code or the action's argument (`shop-api-1 · exit 1`, `shop-api-1 · sh`).
 */
export function eventText(event: DockerEvent): { action: string; detail: string } {
  const cut = event.action.indexOf(":");
  const action = (cut < 0 ? event.action : event.action.slice(0, cut)).trim();
  const argument = cut < 0 ? "" : event.action.slice(cut + 1).trim();
  const subject = event.name ?? event.attributes["name"] ?? (event.kind === "container" ? shortId(event.id) : event.id);
  const exit = event.attributes["exitCode"];
  return { action, detail: [subject, exit !== undefined ? `exit ${exit}` : "", argument].filter(Boolean).join(" · ") };
}

/** Which of `docker top`'s columns the Processes table shows, by index: PID, user, CPU, command. */
export interface ProcessColumns {
  pid: number;
  user: number;
  cpu: number;
  command: number;
}

/**
 * The columns of a `docker.containers.top` answer to show. The host's `ps` decides them:
 * `ps -ef` prints `UID PID PPID C STIME TTY TIME CMD`, BusyBox `PID USER TIME COMMAND`; a column
 * the host does not print is -1.
 */
export function processColumns(titles: readonly string[]): ProcessColumns {
  const find = (...names: string[]) => titles.findIndex((t) => names.includes(t.trim().toUpperCase()));
  return { pid: find("PID"), user: find("UID", "USER"), cpu: find("C", "%CPU", "CPU"), command: find("CMD", "COMMAND", "ARGS") };
}

/** `18 Nov, 07:12` (the mockup's created column) from Unix seconds. */
export function formatCreated(seconds: number, locale = "en-GB"): string {
  const date = new Date(seconds * 1000);
  return `${date.toLocaleDateString(locale, { day: "numeric", month: "short" })}, ${date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
}

/** `busybox:1.37` for `busybox:1.37@sha256:a7db…`: the reference without its digest (the full one in a title). */
export function imageLabel(image: string): string {
  const at = image.indexOf("@sha256:");
  return at > 0 ? image.slice(0, at) : image;
}

/** `4f9a2c1e7b03`: Docker's short id. */
export function shortId(id: string): string {
  return id.replace(/^sha256:/, "").slice(0, 12);
}

/** `3 hours`, `1 minute`, `12 seconds`, `4 days`: a span in words, rounded down to its largest unit. */
export function spanWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (s < 60) return unit(s, "second");
  if (s < 3600) return unit(Math.floor(s / 60), "minute");
  if (s < 48 * 3600) return unit(Math.floor(s / 3600), "hour");
  return unit(Math.floor(s / 86400), "day");
}

/** `3 hours ago` from an event's time (the footer's "last event"). */
export function agoText(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/** A container's command as one line, arguments with spaces quoted. */
export function commandLine(parts: readonly string[]): string {
  return parts.map((p) => (p === "" || /[\s"'$`\\]/.test(p) ? `'${p.replace(/'/g, `'\\''`)}'` : p)).join(" ");
}

/** One line of `docker.containers.stats` (the server's `StatsSample`). */
export interface StatsSample {
  timeMs: number;
  /** 100 is one whole CPU; absent on the first sample. */
  cpuPercent?: number;
  onlineCpus: number;
  memoryUsed: number;
  memoryLimit: number;
  /** Totals since the container started. */
  rxBytes: number;
  txBytes: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
  pidsLimit?: number;
}

/** A sample with the rates since the one before it (bytes per second). */
export interface StatsPoint extends StatsSample {
  rxRate: number;
  txRate: number;
  readRate: number;
  writeRate: number;
}

/** Rates from consecutive totals; a counter that went back (a restart) counts as 0. */
export function withRates(previous: StatsSample | undefined, sample: StatsSample): StatsPoint {
  const seconds = previous ? (sample.timeMs - previous.timeMs) / 1000 : 0;
  const rate = (now: number, before: number | undefined) => (seconds > 0 && before !== undefined && now >= before ? (now - before) / seconds : 0);
  return {
    ...sample,
    rxRate: rate(sample.rxBytes, previous?.rxBytes),
    txRate: rate(sample.txBytes, previous?.txBytes),
    readRate: rate(sample.blockRead, previous?.blockRead),
    writeRate: rate(sample.blockWrite, previous?.blockWrite),
  };
}

/** `12 MB`, `340 kB` (decimal units, as `docker stats` prints network and block I/O). */
export function formatBytes(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** `1.2 MB/s`. */
export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** `418 MiB` (binary units, as `docker stats` prints memory). */
export function formatMiB(bytes: number): string {
  const mib = bytes / 1024 ** 2;
  if (mib >= 1024) return `${(mib / 1024).toFixed(1)} GiB`;
  return `${mib >= 100 ? Math.round(mib) : mib.toFixed(1)} MiB`;
}

/** Bytes as base64 for `term.write`, in pieces so a long paste does not overflow the call stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
