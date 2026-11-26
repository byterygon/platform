// Profiles on the server (DOC-25 §3.4.2, §3.4.7, TSK-139): the app reads and writes its profiles
// through `profiles.*` and `secrets.*`. Secrets are write-only: a record read from the server
// holds no secret value, only which secrets are set (`storedSecrets`); a form's typed secrets go
// up with the save and are never read back.
//
// The forms keep the secret keys the browser always used; the server names some of them
// differently (DOC-25 §3.4.1, Open question 23): the maps below translate both ways.
import type { MightyClient } from "@/app/client";
import type { OwnerWire, ProfileView } from "@/gen/api";
import type { ProfileRecord } from "./record";

/** Browser secret key → the server's field path, where they differ. */
const SERVER_KEYS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  nats: { clientKeyPem: "tls.clientKeyPem", registryPassword: "schemaRegistry.password", registryToken: "schemaRegistry.token" },
  langgraph: { clientKeyPem: "tls.clientKeyPem", headerLines: "headerValues" },
  docker: { clientKeyPem: "tls.clientKeyPem" },
};

/** The server's field path of a browser secret key. */
export function serverKey(tool: string, key: string): string {
  return SERVER_KEYS[tool]?.[key] ?? key;
}

/** The browser secret key of a server field path. */
export function browserKey(tool: string, field: string): string {
  const map = SERVER_KEYS[tool] ?? {};
  return Object.keys(map).find((k) => map[k] === field) ?? field;
}

/** The typed secrets (non-empty strings) by server field path. */
export function serverSecrets(tool: string, secrets: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(secrets)) {
    if (typeof value === "string" && value !== "") out[serverKey(tool, key)] = value;
  }
  return out;
}

/** The names of LangGraph's extra headers (not secret), kept in `fields.headers` (Open question 23). */
function withHeaderNames(tool: string, fields: Record<string, unknown>, secrets: Record<string, unknown>): Record<string, unknown> {
  const lines = secrets["headerLines"];
  if (tool !== "langgraph" || typeof lines !== "string") return fields;
  const names = lines
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.indexOf(":") > 0)
    .map((l) => l.slice(0, l.indexOf(":")).trim());
  return { ...fields, headers: names };
}

const object = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** A server profile as the app's record: no secret values; what is set in `storedSecrets`. */
export function fromView(view: ProfileView): ProfileRecord {
  return {
    id: view.id,
    tool: view.tool,
    version: view.version,
    name: view.name,
    ...(view.color ? { color: view.color } : {}),
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
    fields: object(view.fields),
    secrets: {},
    extras: object(view.extras),
    etag: view.etag,
    access: view.access,
    owner: view.owner,
    storedSecrets: view.secrets.filter((s) => s.set).map((s) => browserKey(view.tool, s.field)),
    secretInfo: Object.fromEntries(view.secrets.filter((s) => s.set).map((s) => [browserKey(view.tool, s.field), { setBy: s.setBy, setAt: s.setAt }])),
  };
}

/** Every profile the person sees. */
export async function listProfiles(client: MightyClient): Promise<ProfileRecord[]> {
  const out = await client.profiles.list({});
  return out.profiles.map(fromView);
}

export interface SaveOptions {
  /** `add` and `duplicate` make a profile; `edit` changes `base`. */
  mode: "add" | "edit" | "duplicate";
  base?: ProfileRecord | undefined;
  /** Stored secrets to remove (browser keys), for an edit. */
  remove?: readonly string[];
  /** A new profile for the tenant (needs `profiles.manage`), else the caller's own. */
  shared?: boolean;
}

export interface Saved {
  record: ProfileRecord;
  /** Secrets the server removed because a target field changed (DOC-25 §3.4.8), browser keys. */
  removedSecrets: string[];
}

/**
 * Saves the form's record: its `secrets` are what was typed (empty ones are left out); the stored
 * ones stay unless named in `remove` or unbound by a changed target.
 */
