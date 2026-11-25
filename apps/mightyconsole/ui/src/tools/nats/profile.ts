// The NATS profile (Mightyconsole spec §6.1): its versioned schema, defaults, validation and the
// input of `nats.connect`. Pure, so the form and the tests share it.
import { hasSecret, type ProfileRecord } from "@/profiles/record";
import type { FieldErrors, ProfileSchema } from "../types";

export const DEFAULT_SERVER = "nats://127.0.0.1:4222";
export const DEFAULT_CONNECTION_NAME = "mightyconsole";
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const MAX_REQUEST_TIMEOUT_MS = 300_000;

/** How a NATS profile signs in (the server's connect profile takes the same names). */
export type NatsAuth = "none" | "userPassword" | "token" | "nkey" | "creds";

export const AUTH_LABELS: Record<NatsAuth, string> = {
  none: "None",
  userPassword: "User and password",
  token: "Token",
  nkey: "NKey seed",
  creds: "Credentials file (.creds)",
};

/** The profile's TLS fields (spec §4.2; the client key is a secret). */
export interface TlsFields {
  enabled: boolean;
  caPem?: string;
  clientCertPem?: string;
  serverName?: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export function tlsOf(fields: Record<string, unknown>): TlsFields {
  const tls = record(fields["tls"]);
  const out: TlsFields = { enabled: tls["enabled"] === true };
  for (const key of ["caPem", "clientCertPem", "serverName"] as const) {
    const value = text(tls[key]);
    if (value !== "") out[key] = value;
  }
  return out;
}

/** The servers, trimmed, empty lines dropped; the default when none. */
export function serversOf(fields: Record<string, unknown>): string[] {
  const raw = fields["servers"];
  const list = (Array.isArray(raw) ? raw : []).map((s) => text(s).trim()).filter((s) => s !== "");
  return list.length > 0 ? list : [DEFAULT_SERVER];
}

export function authOf(fields: Record<string, unknown>): NatsAuth {
  const auth = fields["auth"];
  return typeof auth === "string" && auth in AUTH_LABELS ? (auth as NatsAuth) : "none";
}

/** Bookmarked subjects and patterns (`extras.subjects`), shown in the tree. */
export function bookmarksOf(extras: Record<string, unknown>): string[] {
  const raw = extras["subjects"];
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];
}

export function requestTimeoutOf(record: ProfileRecord): number {
  const ms = record.fields["requestTimeoutMs"];
  return typeof ms === "number" && Number.isInteger(ms) && ms >= 1 && ms <= MAX_REQUEST_TIMEOUT_MS ? ms : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** A server address: `nats://` or `tls://` with host:port, or a bare host:port. */
export function validateServer(server: string): string | null {
  const s = server.trim();
  const match = /^(?:(nats|tls):\/\/)?(?:[^@/\s]+@)?(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?)(?::(\d{1,5}))?$/.exec(s);
  if (!match) return `${s}: use nats://host:port or tls://host:port.`;
  const port = match[4];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return `${s}: the port is 1 to 65535.`;
  return null;
}

/** A subject to subscribe to: tokens split by dots, `*` and `>` allowed, `>` last. */
export function validatePattern(subject: string): string | null {
  const s = subject.trim();
  if (s === "") return "A subject is required.";
  if (/\s/.test(s)) return "A subject has no spaces.";
  const tokens = s.split(".");
  if (tokens.some((t) => t === "")) return "A subject has no empty tokens (..).";
  if (tokens.slice(0, -1).includes(">")) return "> comes last.";
  return null;
}

/** A subject to publish on: as `validatePattern`, without wildcards. */
export function validateSubject(subject: string): string | null {
  const problem = validatePattern(subject);
  if (problem) return problem;
  if (subject.trim().split(".").some((t) => t === "*" || t === ">")) return "Wildcards (* and >) only subscribe; publish to a whole subject.";
  return null;
}

const SECRET_OF: Partial<Record<NatsAuth, string>> = { userPassword: "password", token: "token", nkey: "nkeySeed", creds: "creds" };

export const profile: ProfileSchema = {
  version: 1,
  defaults: () => ({
    fields: { servers: [DEFAULT_SERVER], auth: "none", tls: { enabled: false }, connectionName: DEFAULT_CONNECTION_NAME, jetstream: {}, inboxPrefix: "_INBOX", requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS },
    secrets: {},
    extras: { subjects: [], schemas: [], mappings: [], templates: [], filters: [] },
  }),
  validate(rec): FieldErrors {
    const errors: FieldErrors = {};
    const problems = serversOf(rec.fields).map(validateServer).filter((p): p is string => p !== null);
    if (problems.length > 0) errors["servers"] = problems[0]!;
    const auth = authOf(rec.fields);
    if (auth === "userPassword" && text(rec.fields["user"]).trim() === "") errors["user"] = "A user name is required.";
    const secret = SECRET_OF[auth];
    if (secret && auth !== "userPassword" && !hasSecret(rec, secret)) errors[secret] = "Required for this authentication.";
    if (auth === "nkey") {
      const seed = text(rec.secrets["nkeySeed"]).trim();
      if (seed !== "" && !(seed.startsWith("SU") && seed.length === 58)) errors["nkeySeed"] = "A user nkey seed starts with SU and is 58 characters long.";
    }
    if (auth === "creds") {
      const creds = text(rec.secrets["creds"]);
      if (creds.trim() !== "" && !creds.includes("BEGIN NATS USER JWT")) errors["creds"] = "Paste the whole .creds file: the user JWT and its seed.";
    }
    const timeout = rec.fields["requestTimeoutMs"];
    if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < 1 || timeout > MAX_REQUEST_TIMEOUT_MS)) errors["requestTimeoutMs"] = `A whole number of milliseconds, 1 to ${MAX_REQUEST_TIMEOUT_MS}.`;
    const prefix = text(rec.fields["inboxPrefix"]).trim();
    if (/[*> ]/.test(prefix)) errors["inboxPrefix"] = "A subject without wildcards or spaces.";
    const tls = tlsOf(rec.fields);
    if (tls.enabled && (tls.clientCertPem !== undefined) !== hasSecret(rec, "clientKeyPem")) errors["tls"] = tls.clientCertPem === undefined ? "A client key needs its certificate." : "A client certificate needs its private key.";
    return errors;
  },
  migrations: {},
};
