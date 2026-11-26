// Which secrets a change of target takes with it (DOC-25 §3.4.8): a stored secret is only ever sent
// to the target it was entered for, so when a save changes a target field and does not set the
// secrets of that group again, the server removes them. The screen says so before the save; the
// server decides. The groups mirror `server/src/profiles/spec.rs` (a test compares the two).
import { browserKey } from "./server";

export interface TargetGroup {
  /** Dotted paths into the record's `fields`. */
  targets: readonly string[];
  /** Server field paths of the secrets sent to that target. */
  secrets: readonly string[];
}

/** Every profile has `routeId` as a target field of every group (DOC-23). */
export const ROUTE_FIELD = "routeId";

export const TARGET_GROUPS: Readonly<Record<string, readonly TargetGroup[]>> = {
  echo: [],
  nats: [
    { targets: ["servers", "tls.caPem", "tls.serverName"], secrets: ["password", "token", "nkeySeed", "creds", "tls.clientKeyPem"] },
    { targets: ["schemaRegistry.url", "schemaRegistry.tls.caPem", "schemaRegistry.tls.serverName"], secrets: ["schemaRegistry.password", "schemaRegistry.token", "schemaRegistry.tls.clientKeyPem"] },
  ],
  temporal: [
    { targets: ["address", "tls.caPem", "tls.serverName"], secrets: ["clientKeyPem", "apiKey"] },
    { targets: ["codec.endpoint", "codec.namespaces", "codec.caPem"], secrets: ["codecAuthorization"] },
    { targets: ["externalStorage.endpoint", "externalStorage.bucket", "externalStorage.region", "externalStorage.caPem"], secrets: ["s3AccessKeyId", "s3SecretAccessKey", "s3SessionToken"] },
  ],
  docker: [{ targets: ["transport", "sshHostId", "host", "port", "socketPath", "tls.enabled", "tls.caPem", "tls.serverName"], secrets: ["tls.clientKeyPem"] }],
  langgraph: [{ targets: ["url", "tls.caPem", "tls.serverName"], secrets: ["apiKey", "headerValues", "tls.clientKeyPem"] }],
};

function at(value: unknown, path: string): unknown {
  let node = value;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * The stored secrets (browser keys) a save would remove: those of a group whose target field
 * changed from `before` to `after`, less the ones typed again in the same save.
 */
export function secretsLostByTarget(tool: string, before: Record<string, unknown>, after: Record<string, unknown>, stored: ReadonlySet<string>, typed: ReadonlySet<string>): string[] {
  const lost = new Set<string>();
  const routeChanged = !same(at(before, ROUTE_FIELD), at(after, ROUTE_FIELD));
  for (const group of TARGET_GROUPS[tool] ?? []) {
    if (!routeChanged && group.targets.every((t) => same(at(before, t), at(after, t)))) continue;
    for (const field of group.secrets) {
      const key = browserKey(tool, field);
      if (stored.has(key) && !typed.has(key)) lost.add(key);
    }
  }
  return [...lost];
}
