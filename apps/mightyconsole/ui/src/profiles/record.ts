// A connection profile (Mightyconsole spec §4.2): one record per profile, versioned by its tool's
// profile schema. `fields` holds the tool's settings, `secrets` the passwords, tokens and keys
// (stored in plain, DOC-20 decision 5, and left out of exports by default), `extras` the tool's
// local schemas, mappings, templates, saved filters and bookmarks.

export interface ProfileRecord {
  /** ULID. */
  id: string;
  /** The tool's id: `echo`, `nats`, `kafka`, `k8s`, `temporal`, `docker`, `langgraph`. */
  tool: string;
  /** The tool's profile schema version. */
  version: number;
  /** Unique per tool. */
  name: string;
  /** An optional label colour, a token palette name. */
  color?: string;
  createdAt: string;
  updatedAt: string;
  fields: Record<string, unknown>;
  /**
   * Secret values. In a record read from the server (TSK-139) always empty: the server never
   * answers a value; a form fills it with what the person typed, for the save or a test.
   */
  secrets: Record<string, unknown>;
  extras: Record<string, unknown>;
  /** A server record's version: an edit names it, and a stale one is refused. */
  etag?: string;
  /** What the person may do with a server record: `owner`, `edit`, `use` or `metadata`. */
  access?: string;
  /** Whose a server record is. */
  owner?: { kind: "personal"; user?: string | null } | { kind: "shared" };
  /** The secrets a server record holds (browser keys), set but never shown. */
  storedSecrets?: string[];
  /** Who set each stored secret (browser key) and when (Unix ms): status only, never a value. */
  secretInfo?: Record<string, { setBy: string; setAt: number }>;
  /** A browser record already moved to the server: the profile it became (DOC-25 §3.4.9). */
  importedAs?: string;
}

/** Whether a secret is given: typed in `secrets`, or stored on the server. */
export function hasSecret(record: Pick<ProfileRecord, "secrets" | "storedSecrets">, key: string): boolean {
  const value = record.secrets[key];
  return (typeof value === "string" && value.trim() !== "") || (record.storedSecrets?.includes(key) ?? false);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID: 48 bits of milliseconds and 80 random bits, Crockford base32. */
export function ulid(now: number = Date.now(), random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = random(16);
  let rest = "";
  for (let i = 0; i < 16; i++) rest += CROCKFORD[bytes[i]! % 32]!;
  return time + rest;
}

/** Whether a value looks like a stored record (the shape, not the tool's fields). */
export function isRecord(value: unknown): value is ProfileRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const object = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);
  return (
    typeof r["id"] === "string" &&
    r["id"] !== "" &&
    typeof r["tool"] === "string" &&
    typeof r["version"] === "number" &&
    Number.isInteger(r["version"]) &&
    typeof r["name"] === "string" &&
    typeof r["createdAt"] === "string" &&
    typeof r["updatedAt"] === "string" &&
    object(r["fields"]) &&
    object(r["secrets"]) &&
    object(r["extras"]) &&
    (r["color"] === undefined || typeof r["color"] === "string")
  );
}

/** Whether the record holds any secret. */
export function hasSecrets(record: ProfileRecord): boolean {
  return Object.values(record.secrets).some((v) => v !== undefined && v !== null && v !== "");
}

/** `name`, or `name (2)`, `name (3)`, … whichever is not in `taken`. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const base = name.replace(/ \(\d+\)$/, "");
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}