export async function saveProfile(client: MightyClient, record: ProfileRecord, options: SaveOptions): Promise<Saved> {
  const fields = withHeaderNames(record.tool, record.fields, record.secrets);
  const secrets = serverSecrets(record.tool, record.secrets);
  if (options.mode === "edit" && options.base) {
    const base = options.base;
    const out = await client.profiles.update({
      id: base.id,
      etag: base.etag ?? "",
      name: record.name,
      color: record.color ?? "",
      fields,
      extras: record.extras,
      secrets,
    });
    for (const key of options.remove ?? []) {
      if (key in record.secrets && record.secrets[key] !== "") continue;
      await client.secrets.remove({ owner: { kind: "profile", id: base.id }, field: serverKey(record.tool, key) });
    }
    const after = options.remove?.length ? await client.profiles.get({ id: base.id }) : out.profile;
    return { record: fromView(after), removedSecrets: out.removedSecrets.map((f) => browserKey(record.tool, f)) };
  }
  if (options.mode === "duplicate" && options.base) {
    // The server copies the stored secrets only when the caller may edit the source and the copy
    // keeps its owner (DOC-21 Open question 22); the form's changes follow as an edit.
    const copy = await client.profiles.duplicate({ id: options.base.id, name: record.name });
    return saveProfile(client, record, { mode: "edit", base: fromView(copy.profile) });
  }
  const owner: OwnerWire = options.shared ? { kind: "shared" } : { kind: "personal" };
  const out = await client.profiles.create({ tool: record.tool, name: record.name, color: record.color ?? null, owner, fields, extras: record.extras, secrets });
  return { record: fromView(out), removedSecrets: [] };
}

/**
 * Saves a change to a stored record's fields or extras (a saved filter, a trusted host key, a
 * registry), with any secret typed for it (a registry's password).
 */
export async function updateRecord(client: MightyClient, record: ProfileRecord): Promise<ProfileRecord> {
  const out = await client.profiles.update({ id: record.id, etag: record.etag ?? "", fields: record.fields, extras: record.extras, secrets: serverSecrets(record.tool, record.secrets) });
  return fromView(out.profile);
}

/** Deletes a profile; the server asks the person to type its name (DOC-25 §3.3.6). */
export async function deleteProfile(client: MightyClient, record: ProfileRecord): Promise<void> {
  await client.profiles.delete({ id: record.id, name: record.name });
}

/** The draft of `<tool>.test` (Test connection): the form's record and its typed secrets. */
export function testDraft(record: ProfileRecord): { name: string; fields: Record<string, unknown>; extras: Record<string, unknown>; secrets: Record<string, string> } {
  return { name: record.name, fields: withHeaderNames(record.tool, record.fields, record.secrets), extras: record.extras, secrets: serverSecrets(record.tool, record.secrets) };
}

/**
 * `profiles.import` of a browser record (DOC-25 §3.4.9), idempotent by its id; then checks that
 * every secret it sent is set on the server. Returns the profile it became.
 */
export async function importRecord(client: MightyClient, record: ProfileRecord, shared = false): Promise<ProfileRecord> {
  const secrets = serverSecrets(record.tool, record.secrets);
  const out = await client.profiles.import({
    sourceId: record.id,
    record: { tool: record.tool, version: record.version, name: record.name, color: record.color ?? null, fields: withHeaderNames(record.tool, record.fields, record.secrets), extras: record.extras },
    secrets,
    owner: shared ? { kind: "shared" } : { kind: "personal" },
  });
  const status = await client.secrets.status({ owner: { kind: "profile", id: out.profile.id } });
  const set = new Set(status.secrets.filter((s) => s.set).map((s) => s.field));
  // A Docker profile of version 1 leaves its login with the SSH host it now names (DOC-23 (z)).
  const hostId = (out.profile.fields as Record<string, unknown> | null)?.["sshHostId"];
  if (typeof hostId === "string" && hostId !== "") {
    const host = await client.secrets.status({ owner: { kind: "sshHost", id: hostId } });
    for (const s of host.secrets) if (s.set) set.add(s.field);
  }
  const missing = Object.keys(secrets).filter((f) => !set.has(f));
  if (missing.length > 0) throw new Error(`${record.name}: the server does not have ${missing.join(", ")}`);
  return fromView(out.profile);
}

/**
 * Test connection of the profile form (`<tool>.test`): the draft connects on the server and
 * nothing is kept. `basedOn` is the stored profile the form edits, whose secrets fill the ones
 * left empty while the draft keeps its target.
 */
export async function testProfile(client: MightyClient, record: ProfileRecord, basedOn?: string): Promise<void> {
  const input = { draft: testDraft(record), ...(basedOn ? { basedOn } : {}) };
  switch (record.tool) {
    case "echo":
      await client.echo.test(input);
      return;
    case "nats":
      await client.nats.test(input);
      return;
    case "temporal":
      await client.temporal.test(input);
      return;
    case "docker":
      await client.docker.test(input);
      return;
    case "langgraph":
      await client.langgraph.test(input);
      return;
    default:
      throw new Error(`${record.tool} has no Test connection`);
  }
}
