// The Docker profile (Mightyconsole spec §10.1): an SSH host and the Docker socket on it. Its
// versioned schema, defaults, validation and the input of `docker.connect`. Pure, so the form and
// the tests share it. Secrets: the private key and its passphrase, or the password.
import type { ConnectDockerProfile, DockerAuth, HostKeyFingerprint } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
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
    const { fields, secrets } = record;
    const host = text(fields["host"]).trim();
    if (host === "") errors["host"] = "The host name or address is required.";
    else if (/\s|@/.test(host)) errors["host"] = "Only the host: put the user in Username and the port in Port.";
    if (fields["port"] !== undefined && !wholeNumber(fields["port"], 1, 65535)) errors["port"] = "A port from 1 to 65535.";
    if (text(fields["username"]).trim() === "") errors["username"] = "The user to log in as is required.";
    const auth = authOf(fields);
    if (auth === "privateKey" && text(secrets["privateKey"]).trim() === "") errors["privateKey"] = "Paste the private key or choose its file.";
    if (auth === "password" && text(secrets["password"]) === "") errors["password"] = "The password is required.";
    const socket = text(fields["socketPath"]).trim();
    if (socket !== "" && !socket.startsWith("/")) errors["socketPath"] = "An absolute path, like /var/run/docker.sock.";
    if (fields["keepaliveSec"] !== undefined && !wholeNumber(fields["keepaliveSec"], 0, 3600)) errors["keepaliveSec"] = "Seconds from 0 (off) to 3600.";
    return errors;
  },
  migrations: {},
  toConnect(record: ProfileRecord): ConnectDockerProfile {
    const { fields, secrets } = record;
    const auth = authOf(fields);
    const secret = (key: string) => {
      const value = text(secrets[key]);
      return value !== "" ? value : null;
    };
    return {
      name: record.name,
      host: text(fields["host"]).trim(),
      port: portOf(fields),
      username: text(fields["username"]).trim(),
      auth,
      // Only the chosen method's secrets travel.
      privateKey: auth === "privateKey" ? secret("privateKey") : null,
      passphrase: auth === "privateKey" ? secret("passphrase") : null,
      password: auth === "password" ? secret("password") : null,
      hostKey: hostKeyOf(fields),
      socketPath: text(fields["socketPath"]).trim() || null,
      keepaliveSec: typeof fields["keepaliveSec"] === "number" ? fields["keepaliveSec"] : null,
    };
  },
};

/** The record trusting `key` (spec §10.2). */
export function trustHostKey(record: ProfileRecord, key: HostKeyFingerprint): ProfileRecord {
  return { ...record, fields: { ...record.fields, hostKey: { algorithm: key.algorithm, fingerprintSha256: key.fingerprintSha256 } } };
}
