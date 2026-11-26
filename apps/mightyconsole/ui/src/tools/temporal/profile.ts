// The Temporal profile (Mightyconsole spec §9.1): its versioned schema, defaults, validation and
// the input of `temporal.connect`. Pure, so the form and the tests share it.
import { hasSecret, type ProfileRecord } from "@/profiles/record";
import type { FieldErrors, ProfileSchema } from "../types";

export const DEFAULT_ADDRESS = "127.0.0.1:7233";
export const DEFAULT_NAMESPACE = "default";
export const DEFAULT_PAGE_SIZE = 50;

/** A saved visibility query, a child of Workflows in the tree. */
export interface SavedQuery {
  name: string;
  query: string;
}

/** The profile's TLS fields (`TemporalTlsOptions` of spec §4.2; the client key is a secret). */
export interface TlsFields {
  enabled: boolean;
  caPem?: string;
  clientCertPem?: string;
  serverName?: string;
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** The SDKs' default threshold: payloads this size or larger are stored outside. */
export const DEFAULT_THRESHOLD_BYTES = 256 * 1024;

/**
 * External Storage (TSK-103): where the SDKs' S3 driver keeps large payloads. Its keys are
 * secrets: `s3AccessKeyId`, `s3SecretAccessKey`, `s3SessionToken`.
 */
export interface ExternalStorageFields {
  enabled: boolean;
  bucket: string;
  endpoint: string;
  region: string;
  pathStyle: boolean;
  /** Other buckets references may name, comma or line separated. */
  readBuckets: string;
  caPem: string;
  thresholdBytes?: number | undefined;
}

export function externalStorageOf(fields: Record<string, unknown>): ExternalStorageFields {
  const raw = fields["externalStorage"];
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: ExternalStorageFields = {
    enabled: o["enabled"] === true,
    bucket: text(o["bucket"]),
    endpoint: text(o["endpoint"]),
    region: text(o["region"]),
    pathStyle: o["pathStyle"] === true,
    readBuckets: text(o["readBuckets"]),
    caPem: text(o["caPem"]),
  };
  if (typeof o["thresholdBytes"] === "number") out.thresholdBytes = o["thresholdBytes"];
  return out;
}

/** The profile's payload codec (TSK-92, spec §9.5): a codec server of the user's own. Its
 * Authorization header is the secret `codecAuthorization`. */
export interface PayloadCodecFields {
  enabled: boolean;
  endpoint: string;
  /** One "namespace url" per line. */
  namespaces: string;
  caPem: string;
  sendNamespace: boolean;
  encodeInputs: boolean;
  timeoutMs?: number | undefined;
}

export function payloadCodecOf(fields: Record<string, unknown>): PayloadCodecFields {
  const raw = fields["codec"];
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled: o["enabled"] === true,
    endpoint: text(o["endpoint"]),
    namespaces: text(o["namespaces"]),
    caPem: text(o["caPem"]),
    sendNamespace: o["sendNamespace"] !== false,
    encodeInputs: o["encodeInputs"] !== false,
    ...(typeof o["timeoutMs"] === "number" ? { timeoutMs: o["timeoutMs"] } : {}),
  };
}

/** The per-namespace endpoints of "namespace url" lines; `null` for a line that is not one. */
export function codecNamespacesOf(lines: string): { namespace: string; endpoint: string }[] | null {
  const out: { namespace: string; endpoint: string }[] = [];
  for (const line of lines.split("\n").map((l) => l.trim()).filter((l) => l !== "")) {
    const m = /^(\S+)\s*(?:→|->|=|\s)\s*(https?:\/\/\S+)$/.exec(line);
    if (!m) return null;
    out.push({ namespace: m[1]!, endpoint: m[2]! });
  }
  return out;
}

/** An endpoint the server will call: https, or http on localhost. */
export function codecEndpointError(url: string): string | null {
  const m = /^(https?):\/\/([^/:\s]+|\[[^\]]+\])(:\d+)?(\/\S*)?$/.exec(url.trim());
  if (!m) return "An https:// URL, for example https://codec.internal:8888.";
  if (m[1] === "http" && !["localhost", "127.0.0.1", "[::1]"].includes(m[2]!.toLowerCase())) return "Plain http is for localhost only; use https with the codec's CA.";
  return null;
}

/** The Web UI's origins of a local dev server, allowed by default. */
export const DEFAULT_CODEC_ORIGINS = "http://localhost:8233, http://127.0.0.1:8233";

/** The codec endpoint (TSK-103): Temporal's codec-server protocol for the Web UI and the CLI. */
export interface CodecServerFields {
  enabled: boolean;
  /** Comma or line separated. */
  allowedOrigins: string;
  /** Serve callers that send no token (DOC-25 Open question 9): off. */
  allowAnonymous: boolean;
}

export function codecServerOf(fields: Record<string, unknown>): CodecServerFields {
  const raw = fields["codecServer"];
  const o = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    enabled: o["enabled"] === true,
    allowedOrigins: typeof o["allowedOrigins"] === "string" ? o["allowedOrigins"] : DEFAULT_CODEC_ORIGINS,
    allowAnonymous: o["allowAnonymous"] === true,
  };
}

/** The codec endpoint of a saved profile on this server. */
export function codecEndpointOf(origin: string, profileId: string): string {
  return `${origin.replace(/\/+$/, "")}/codec/${encodeURIComponent(profileId)}`;
}

/** The buckets of a comma- or line-separated list. */
export function bucketsOf(list: string): string[] {
  return list
    .split(/[\s,]+/)
    .map((b) => b.trim())
    .filter((b) => b !== "");
}

