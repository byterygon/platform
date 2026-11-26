// What the person may do, as the UI shows it (DOC-25 §3.3, TSK-140 batch 2). `app.me` lists the
// roles in force and the permissions they grant, each with where; this reads that list the way the
// server's `Scope::covers` reads a scope, so a button can say "you cannot" before the call is sent.
// It is a hint only: the server checks every call again, and a refusal it sends (`PermissionDenied`
// with the permission, the target and the kind of reason) is worded here too.
import { isRpcError } from "@byterygon/ambidex";
import type { Me, PermissionGrant, RoleGrant } from "@/gen/api";
import * as api from "@/gen/api";
import { nameOf, scopeText } from "./session";

/** Where a call acts: a stored profile, and below it a Kubernetes context and a namespace. */
export interface Place {
  profileId?: string | undefined;
  context?: string | undefined;
  namespace?: string | undefined;
  /** The profile is the person's own personal one (or one the browser still keeps). */
  personal?: boolean | undefined;
}

/** The place of a stored profile (and a namespace or context below it). A profile the browser still keeps is the person's own. */
export function placeOfProfile(profile: { id: string; owner?: { kind: string; user?: string | null } | undefined }, below?: { namespace?: string | undefined; context?: string | undefined }): Place {
  return { profileId: profile.id, personal: profile.owner === undefined || profile.owner.kind === "personal", ...(below?.namespace ? { namespace: below.namespace } : {}), ...(below?.context ? { context: below.context } : {}) };
}

/** The target id the server builds for a place (`<profile>/ctx:<context>/ns:<namespace>`). */
export function targetId(place: Place): string | null {
  if (!place.profileId) return null;
  return `${place.profileId}${place.context ? `/ctx:${place.context}` : ""}${place.namespace ? `/ns:${place.namespace}` : ""}`;
}

/** The place a target id names (`P`, `P/ns:n`, `P/ctx:c`, `P/ctx:c/ns:n`). */
export function placeOf(id: string): Place {
  const at = id.lastIndexOf("/ns:");
  const namespace = at >= 0 ? id.slice(at + 4) : undefined;
  const head = at >= 0 ? id.slice(0, at) : id;
  const c = head.indexOf("/ctx:");
  return { profileId: c >= 0 ? head.slice(0, c) : head, ...(c >= 0 ? { context: head.slice(c + 5) } : {}), ...(namespace ? { namespace } : {}) };
}

interface Entry {
  profile: string;
  context: string | null;
  namespace: string | null;
}

/** A scope entry (`profile:P/ctx:c/ns:pattern`) in its segments; `null` for `personal` or an unreadable one. */
function parseEntry(text: string): Entry | null {
  const rest = text.startsWith("profile:") ? text.slice("profile:".length) : null;
  if (rest === null) return null;
  const at = rest.lastIndexOf("/ns:");
  const namespace = at >= 0 ? rest.slice(at + 4) : null;
  const head = at >= 0 ? rest.slice(0, at) : rest;
  const c = head.indexOf("/ctx:");
  return { profile: c >= 0 ? head.slice(0, c) : head, context: c >= 0 ? head.slice(c + 5) : null, namespace };
}

/** A name, or a prefix ending in `*`. */
function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/** Whether `entry` covers `place`: the entry's segments are a prefix of the place's, as on the server. */
export function covers(entry: string, place: Place): boolean {
  if (entry === "personal") return place.personal === true;
  const e = parseEntry(entry);
  if (e === null || !place.profileId || e.profile !== place.profileId) return false;
  if (e.context !== null) {
    if (place.context !== e.context) return false;
  } else if (place.context !== undefined && e.namespace !== null) {
    return false;
  }
  return e.namespace === null || (place.namespace !== undefined && matches(e.namespace, place.namespace));
}

function grantOf(me: Pick<Me, "permissions">, perm: string): PermissionGrant | undefined {
  return me.permissions.find((g) => g.perm === perm);
}

/** Whether any role in force grants `perm`, wherever. */
export function holdsAnywhere(me: Pick<Me, "permissions">, perm: string): boolean {
  const grant = grantOf(me, perm);
  return grant !== undefined && (grant.everywhere || grant.scope.length > 0);
}

