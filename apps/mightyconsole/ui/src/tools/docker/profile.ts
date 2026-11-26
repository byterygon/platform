// The Docker profile (Mightyconsole spec §10.1, DOC-23 §6): `transport` says how the server
// reaches the Engine, `ssh` when absent (every profile saved before TSK-116).
//
// - `ssh`: a saved SSH host (`sshHostId`, Settings → SSH hosts) and the Docker socket on it; the
//   address, user, key and trusted host key are the host's (TSK-144). Version 1 held the login
//   itself: the server turns such a record into an SSH host and a version 2 profile when it is
//   imported (DOC-23 (z)), so the browser never migrates it (`serverMigratesFrom`).
// - `socket`: `socketPath` on the server's own machine (a Unix socket, or a Windows named pipe);
//   `~` is the home of the user running the server. Saving it needs `profiles.hostAccess`.
// - `tcp`: `host`, `port` (2376 with TLS, 2375 without) and `tls` (`enabled`, the pinned CA, the
//   client certificate and the server name; the client key is the secret `clientKeyPem`). Without
//   TLS the person accepts the risk: the page sends `unencrypted: { accepted: true }` and the
//   server keeps who and when (`{ acceptedBy, acceptedAt }`, DOC-23 (bd)).
import type { HostKeyFingerprint } from "@/gen/api";
import { type ProfileRecord, hasSecret } from "@/profiles/record";
import { addressOf, sshHostById } from "@/profiles/ssh-hosts";
import type { FieldErrors, ProfileSchema } from "../types";

export const DEFAULT_SOCKET = "/var/run/docker.sock";

/** Ports of the Engine's TCP API (DOC-23 §6.3). */
export const DEFAULT_TLS_PORT = 2376;
export const DEFAULT_TCP_PORT = 2375;

export type DockerTransport = "ssh" | "socket" | "tcp";

export const TRANSPORTS: readonly DockerTransport[] = ["ssh", "socket", "tcp"];
export const TRANSPORT_LABELS: Readonly<Record<DockerTransport, string>> = { ssh: "SSH", socket: "Local socket", tcp: "TCP" };

/** The usual places of Docker's socket (DOC-23 §6.2), for the socket field's menu. */
export const USUAL_SOCKETS: readonly { path: string; label: string }[] = [
  { path: "/var/run/docker.sock", label: "Linux, Docker Engine" },
  { path: "~/.docker/run/docker.sock", label: "Docker Desktop on macOS" },
  { path: "~/.colima/default/docker.sock", label: "Colima" },
  { path: "~/.orbstack/run/docker.sock", label: "OrbStack" },
  { path: "/run/user/1000/docker.sock", label: "Rootless Docker (uid 1000)" },
  { path: "/run/user/1000/podman/podman.sock", label: "Podman (uid 1000)" },
  { path: "//./pipe/docker_engine", label: "Windows named pipe" },
];

/** The fields that belong to one transport; the others are the profile's whatever its transport. */
const TRANSPORT_FIELDS: Readonly<Record<DockerTransport, readonly string[]>> = {
  ssh: ["sshHostId", "socketPath"],
  socket: ["socketPath"],
  tcp: ["host", "port", "tls", "unencrypted"],
};
const ALL_TRANSPORT_FIELDS = ["transport", "sshHostId", "socketPath", "host", "port", "tls", "unencrypted"];

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const object = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The profile's transport, `ssh` when absent. */
export function transportOf(fields: Record<string, unknown>): DockerTransport {
  const t = fields["transport"];
  return t === "socket" || t === "tcp" ? t : "ssh";
}

/** The TCP profile's TLS settings. */
export interface DockerTls {
  enabled: boolean;
  caPem: string;
  clientCertPem: string;
  serverName: string;
}

export function tlsOf(fields: Record<string, unknown>): DockerTls {
  const tls = object(fields["tls"]);
  return { enabled: tls["enabled"] === true, caPem: text(tls["caPem"]), clientCertPem: text(tls["clientCertPem"]), serverName: text(tls["serverName"]) };
}

/** TCP without TLS. */
export function isPlainTcp(fields: Record<string, unknown>): boolean {
  return transportOf(fields) === "tcp" && !tlsOf(fields).enabled;
}

/** Who accepted plain TCP and when, as the server recorded it; `null` before it is saved. */
export function acceptanceOf(fields: Record<string, unknown>): { by: string; at: string } | null {
  const u = object(fields["unencrypted"]);
  const by = u["acceptedBy"];
  const at = u["acceptedAt"];
  return typeof by === "string" && typeof at === "string" ? { by, at } : null;
}

/** Whether plain TCP is accepted: the server's record of it, or the tick about to be saved. */
export function unencryptedAccepted(fields: Record<string, unknown>): boolean {
  return acceptanceOf(fields) !== null || object(fields["unencrypted"])["accepted"] === true;
}