export function tlsOf(fields: Record<string, unknown>): TlsFields {
  const raw = fields["tls"];
  const tls = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: TlsFields = { enabled: tls["enabled"] === true };
  for (const key of ["caPem", "clientCertPem", "serverName"] as const) {
    const value = text(tls[key]);
    if (value !== "") out[key] = value;
  }
  return out;
}

export function savedQueriesOf(extras: Record<string, unknown>): SavedQuery[] {
  const raw = extras["savedQueries"];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): SavedQuery[] => {
    if (typeof item !== "object" || item === null) return [];
    const { name, query } = item as Record<string, unknown>;
    return typeof name === "string" && name !== "" && typeof query === "string" ? [{ name, query }] : [];
  });
}

/** `host:port`, a host name, an IPv4 or a bracketed IPv6 address, then a port. */
const HOST_PORT = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?):(\d{1,5})$/;

export function validateAddress(address: string): string | null {
  const match = HOST_PORT.exec(address.trim());
  if (!match) return "Use host:port, for example 127.0.0.1:7233.";
  const port = Number(match[3]);
  return port >= 1 && port <= 65535 ? null : "The port is 1 to 65535.";
}

export const profile: ProfileSchema = {
  version: 1,
  defaults: () => ({
    fields: { address: DEFAULT_ADDRESS, namespace: DEFAULT_NAMESPACE, tls: { enabled: false }, pageSize: DEFAULT_PAGE_SIZE },
    secrets: {},
    extras: { savedQueries: [], schemas: [], mappings: [] },
  }),
  validate(record): FieldErrors {
    const errors: FieldErrors = {};
    const address = text(record.fields["address"]).trim();
    const addressError = validateAddress(address === "" ? DEFAULT_ADDRESS : address);
    if (addressError) errors["address"] = addressError;
    if (record.fields["namespace"] !== undefined && text(record.fields["namespace"]).trim() === "") errors["namespace"] = "A namespace name is required.";
    const pageSize = record.fields["pageSize"];
    if (pageSize !== undefined && (typeof pageSize !== "number" || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000)) errors["pageSize"] = "A whole number from 1 to 1000.";
    const tls = tlsOf(record.fields);
    const apiKey = hasSecret(record, "apiKey");
    const clientKey = hasSecret(record, "clientKeyPem");
    const payloadCodec = payloadCodecOf(record.fields);
    if (payloadCodec.enabled) {
      const e = payloadCodec.endpoint.trim() === "" ? "The codec server's URL is required." : codecEndpointError(payloadCodec.endpoint);
      if (e) errors["codec.endpoint"] = e;
      if (codecNamespacesOf(payloadCodec.namespaces) === null) errors["codec.namespaces"] = "One namespace and its URL per line: payments https://codec-payments:8888";
      const anyHttps = /^https:/.test(payloadCodec.endpoint.trim()) || (codecNamespacesOf(payloadCodec.namespaces) ?? []).some((n) => n.endpoint.startsWith("https:"));
      if (anyHttps && payloadCodec.caPem.trim() === "") errors["codec.caPem"] = "An https codec needs its CA certificate; the system's roots are not used.";
      if (payloadCodec.timeoutMs !== undefined && (!Number.isInteger(payloadCodec.timeoutMs) || payloadCodec.timeoutMs < 100)) errors["codec.timeoutMs"] = "A whole number of milliseconds, 100 or more.";
    }
    const ext = externalStorageOf(record.fields);
    const codec = codecServerOf(record.fields);
    if (codec.enabled && !ext.enabled) errors["codecServer"] = "The codec endpoint resolves External Storage; turn External Storage on.";
    if (codec.enabled && bucketsOf(codec.allowedOrigins).some((o) => !/^https?:\/\/[^\s/]+$/.test(o))) errors["codecServer.allowedOrigins"] = "Origins are scheme://host[:port], for example http://localhost:8233.";
    if (ext.enabled) {
      if (ext.bucket.trim() === "") errors["externalStorage.bucket"] = "Name the bucket.";
      if (ext.endpoint.trim() !== "" && !/^https?:\/\/[^\s/]+(\/[^\s]*)?$/.test(ext.endpoint.trim())) errors["externalStorage.endpoint"] = "An http:// or https:// URL, for example https://minio.example.com:9000.";
      if (ext.thresholdBytes !== undefined && (!Number.isInteger(ext.thresholdBytes) || ext.thresholdBytes < 1)) errors["externalStorage.thresholdBytes"] = "A whole number of bytes, 1 or more.";
    }
    if (apiKey && !tls.enabled) errors["tls"] = "An API key is only sent over TLS; turn TLS on.";
    else if ((tls.clientCertPem !== undefined) !== clientKey && tls.enabled) {
      errors["tls"] = tls.clientCertPem === undefined ? "A client key needs its certificate." : "A client certificate needs its private key.";
    }
    return errors;
  },
  migrations: {},
};

/** The page size a profile asks for, 50 when it names none. */
export function pageSizeOf(record: ProfileRecord): number {
  const value = record.fields["pageSize"];
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000 ? value : DEFAULT_PAGE_SIZE;
}

/** The namespace a profile opens first. */
export function namespaceOf(record: ProfileRecord): string {
  return text(record.fields["namespace"]).trim() || DEFAULT_NAMESPACE;
}

/** The frontend's `host:port` (the CLI commands name it). */
export function addressOf(record: ProfileRecord): string {
  return text(record.fields["address"]).trim() || DEFAULT_ADDRESS;
}
