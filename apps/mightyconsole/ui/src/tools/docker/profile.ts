// The Docker profile (Mightyconsole spec §10.1, DOC-23 §6.4): over SSH it names a saved SSH host
// (`sshHostId`, Settings → SSH hosts) and the Docker socket on it; the address, user, key and
// trusted host key are the host's (TSK-144). Version 1 held the login itself: the server turns such
// a record into an SSH host and a version 2 profile when it is imported (DOC-23 (z)), so the
// browser never migrates it (`serverMigratesFrom`).
import type { HostKeyFingerprint } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { addressOf, sshHostById } from "@/profiles/ssh-hosts";
import type { FieldErrors, ProfileSchema } from "../types";

export const DEFAULT_SOCKET = "/var/run/docker.sock";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The SSH host a profile names. */
export function hostIdOf(fields: Record<string, unknown>): string {
  return text(fields["sshHostId"]);
}

/** The host key the profile's SSH host trusts, `null` before the first connection. */
export function hostKeyOf(record: ProfileRecord): HostKeyFingerprint | null {
  return sshHostById(hostIdOf(record.fields))?.fields.hostKey ?? null;
}

/** `host:port` of the profile's SSH host, for the trust dialog. */
export function targetOf(record: ProfileRecord): string {
  const host = sshHostById(hostIdOf(record.fields));
  return host ? addressOf(host.fields) : record.name;
}

export const profile: ProfileSchema = {
  version: 2,
  serverMigratesFrom: 1,
  defaults: () => ({ fields: { sshHostId: "", socketPath: DEFAULT_SOCKET }, secrets: {}, extras: {} }),
  validate(record): FieldErrors {
    const errors: FieldErrors = {};
    if (hostIdOf(record.fields) === "") errors["sshHostId"] = "Choose the SSH host, or add one.";
    const socket = text(record.fields["socketPath"]).trim();
    if (socket !== "" && !socket.startsWith("/")) errors["socketPath"] = "An absolute path, like /var/run/docker.sock.";
    return errors;
  },
  migrations: {},
};