/** The SSH host a profile names. */
export function hostIdOf(fields: Record<string, unknown>): string {
  return text(fields["sshHostId"]);
}

/** The host key the profile's SSH host trusts, `null` before the first connection. */
export function hostKeyOf(record: ProfileRecord): HostKeyFingerprint | null {
  return sshHostById(hostIdOf(record.fields))?.fields.hostKey ?? null;
}

/** The TCP port the profile connects to: its own, or the default for TLS on or off. */
export function tcpPortOf(fields: Record<string, unknown>): number {
  const port = fields["port"];
  return typeof port === "number" ? port : tlsOf(fields).enabled ? DEFAULT_TLS_PORT : DEFAULT_TCP_PORT;
}

/** Where the profile connects, for the trust dialog and messages: the SSH host, the socket, `host:port`. */
export function targetOf(record: ProfileRecord): string {
  const transport = transportOf(record.fields);
  if (transport === "socket") return text(record.fields["socketPath"]) || record.name;
  if (transport === "tcp") {
    const host = text(record.fields["host"]).trim();
    if (host === "") return record.name;
    const port = tcpPortOf(record.fields);
    return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
  }
  const host = sshHostById(hostIdOf(record.fields));
  return host ? addressOf(host.fields) : record.name;
}

/** What the form keeps of a transport the person leaves, to give back if they return. */
export function transportFields(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TRANSPORT_FIELDS[transportOf(fields)]) if (fields[k] !== undefined) out[k] = fields[k];
  return out;
}

/**
 * The fields after a change of transport: the profile's own, then `next`'s as the person left them
 * (`kept`) or its defaults. Nothing of another transport stays: a TCP profile with a host id, for
 * one, is refused by the server.
 */
export function withTransport(fields: Record<string, unknown>, next: DockerTransport, kept: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (!ALL_TRANSPORT_FIELDS.includes(k)) out[k] = v;
  const defaults: Record<DockerTransport, Record<string, unknown>> = {
    ssh: { sshHostId: "", socketPath: DEFAULT_SOCKET },
    socket: { socketPath: "" },
    tcp: { host: "", tls: { enabled: true } },
  };
  return { ...out, ...(next === "ssh" ? {} : { transport: next }), ...(kept ?? defaults[next]) };
}

/** A host name or address: no scheme, port, path or space. */
const HOST = /^(\[?[0-9A-Fa-f:.]+\]?|[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*\.?)$/;

/** A path the server opens as a local socket: absolute, `~/…`, or a named pipe. */
function isSocketPath(path: string): boolean {
  return path.startsWith("/") || path === "~" || path.startsWith("~/") || /^(\/\/|\\\\)\.[/\\]pipe[/\\]./i.test(path);
}

export const profile: ProfileSchema = {
  version: 2,
  serverMigratesFrom: 1,
  defaults: () => ({ fields: { sshHostId: "", socketPath: DEFAULT_SOCKET }, secrets: {}, extras: {} }),
  validate(record): FieldErrors {
    const errors: FieldErrors = {};
    const fields = record.fields;
    const transport = transportOf(fields);
    if (transport === "ssh") {
      if (hostIdOf(fields) === "") errors["sshHostId"] = "Choose the SSH host, or add one.";
      const socket = text(fields["socketPath"]).trim();
      if (socket !== "" && !socket.startsWith("/")) errors["socketPath"] = "An absolute path, like /var/run/docker.sock.";
      return errors;
    }
    if (transport === "socket") {
      const socket = text(fields["socketPath"]).trim();
      if (socket === "") errors["socketPath"] = "Enter the socket's path, or choose one of the usual places.";
      else if (!isSocketPath(socket)) errors["socketPath"] = "An absolute path, ~/… for the server's user, or a named pipe like //./pipe/docker_engine.";
      return errors;
    }
    const host = text(fields["host"]).trim();
    if (host === "") errors["host"] = "Enter the Engine's host name or address.";
    else if (!HOST.test(host)) errors["host"] = "A host name or an address, without a scheme or a port.";
    const port = fields["port"];
    if (port !== undefined && port !== null && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) errors["port"] = "A port from 1 to 65535.";
    const tls = tlsOf(fields);
    if (tls.enabled) {
      // DOC-23 §6.3: the pinned CA, the client certificate and its key; only the server name is optional.
      if (tls.caPem.trim() === "") errors["tls.caPem"] = "Paste the CA certificate the Engine's certificate is signed by (ca.pem).";
      if (tls.clientCertPem.trim() === "") errors["tls.clientCertPem"] = "Paste the client certificate the Engine accepts (cert.pem).";
      if (!hasSecret(record, "clientKeyPem")) errors["tls.clientKeyPem"] = "Paste the client certificate's private key (key.pem).";
    } else if (!unencryptedAccepted(fields)) {
      errors["unencrypted"] = "Tick that you accept an unencrypted connection, or turn TLS on.";
    }
    return errors;
  },
  migrations: {},
};
