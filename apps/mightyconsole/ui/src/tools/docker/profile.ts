// The Docker profile (Mightyconsole spec §10.1): an SSH host and the Docker socket on it. Its
// versioned schema, defaults, validation and the input of `docker.connect`. Pure, so the form and
// the tests share it. Secrets: the private key and its passphrase, or the password.
import type { DockerAuth, HostKeyFingerprint } from "@/gen/api";
import { hasSecret, type ProfileRecord } from "@/profiles/record";
import type { FieldErrors, ProfileSchema } from "../types";

export const DEFAULT_PORT = 22;
export const DEFAULT_SOCKET = "/var/run/docker.sock";
export const DEFAULT_KEEPALIVE_SEC = 30;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function authOf(fields: Record<string, unknown>): DockerAuth {
  const auth = fields["auth"];
  return auth === "password" || auth === "agent" ? auth : "privateKey";
}

/** The host key the profile trusts, `null` before the first connection. */
export function hostKeyOf(fields: Record<string, unknown>): HostKeyFingerprint | null {
  const raw = fields["hostKey"];
  if (typeof raw !== "object" || raw === null) return null;
  const { algorithm, fingerprintSha256 } = raw as Record<string, unknown>;
  return typeof algorithm === "string" && typeof fingerprintSha256 === "string" ? { algorithm, fingerprintSha256 } : null;
}

function portOf(fields: Record<string, unknown>): number {
  const port = fields["port"];
  return typeof port === "number" ? port : DEFAULT_PORT;
}

/** `host:port`, brackets around an IPv6 address. */
export function targetOf(record: ProfileRecord): string {
  const host = text(record.fields["host"]).trim();
  const port = portOf(record.fields);
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

const wholeNumber = (value: unknown, min: number, max: number) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export const profile: ProfileSchema = {
  version: 1,
  defaults: () => ({
    fields: { host: "", port: DEFAULT_PORT, username: "", auth: "privateKey", hostKey: null, socketPath: DEFAULT_SOCKET, keepaliveSec: DEFAULT_KEEPALIVE_SEC },
    secrets: {},
    extras: {},
  }),
  validate(record): FieldErrors {
    const errors: FieldErrors = {};
    const { fields } = record;
    const host = text(fields["host"]).trim();
    if (host === "") errors["host"] = "The host name or address is required.";
    else if (/\s|@/.test(host)) errors["host"] = "Only the host: put the user in Username and the port in Port.";
    if (fields["port"] !== undefined && !wholeNumber(fields["port"], 1, 65535)) errors["port"] = "A port from 1 to 65535.";
    if (text(fields["username"]).trim() === "") errors["username"] = "The user to log in as is required.";
    const auth = authOf(fields);
    if (auth === "privateKey" && !hasSecret(record, "privateKey")) errors["privateKey"] = "Paste the private key or choose its file.";
    if (auth === "password" && !hasSecret(record, "password")) errors["password"] = "The password is required.";
    const socket = text(fields["socketPath"]).trim();
    if (socket !== "" && !socket.startsWith("/")) errors["socketPath"] = "An absolute path, like /var/run/docker.sock.";
    if (fields["keepaliveSec"] !== undefined && !wholeNumber(fields["keepaliveSec"], 0, 3600)) errors["keepaliveSec"] = "Seconds from 0 (off) to 3600.";
    return errors;
  },
  migrations: {},
};

/** The record trusting `key` (spec §10.2). */
export function trustHostKey(record: ProfileRecord, key: HostKeyFingerprint): ProfileRecord {
  return { ...record, fields: { ...record.fields, hostKey: { algorithm: key.algorithm, fingerprintSha256: key.fingerprintSha256 } } };
}
