// The Temporal profile (Mightyconsole spec §9.1): its versioned schema, defaults, validation and
// the input of `temporal.connect`. Pure, so the form and the tests share it.
import type { ConnectTemporalProfile, TemporalTlsOptions } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
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
    const apiKey = text(record.secrets["apiKey"]);
    const clientKey = text(record.secrets["clientKeyPem"]);
    if (apiKey !== "" && !tls.enabled) errors["tls"] = "An API key is only sent over TLS; turn TLS on.";
    else if ((tls.clientCertPem !== undefined) !== (clientKey !== "") && tls.enabled) {
      errors["tls"] = tls.clientCertPem === undefined ? "A client key needs its certificate." : "A client certificate needs its private key.";
    }
    return errors;
  },
  migrations: {},
  toConnect(record: ProfileRecord): ConnectTemporalProfile {
    const tls = tlsOf(record.fields);
    const options: TemporalTlsOptions = { enabled: tls.enabled };
    if (tls.enabled) {
      options.caPem = tls.caPem ?? null;
      options.clientCertPem = tls.clientCertPem ?? null;
      options.serverName = tls.serverName ?? null;
    }
    const apiKey = text(record.secrets["apiKey"]);
    const clientKeyPem = text(record.secrets["clientKeyPem"]);
    return {
      name: record.name,
      address: text(record.fields["address"]).trim() || null,
      namespace: text(record.fields["namespace"]).trim() || null,
      tls: options,
      clientKeyPem: clientKeyPem !== "" ? clientKeyPem : null,
      apiKey: apiKey !== "" ? apiKey : null,
    };
  },
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
