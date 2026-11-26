// Users and roles, the logic (DOC-25 §3.3.2, §3.3.3; TSK-135 §5): the role matrix drawn from the
// server's permission catalogue (tools × risks, then the sensitive permissions, then everything
// else), how a role reached a person, and the scope entries of an assignment.
import type { AssignmentInput, CataloguePermission, RoleGrant, UserSummary } from "@/gen/api";

/** The columns of the matrix, in order: the three risks, then the sensitive permissions with their names. */
export const COLUMNS = [
  { id: "read", label: "Read", perm: (tool: string) => `${tool}.read` },
  { id: "write", label: "Write", perm: (tool: string) => `${tool}.write` },
  { id: "destroy", label: "Destroy", perm: (tool: string) => `${tool}.destroy` },
  { id: "exec", label: "Exec", perm: (tool: string) => `${tool}.exec` },
  { id: "files", label: "Container files", perm: (tool: string) => `${tool}.files.read` },
  { id: "secrets", label: "Reveal Secrets", perm: (tool: string) => `${tool}.secrets.read` },
] as const;

export type ColumnId = (typeof COLUMNS)[number]["id"];

/** One tool's row: the permission in each column, or `null` where the tool has none. */
export interface MatrixRow {
  tool: string;
  cells: Record<ColumnId, string | null>;
}

/** What the matrix and the list under it show of the catalogue. */
export interface Matrix {
  rows: MatrixRow[];
  /** Permissions that are not a tool's: held everywhere or not at all. */
  everywhere: string[];
}

/** The tools of the catalogue (a name before the first dot with a `.read` of its own), in a stable order. */
export function toolsOf(catalogue: readonly CataloguePermission[]): string[] {
  const perms = new Set(catalogue.map((c) => c.perm));
  const tools = new Set<string>();
  for (const perm of perms) {
    const dot = perm.indexOf(".");
    if (dot > 0 && perms.has(`${perm.slice(0, dot)}.write`) && perms.has(`${perm.slice(0, dot)}.read`)) tools.add(perm.slice(0, dot));
  }
  return [...tools].sort();
}

export function matrixOf(catalogue: readonly CataloguePermission[]): Matrix {
  const perms = new Set(catalogue.map((c) => c.perm));
  const tools = toolsOf(catalogue);
  const inMatrix = new Set<string>();
  const rows = tools.map((tool) => {
    const cells = {} as Record<ColumnId, string | null>;
    for (const column of COLUMNS) {
      const perm = column.perm(tool);
      cells[column.id] = perms.has(perm) ? perm : null;
      if (perms.has(perm)) inMatrix.add(perm);
    }
    return { tool, cells };
  });
  const everywhere = [...perms].filter((p) => !inMatrix.has(p) && p !== "app.self").sort();
  return { rows, everywhere };
}

/** A permission's name as the people who write roles say it: "Exec", "Reveal Secrets", or the raw name. */
export function permLabel(perm: string): string {
  for (const column of COLUMNS) if (tool(perm) !== null && column.perm(tool(perm)!) === perm) return column.label;
  return perm;
}

function tool(perm: string): string | null {
  const dot = perm.indexOf(".");
  return dot > 0 ? perm.slice(0, dot) : null;
}

/** A role's permission set after a cell is toggled; a role with Exec also needs `term.write` (3.3.2). */
export function toggled(permissions: readonly string[], perm: string, on: boolean): string[] {
  const next = new Set(permissions);
  if (on) next.add(perm);
  else next.delete(perm);
  // `term.write` follows Exec: a terminal needs it, and nothing else does.
  if ([...next].some((p) => p.endsWith(".exec"))) next.add("term.write");
  else next.delete("term.write");
  return [...next].sort();
}

