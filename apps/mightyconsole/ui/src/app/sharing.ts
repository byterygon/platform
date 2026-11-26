// Personal or shared (TSK-135 §8, DOC-25 §3.4.2): who a shared profile would reach today, in words
// for the "Who can use it" choice, and the order the connections pane lists profiles in.
import { useEffect, useState } from "react";
import type { RoleInfo, UserSummary } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import type { MightyClient } from "./client";

/**
 * The people a new shared profile of `tool` reaches today: those not turned off whose roles
 * hold `<tool>.read` everywhere. A role limited to some profiles reaches it once an administrator
 * adds the profile to where the role applies, so it is not counted.
 */
export function audienceOf(users: readonly Pick<UserSummary, "disabled" | "roles">[], roles: readonly Pick<RoleInfo, "id" | "permissions">[], tool: string): number {
  const read = new Set(roles.filter((r) => r.permissions.includes(`${tool}.read`)).map((r) => r.id));
  return users.filter((u) => !u.disabled && u.roles.some((g) => g.scope === null && read.has(g.role))).length;
}

/** What the shared option says it reaches. */
export function audienceText(count: number | null, name: string): string {
  const base = "Administrators edit it and set its secrets; the others connect with it and never see them.";
  if (count === null) return `Everyone whose role covers it connects with it. ${base}`;
  const who = count === 1 ? "1 person whose role applies everywhere" : `${count} people whose roles apply everywhere`;
  return `Today that is ${who}; others once an administrator adds ${name.trim() || "it"} to where their role applies. ${base}`;
}

/** The audience of a shared profile of `tool`, for an administrator; null while unknown or without the right to ask. */
export function useAudience(client: MightyClient, enabled: boolean, tool: string): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    Promise.all([client.admin.users.list({ text: null, role: null, group: null, disabled: null, offset: null }), client.admin.roles.list({})]).then(
      ([users, roles]) => live && setCount(audienceOf(users.users, roles.roles, tool)),
      () => live && setCount(null),
    );
    return () => {
      live = false;
    };
  }, [client, enabled, tool]);
  return enabled ? count : null;
}

/** Shared profiles first, then personal ones, each by name (the pane's order). */
export function pane(profiles: readonly ProfileRecord[]): ProfileRecord[] {
  const rank = (p: ProfileRecord) => (p.owner?.kind === "shared" ? 0 : 1);
  return [...profiles].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