/**
 * Whether the person holds `perm` at `place`. Without a place, whether they hold it anywhere (the
 * question of a tool's entry). On their own personal profiles a person holds every permission of
 * the tool, provided they hold `profiles.personal` (DOC-25 §3.3.3).
 */
export function holds(me: Pick<Me, "permissions">, perm: string, place?: Place): boolean {
  if (perm === "app.self") return true;
  if (place === undefined) return holdsAnywhere(me, perm);
  if (place.personal === true && holdsAnywhere(me, "profiles.personal")) return true;
  const grant = grantOf(me, perm);
  if (grant === undefined) return false;
  return grant.everywhere || grant.scope.some((entry) => covers(entry, place));
}

/** The permission a procedure (`nats.js.streams.delete`) needs, from the generated table. */
export function permOf(procedure: string): string | null {
  let node: unknown = api.procedures;
  for (const part of procedure.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  const perm = (node as { perm?: unknown } | undefined)?.perm;
  return typeof perm === "string" ? perm : null;
}

/** The risk of a procedure (`Read`, `Write`, `Destructive`, …). */
export function riskOf(procedure: string): string | null {
  let node: unknown = api.procedures;
  for (const part of procedure.split(".")) {
    if (typeof node !== "object" || node === null) return null;
    node = (node as Record<string, unknown>)[part];
  }
  const risk = (node as { risk?: unknown } | undefined)?.risk;
  return typeof risk === "string" ? risk : null;
}

/** Whether the person may call `procedure` at `place`; `true` when the table does not know it. */
export function mayCall(me: Pick<Me, "permissions">, procedure: string, place?: Place): boolean {
  const perm = permOf(procedure);
  return perm === null || holds(me, perm, place);
}

/** What a tool's entry needs: the permission to read something of it. */
export function toolPerm(tool: string): string {
  return `${tool}.read`;
}

/**
 * Whether the person can use a tool at all: they hold its read permission somewhere, or they may
 * keep personal profiles (and hold every permission of the tool on those).
 */
export function toolOpen(me: Pick<Me, "permissions">, tool: string): boolean {
  return holdsAnywhere(me, toolPerm(tool)) || holdsAnywhere(me, "profiles.personal");
}

/** The roles in force that apply at `place` (everywhere, or scoped to cover it). */
export function rolesAt(me: Pick<Me, "roles">, place?: Place): RoleGrant[] {
  if (place === undefined) return [...me.roles];
  return me.roles.filter((r) => r.scope === null || r.scope.some((entry) => covers(entry, place)));
}

/** "operator", or "operator and member", or "operator, viewer and member". */
export function listRoles(roles: readonly RoleGrant[]): string {
  const names = [...new Set(roles.map((r) => r.role))];
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────

/** `details` of a `PermissionDenied` the server sent (DOC-25 §3.3.4); never the caller's other permissions. */
export interface DeniedDetails {
  perm: string;
  target?: { kind: string; id: string };
  /** `missing`, `scope`, `unknown` or `policy`. */
  reason: string;
}

/** The details of a refusal, `null` for any other error (or a refusal without them). */
export function denialOf(error: unknown): DeniedDetails | null {
  if (!isRpcError(error) || error.code !== "PermissionDenied") return null;
  const d = (error.details ?? undefined) as Partial<DeniedDetails> | undefined;
  if (typeof d?.perm !== "string") return null;
  const out: DeniedDetails = { perm: d.perm, reason: typeof d.reason === "string" ? d.reason : "policy" };
  if (d.target && typeof d.target.id === "string") out.target = { kind: String(d.target.kind), id: d.target.id };
  return out;
}

/** Everything the "you cannot do this because X, ask Y" text says. */
export interface Refusal {
  perm: string;
  /** What the person tried, as a phrase that goes before "needs": "Deleting a stream". */
  what: string | null;
  /** Where, in the person's words: a profile's name, "orders-eu in orders-temporal", or null. */
  where: string | null;
  /** The target the server named, for the access request. */
  target: string | null;
  reason: "missing" | "scope" | "unknown" | "policy";
  /** The roles that apply at that place, and whether they cover it. */
  roles: RoleGrant[];
  at: Date;
}

/** What the caller knows about where a call acts, so the text can use names, not ids. */
export interface Where {
  place?: Place;
  /** The profile's name. */
  profile?: string;
  /** The namespace, context, bucket… in words ("namespace orders-eu"). */
  below?: string;
}

function whereText(where: Where | undefined, target: string | null): string | null {
  if (where?.profile) return where.below ? `${where.below} of ${where.profile}` : where.profile;
  return target;
}

function reasonOf(value: string | undefined): Refusal["reason"] {
  return value === "missing" || value === "scope" || value === "unknown" ? value : "policy";
}

/** The refusal of a call the UI knows it cannot make: the person's roles at `where` lack `perm`. */
export function refusalBefore(me: Pick<Me, "roles" | "permissions">, perm: string, what: string | null, where?: Where, now: Date = new Date()): Refusal {
  const anywhere = holdsAnywhere(me, perm);
  return {
    perm,
    what,
    where: whereText(where, targetId(where?.place ?? {})),
    target: targetId(where?.place ?? {}),
    reason: anywhere ? "scope" : "missing",
    roles: rolesAt(me, where?.place),
    at: now,
  };
}

/** The refusal the server sent, worded with what the caller knows about the place. */
export function refusalAfter(me: Pick<Me, "roles">, details: DeniedDetails, what: string | null, where?: Where, now: Date = new Date()): Refusal {
  const target = details.target?.id ?? targetId(where?.place ?? {});
  return { perm: details.perm, what, where: whereText(where, target), target, reason: reasonOf(details.reason), roles: rolesAt(me, where?.place), at: now };
}

/** The headline: "Deleting a stream needs nats.destroy on nats-prod". */
export function headline(r: Refusal): string {
  return `${r.what ?? "This"} needs ${r.perm}${r.where ? ` on ${r.where}` : ""}`;
}

/** The line under it: which of the person's roles apply, and why they fall short. */
export function becauseText(r: Refusal): string {
  if (r.reason === "unknown") return `${r.perm} is not a permission this server knows, so nothing grants it.`;
  if (r.reason === "policy") return "The server's policy refuses this for your session, whatever your roles say.";
  if (r.roles.length > 0) {
    const many = new Set(r.roles.map((x) => x.role)).size > 1;
    return `Your ${many ? "roles" : "role"} ${r.where ? "there" : "here"}, ${listRoles(r.roles)}, ${many ? "do" : "does"} not include ${r.perm}.`;
  }
  if (r.reason === "scope") return `${r.perm} is granted to you elsewhere, not ${r.where ? `on ${r.where}` : "here"}.`;
  return `None of your roles covers ${r.where ?? "this"}.`;
}

/** "Who can grant it": the administrators by name when the server told them, else the role. */
export function grantersText(admins: readonly string[] | null): string {
  if (admins === null || admins.length === 0) return "An administrator can grant it.";
  const shown = admins.slice(0, 3);
  const more = admins.length - shown.length;
  const list = shown.length === 1 ? shown[0]! : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
  return `Who can grant it: ${list}${more > 0 ? ` and ${more} more` : ""} (administrators).`;
}

/** The plain text of a request for access, with the permission and the place. */
export function requestOf(me: Pick<Me, "displayName" | "username" | "user" | "email" | "tenant" | "roles">, r: Refusal): string {
  const lines = [`Access request for Mightyconsole (${me.tenant})`, `Name: ${nameOf(me)}`];
  if (me.email) lines.push(`Email: ${me.email}`);
  lines.push(`User: ${me.user}`);
  const groups = me.roles.map((x) => x.via).filter((v) => v.startsWith("group:")).map((v) => v.slice("group:".length));
  if (groups.length > 0) lines.push(`Groups: ${[...new Set(groups)].join(", ")}`);
  lines.push(`Needs: ${r.perm}${r.where ? ` on ${r.where}` : ""}`);
  if (r.target && r.target !== r.where) lines.push(`Target: ${r.target}`);
  lines.push(`Roles now: ${me.roles.map((x) => `${x.role} (${scopeText(x.scope)})`).join("; ") || "none"}`);
  lines.push(`When: ${r.at.toISOString()}`);
  return lines.join("\n");
}