/** "role-id" for a copy of `id` that is not taken. */
export function copyId(id: string, taken: readonly string[]): string {
  const base = `${id}-copy`.slice(0, 30);
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base}-x`;
}

/** The id a role name makes (`[a-z][a-z0-9-]{1,31}`): "Release manager" → "release-manager". */
export function idFromName(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(id) ? id.slice(0, 32) : `r-${id}`.slice(0, 32);
}

export function validRoleId(id: string): boolean {
  return /^[a-z][a-z0-9-]{1,31}$/.test(id);
}

/** Where an assignment applies, in words: "everywhere", or each entry with the profile named when it is known. */
export function whereText(scope: readonly string[] | null, nameOf: (profileId: string) => string | undefined): string {
  if (scope === null) return "everywhere";
  if (scope.length === 0) return "nowhere";
  return scope
    .map((entry) => {
      if (entry === "personal") return "personal profiles";
      const m = /^profile:([^/]+)((?:\/ctx:[^/]+)?)(?:\/ns:(.+))?$/.exec(entry);
      if (!m) return entry;
      const name = nameOf(m[1]!) ?? m[1]!;
      const below = [m[2] ? `context ${m[2].slice(5)}` : "", m[3] ? `namespaces ${m[3]}` : ""].filter(Boolean).join(", ");
      return below ? `${name} › ${below}` : name;
    })
    .join(", ");
}

/** The scope entries an administrator composes: profiles, with one namespace pattern when a single profile is chosen. */
export function scopeOf(profileIds: readonly string[], namespace: string): string[] | null {
  if (profileIds.length === 0) return null;
  const ns = namespace.trim();
  return profileIds.map((id) => (profileIds.length === 1 && ns ? `profile:${id}/ns:${ns}` : `profile:${id}`));
}

/** How a role reached the person, for the "From" column: the groups and "direct", without repeats. */
export function fromText(roles: readonly RoleGrant[]): string {
  const parts = new Set<string>();
  for (const r of roles) {
    if (r.via === "direct") parts.add("direct");
    else if (r.via === "pinned") parts.add("pinned");
    else if (r.via === "default") parts.add("everyone");
    else if (r.via.startsWith("group:")) parts.add(r.via.slice("group:".length).replace(/^(idp|local):/, ""));
    else parts.add(r.via);
  }
  return [...parts].join(", ");
}

/** The person's direct assignments, as `admin.users.setRoles` takes them. */
export function directOf(user: Pick<UserSummary, "roles">): AssignmentInput[] {
  return user.roles.filter((r) => r.via === "direct").map((r) => ({ role: r.role, scope: r.scope }));
}

/** The assignments without the `index`th direct one. */
export function withoutDirect(user: Pick<UserSummary, "roles">, index: number): AssignmentInput[] {
  return directOf(user).filter((_, i) => i !== index);
}

/** Roles that matter for the Users table: members only everyone-by-default are "No role". */
export function visibleRoles(roles: readonly RoleGrant[]): RoleGrant[] {
  return roles.filter((r) => r.via !== "default");
}

/** The highest built-in role among `roles`, for a short badge; null when none. */
export function badgeRole(roles: readonly RoleGrant[]): { role: string; limits: number } | null {
  const rank = ["admin", "operator", "viewer", "member"];
  const shown = visibleRoles(roles);
  const best = [...shown].sort((a, b) => (rank.indexOf(a.role) < 0 ? 9 : rank.indexOf(a.role)) - (rank.indexOf(b.role) < 0 ? 9 : rank.indexOf(b.role)))[0];
  if (!best) return null;
  return { role: best.role, limits: shown.filter((r) => r.role === best.role && r.scope !== null).reduce((n, r) => n + (r.scope?.length ?? 0), 0) };
}

/** Whether a person has no role beyond what everyone gets (the "No role" waiting list). */
export function hasNoRole(user: Pick<UserSummary, "roles">): boolean {
  return visibleRoles(user.roles).length === 0;
}

/** "Today 08:14", "Nov 21", or "never" for a Unix-ms time. */
export function seenText(ms: number | null, now: number = Date.now()): string {
  if (ms === null || ms === 0) return "never";
  const d = new Date(ms);
  const today = new Date(now);
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  const clock = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return same ? `Today ${clock}` : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}
