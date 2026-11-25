// SSH hosts (DOC-23 §4.3, §8.1, TSK-144): a saved login to one machine, chosen by Docker's SSH
// profiles (and later by the SSH hops of routes). They live on the server (`sshHosts.*`), with
// their key, passphrase and password as write-only secrets; this module keeps the list the server
// answered, so the Docker form, the host picker and Settings → SSH hosts read the same one, and
// reloads it when the server says a host or a profile changed.
import { useSyncExternalStore } from "react";
import type { MightyClient } from "@/app/client";
import type { DockerAuth, HostKeyFingerprint, OwnerWire, SshHostFields, SshHostView } from "@/gen/api";

export const DEFAULT_SSH_PORT = 22;
export const DEFAULT_KEEPALIVE_SEC = 30;

/** The secrets an SSH host keeps (write-only). */
export const SSH_HOST_SECRETS = ["privateKey", "passphrase", "password"] as const;
export type SshHostSecret = (typeof SSH_HOST_SECRETS)[number];

let hosts: readonly SshHostView[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function publish(next: readonly SshHostView[]) {
  hosts = [...next].sort((a, b) => a.name.localeCompare(b.name));
  loaded = true;
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The hosts as last read. */
export function sshHosts(): readonly SshHostView[] {
  return hosts;
}

/** Whether the list was read at least once. */
export function sshHostsLoaded(): boolean {
  return loaded;
}

/** The hosts, re-rendering when they change. */
export function useSshHosts(): readonly SshHostView[] {
  return useSyncExternalStore(subscribe, sshHosts, sshHosts);
}

export function sshHostById(id: string | undefined | null): SshHostView | undefined {
  return id ? hosts.find((h) => h.id === id) : undefined;
}

/** Reads the hosts again. */
export async function reloadSshHosts(client: MightyClient): Promise<readonly SshHostView[]> {
  const out = await client.sshHosts.list({});
  publish(out.hosts);
  return hosts;
}

/** Forgets the list (sign-out, tests). */
export function resetSshHosts(list: readonly SshHostView[] = []) {
  loaded = list.length > 0;
  hosts = list;
  for (const l of listeners) l();
}

/** `host:port`, brackets around an IPv6 address. */
export function addressOf(fields: Pick<SshHostFields, "host" | "port">): string {
  const host = fields.host.trim();
  const port = fields.port ?? DEFAULT_SSH_PORT;
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function authOf(fields: Pick<SshHostFields, "auth">): DockerAuth {
  return fields.auth ?? "privateKey";
}

export const AUTH_LABELS: Record<DockerAuth, string> = { privateKey: "Private key", password: "Password", agent: "ssh-agent" };

/** "2 Docker hosts", "1 profile", or "Not used". */
export function usedByText(host: SshHostView): string {
  const n = host.usedBy.length + host.usedByHidden;
  if (n === 0) return "Not used";
  const docker = host.usedBy.filter((u) => u.tool === "docker").length;
  if (docker === n) return `${n} Docker host${n === 1 ? "" : "s"}`;
  return `${n} profile${n === 1 ? "" : "s"}`;
}

/** The form's draft of a host. */
export interface SshHostDraft {
  name: string;
  /** Typed text, checked by `validateHost`. */
  host: string;
  port: string;
  username: string;
  auth: DockerAuth;
  keepaliveSec: string;
  hostKey: HostKeyFingerprint | null;
  /** Typed secrets; empty keeps what is stored. */
  secrets: Partial<Record<SshHostSecret, string>>;
  /** Stored secrets to remove on save. */
  remove: readonly SshHostSecret[];
  shared: boolean;
}

export function emptyDraft(): SshHostDraft {
  return { name: "", host: "", port: "", username: "", auth: "privateKey", keepaliveSec: "", hostKey: null, secrets: {}, remove: [], shared: false };
}

export function draftOf(view: SshHostView): SshHostDraft {
  const f = view.fields;
  return {
    name: view.name,
    host: f.host,
    port: f.port != null && f.port !== DEFAULT_SSH_PORT ? String(f.port) : "",
    username: f.username,
    auth: authOf(f),
    keepaliveSec: f.keepaliveSec != null ? String(f.keepaliveSec) : "",
    hostKey: f.hostKey ?? null,
    secrets: {},
    remove: [],
    shared: view.owner.kind === "shared",
  };
}

export type HostErrors = Partial<Record<"name" | "host" | "port" | "username" | "keepaliveSec" | SshHostSecret, string>>;

/** Field errors of a draft; `stored` are the secrets the saved host holds. */
export function validateHost(d: SshHostDraft, stored: ReadonlySet<string> = new Set()): HostErrors {
  const errors: HostErrors = {};
  if (d.name.trim() === "") errors.name = "A name is required.";
  const host = d.host.trim();
  if (host === "") errors.host = "The host name or address is required.";
  else if (/\s|@/.test(host)) errors.host = "Only the host: put the user in Username and the port in Port.";
  if (d.port.trim() !== "" && !(/^\d+$/.test(d.port.trim()) && Number(d.port) >= 1 && Number(d.port) <= 65535)) errors.port = "A port from 1 to 65535.";
  if (d.username.trim() === "") errors.username = "The user to log in as is required.";
  else if (/\s/.test(d.username.trim())) errors.username = "A user name without spaces.";
  if (d.keepaliveSec.trim() !== "" && !(/^\d+$/.test(d.keepaliveSec.trim()) && Number(d.keepaliveSec) <= 3600)) errors.keepaliveSec = "Seconds from 0 (off) to 3600.";
  const has = (k: SshHostSecret) => (d.secrets[k] ?? "") !== "" || (stored.has(k) && !d.remove.includes(k));
  if (d.auth === "privateKey" && !has("privateKey")) errors.privateKey = "Paste the private key or choose its file.";
  if (d.auth === "password" && !has("password")) errors.password = "The password is required.";
  return errors;
}

/** The fields the server keeps. */
export function fieldsOf(d: SshHostDraft): SshHostFields {
  return {
    host: d.host.trim(),
    port: d.port.trim() === "" ? DEFAULT_SSH_PORT : Number(d.port),
    username: d.username.trim(),
    auth: d.auth,
    keepaliveSec: d.keepaliveSec.trim() === "" ? null : Number(d.keepaliveSec),
    hostKey: d.hostKey,
  };
}

/** The typed secrets of the chosen authentication. */
export function typedSecrets(d: SshHostDraft): Record<string, string> {
  const keep: readonly SshHostSecret[] = d.auth === "privateKey" ? ["privateKey", "passphrase"] : d.auth === "password" ? ["password"] : [];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = d.secrets[k] ?? "";
    if (v !== "") out[k] = v;
  }
  return out;
}

export interface SavedHost {
  host: SshHostView;
  /** Secrets the server removed because the address, user or trusted key changed. */
  removedSecrets: string[];
}

/** Creates (`base` absent) or updates a host, then removes the secrets the form asked to. */
export async function saveHost(client: MightyClient, d: SshHostDraft, base?: SshHostView): Promise<SavedHost> {
  const fields = fieldsOf(d);
  const secrets = typedSecrets(d);
  let saved: SavedHost;
  if (base) {
    const out = await client.sshHosts.update({ id: base.id, etag: base.etag, name: d.name.trim(), fields, secrets });
    saved = { host: out.host, removedSecrets: out.removedSecrets };
    const remove = d.remove.filter((k) => !(k in secrets));
    for (const field of remove) await client.secrets.remove({ owner: { kind: "sshHost", id: base.id }, field });
    if (remove.length > 0) saved = { ...saved, host: await client.sshHosts.get({ id: base.id }) };
  } else {
    const owner: OwnerWire = d.shared ? { kind: "shared" } : { kind: "personal" };
    saved = { host: await client.sshHosts.create({ name: d.name.trim(), owner, fields, secrets }), removedSecrets: [] };
  }
  publish([...hosts.filter((h) => h.id !== saved.host.id), saved.host]);
  return saved;
}

/** Trusts `key` on the stored host (trust on first use, DOC-23 §4.3): every user of it follows. */
export async function trustHostKey(client: MightyClient, hostId: string, key: HostKeyFingerprint): Promise<SavedHost> {
  const current = await client.sshHosts.get({ id: hostId });
  const out = await client.sshHosts.update({ id: hostId, etag: current.etag, fields: { ...current.fields, hostKey: { algorithm: key.algorithm, fingerprintSha256: key.fingerprintSha256 } } });
  publish([...hosts.filter((h) => h.id !== hostId), out.host]);
  return { host: out.host, removedSecrets: out.removedSecrets };
}

/** Deletes a host nobody uses (the server refuses one in use and asks to type its name). */
export async function deleteHost(client: MightyClient, host: SshHostView): Promise<void> {
  await client.sshHosts.delete({ id: host.id, name: host.name });
  publish(hosts.filter((h) => h.id !== host.id));
}

/** Test of the host form: logs in and closes; the key the host presented. */
export async function testHost(client: MightyClient, d: SshHostDraft, base?: SshHostView): Promise<{ hostKey: HostKeyFingerprint; ms: number }> {
  return client.sshHosts.test({ fields: fieldsOf(d), secrets: typedSecrets(d), ...(base ? { hostId: base.id } : {}) });
}
