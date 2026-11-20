// A Schema Registry on a profile (DOC-21 §5.3, Open question 45 (p); mockup frame codecs-registry):
// `fields.schemaRegistry` (URL, authentication, the CA, and for NATS the subjects whose messages may
// carry the Confluent wire format) with the secrets `registryPassword` and `registryToken`; the
// connect input the server takes (`RegistryProfile`); the words of the mapping table. Pure: NATS and
// Kafka share it.
import type { RegistryAuthKind, RegistryProfile, RegistryRef, SchemaVersion } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";

export const REGISTRY_AUTH_LABELS: Record<RegistryAuthKind, string> = { none: "None", basic: "Basic: user and password", bearer: "Bearer token" };

/** The profile's registry as kept in `fields.schemaRegistry` (no secrets). */
export interface RegistryFields {
  url: string;
  auth: RegistryAuthKind;
  username?: string;
  tls: { caPem?: string; serverName?: string };
  /** NATS only: subject patterns whose messages may carry the wire format. */
  wireFormatSubjects?: string[];
}

/** The secrets a registry uses, by auth. */
export const REGISTRY_SECRETS = { password: "registryPassword", token: "registryToken" } as const;

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const object = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The profile's registry, or null when it has none. */
export function registryOf(record: ProfileRecord): RegistryFields | null {
  const raw = record.fields["schemaRegistry"];
  if (typeof raw !== "object" || raw === null) return null;
  const r = object(raw);
  const url = text(r["url"]).trim();
  if (url === "") return null;
  const auth = text(r["auth"]);
  const tls = object(r["tls"]);
  const out: RegistryFields = { url, auth: auth === "basic" || auth === "bearer" ? auth : "none", tls: {} };
  if (text(r["username"]) !== "") out.username = text(r["username"]);
  if (text(tls["caPem"]) !== "") out.tls.caPem = text(tls["caPem"]);
  if (text(tls["serverName"]) !== "") out.tls.serverName = text(tls["serverName"]);
  if (Array.isArray(r["wireFormatSubjects"])) out.wireFormatSubjects = (r["wireFormatSubjects"] as unknown[]).map(text).filter((s) => s.trim() !== "");
  return out;
}

/**
 * The profile with a registry (or none), and its secrets: a secret given replaces the stored one,
 * `undefined` keeps it; the secrets the chosen auth does not use are dropped.
 */
export function withRegistry(record: ProfileRecord, registry: RegistryFields | null, secrets: { password?: string; token?: string } = {}): ProfileRecord {
  const nextSecrets = { ...record.secrets };
  const keep = (key: string, value: string | undefined, used: boolean) => {
    if (!used) delete nextSecrets[key];
    else if (value !== undefined && value !== "") nextSecrets[key] = value;
  };
  keep(REGISTRY_SECRETS.password, secrets.password, registry?.auth === "basic");
  keep(REGISTRY_SECRETS.token, secrets.token, registry?.auth === "bearer");
  return { ...record, fields: { ...record.fields, schemaRegistry: registry }, secrets: nextSecrets };
}

/** Whether the profile holds the secret this auth needs. */
export function registrySecretSet(record: ProfileRecord, auth: RegistryAuthKind): boolean {
  if (auth === "basic") return text(record.secrets[REGISTRY_SECRETS.password]) !== "";
  if (auth === "bearer") return text(record.secrets[REGISTRY_SECRETS.token]) !== "";
  return false;
}

/**
 * What `nats.connect` (and Kafka's) and `messaging.registry.*` take. `wireFormat`: whether the tool
 * scopes the wire format to subjects (NATS: an empty list looks nowhere); Kafka leaves it out.
 */
export function registryToConnect(registry: RegistryFields, secrets: Record<string, unknown>, wireFormat: boolean): RegistryProfile {
  const secret = (key: string): string | null => (text(secrets[key]) !== "" ? text(secrets[key]) : null);
  const https = registry.url.trim().startsWith("https://");
  return {
    url: registry.url.trim(),
    auth: registry.auth,
    username: registry.auth === "basic" ? (registry.username?.trim() ?? null) : null,
    password: registry.auth === "basic" ? secret(REGISTRY_SECRETS.password) : null,
    token: registry.auth === "bearer" ? secret(REGISTRY_SECRETS.token) : null,
    tls: { enabled: https, caPem: registry.tls.caPem ?? null, serverName: registry.tls.serverName ?? null, clientCertPem: null, clientKeyPem: null },
    wireFormatSubjects: wireFormat ? (registry.wireFormatSubjects ?? []) : null,
  };
}

/** Comma- or line-separated subject patterns, trimmed. */
export function splitPatterns(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Why a registry's fields cannot be saved, by field (`url`, `username`, `secret`, `caPem`, `wireFormatSubjects`). */
export function registryProblems(registry: RegistryFields, secretGiven: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  const url = registry.url.trim();
  if (url === "") out["url"] = "A registry URL is required.";
  else if (!/^https?:\/\/[^\s/@]+(\/\S*)?$/.test(url)) out["url"] = "Use http://host:port or https://host:port.";
  if (registry.auth === "basic" && (registry.username ?? "").trim() === "") out["username"] = "A user name is required.";
  if (registry.auth !== "none" && !secretGiven) out["secret"] = registry.auth === "basic" ? "The password is required." : "The token is required.";
  if (url.startsWith("https://") && (registry.tls.caPem ?? "").trim() === "") out["caPem"] = "An https registry needs its CA certificate: no system roots are trusted.";
  for (const p of registry.wireFormatSubjects ?? []) {
    const tokens = p.split(".");
    if (tokens.some((t) => t === "") || tokens.slice(0, -1).includes(">")) {
      out["wireFormatSubjects"] = `${p}: not a subject pattern.`;
      break;
    }
  }
  return out;
}

/** The registry's host and port, for subtitles. */
export function registryHost(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function versionText(v: SchemaVersion): string {
  return v === "latest" ? "latest" : `v${v}`;
}

/** A registry reference as the mapping table shows it. */
export function registryRefText(r: RegistryRef): string {
  return "id" in r ? `registry id ${r.id}` : `${r.subject} · ${versionText(r.version)}`;
}
