// The person's session as the UI needs it (DOC-25 §3.2.4, TSK-135 "Who you are"): sign out, the
// token a new session gives a page that is already open, how long the session has left and what
// ended it, and the words the account menu uses. No component here: `session.tsx` has the hooks,
// `account-menu.tsx` and `session-ended.tsx` the screens. Nothing about the person or the session
// is kept in the browser: the server is the only place that knows (`app.me`).
import type { Me, RoleGrant } from "@/gen/api";
import { AUTH_META, CSRF_HEADER, RETURN_PARAM } from "./sign-in";
import { CSRF_META, readCsrf } from "./client";

/** The server warns this long before either limit (DOC-25 §3.2.4). */
export const WARN_BEFORE_MS = 5 * 60_000;
/** An activity tells the server at most this often (`app.me` resets the idle timer). */
export const TOUCH_EVERY_MS = 60_000;

/**
 * Signs out: `POST /auth/logout` with the page's anti-CSRF token. The server ends the session and
 * answers where to go: the IdP's logout when it offers one, else the base path. A refusal or a
 * lost connection also ends on the base path, which shows the sign-in when the session is gone.
 */
export async function signOut(basePath: string, fetchImpl: typeof fetch = fetch, navigate: (to: string) => void = (to) => window.location.assign(to)): Promise<void> {
  const home = `${basePath}/`;
  try {
    const response = await fetchImpl(`${basePath}/auth/logout`, {
      method: "POST",
      credentials: "same-origin",
      headers: { [CSRF_HEADER]: readCsrf() ?? "", Accept: "application/json" },
    });
    const body = (await response.json().catch(() => ({}))) as { location?: unknown };
    navigate(typeof body.location === "string" ? body.location : home);
  } catch {
    navigate(home);
  }
}

/**
 * After a new sign-in in another tab: the page of the base path, fetched with the new cookie,
 * carries the new session's anti-CSRF token. Put in this document's `<meta>`, the next Hello of
 * the client uses it, so the open app goes on without a reload (and keeps unsent work).
 */
export async function refreshCsrf(basePath: string, doc: Document = document, fetchImpl: typeof fetch = fetch): Promise<"signed-in" | "signed-out" | "error"> {
  try {
    const response = await fetchImpl(`${basePath}/`, { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) return "error";
    const page = new DOMParser().parseFromString(await response.text(), "text/html");
    if (page.querySelector<HTMLMetaElement>(`meta[name="${AUTH_META}"]`)?.content === "signed-out") return "signed-out";
    const token = page.querySelector<HTMLMetaElement>(`meta[name="${CSRF_META}"]`)?.content;
    if (!token) return "error";
    let element = doc.querySelector<HTMLMetaElement>(`meta[name="${CSRF_META}"]`);
    if (element === null) {
      element = doc.createElement("meta");
      element.name = CSRF_META;
      doc.head.append(element);
    }
    element.content = token;
    return "signed-in";
  } catch {
    return "error";
  }
}

/** The address of the tab that signs in again (it tells this tab and closes, see `main.tsx`). */
export function signInAgainUrl(basePath: string): string {
  return `${basePath}/?${RETURN_PARAM}=1`;
}

export type LimitKind = "idle" | "absolute";

export interface Expiry {
  readonly kind: LimitKind;
  /** When the session ends (Unix ms). */
  readonly at: number;
  readonly inMs: number;
}

/** The limit that comes first, when it is within `WARN_BEFORE_MS`; `null` while there is time. */
export function expiryOf(me: Pick<Me, "idleExpiresMs" | "absoluteExpiresMs">, now: number): Expiry | null {
  const kind: LimitKind = me.absoluteExpiresMs <= me.idleExpiresMs ? "absolute" : "idle";
  const at = kind === "absolute" ? me.absoluteExpiresMs : me.idleExpiresMs;
  if (at <= 0) return null;
  const inMs = at - now;
  return inMs <= WARN_BEFORE_MS ? { kind, at, inMs } : null;
}

/** What ended a session the browser only learns is gone: a limit that has passed, else unknown. */
export function endCause(me: Pick<Me, "idleExpiresMs" | "absoluteExpiresMs"> | null, now: number): LimitKind | "unknown" {
  if (me === null) return "unknown";
  if (me.absoluteExpiresMs > 0 && now >= me.absoluteExpiresMs) return "absolute";
  if (me.idleExpiresMs > 0 && now >= me.idleExpiresMs) return "idle";
  return "unknown";
}

/** "08:14" in the person's locale. */
export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** "in 4 minutes", "in less than a minute". */
export function minutesLeft(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 0) return "in less than a minute";
  return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** The name to show: the display name, else the user name, else the e-mail (an OIDC user without a name claim), else the id. */
export function nameOf(me: Pick<Me, "displayName" | "username" | "user"> & { email?: string | null }): string {
  return me.displayName?.trim() || me.username || me.email || me.user;
}

/** Up to two initials for the account button. */
export function initialsOf(name: string): string {
  const words = name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = words.length >= 2 ? [words[0]!, words[words.length - 1]!].map((w) => w[0]!) : [...(words[0] ?? "?")].slice(0, 2);
  return letters.join("").toUpperCase();
}

/** Where a role applies: "everywhere", or the scope entries. */
export function scopeText(scope: readonly string[] | null): string {
  return scope === null ? "everywhere" : scope.length === 0 ? "nowhere" : scope.map((s) => s.replace(/^profile:/, "profile ")).join(", ");
}

/** How a role reached the person, from `RoleGrant.via`. */
export function viaText(via: string): string {
  if (via === "direct") return "assigned to you";
  if (via === "pinned") return "pinned in the configuration";
  if (via === "default") return "everyone gets it";
  if (via.startsWith("group:")) return `from group ${via.slice("group:".length).replace(/^(idp|local):/, "")}`;
  return via;
}

/** The role that says most about the person: the highest built-in one they hold, wherever it applies. */
export function mainRole(roles: readonly RoleGrant[]): string | null {
  for (const id of ["admin", "operator", "viewer", "member"]) if (roles.some((r) => r.role === id)) return id;
  return roles[0]?.role ?? null;
}

/** How the person signed in, in words. */
export function methodText(method: string, idpName: string | null): string {
  if (method === "oidc") return idpName ?? "the identity provider";
  return method === "totp" ? "a password and a code" : "a password";
}

/** The plain text a person pastes to whoever can grant access (DOC-25 §3.3.4 details). */
export function accessRequest(me: Pick<Me, "displayName" | "username" | "user" | "email" | "tenant">, what: { permission?: string; target?: string } | null, now: Date = new Date()): string {
  const lines = [`Access request for Mightyconsole (${me.tenant})`, `Name: ${nameOf(me)}`, ...(me.email ? [`Email: ${me.email}`] : []), `User: ${me.user}`];
  if (what?.permission) lines.push(`Needs: ${what.permission}${what.target ? ` on ${what.target}` : ""}`);
  lines.push(`When: ${now.toISOString()}`);
  return lines.join("\n");
}
