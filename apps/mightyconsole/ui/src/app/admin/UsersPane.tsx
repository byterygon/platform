// Users (DOC-25 §3.3, TSK-135 §5): every person who has signed in, with their roles and where
// each comes from, the last sign-in and the live sessions; a detail with each assignment and where
// it applies (take a direct one away, add one), the sessions (end one), and the account (turn it
// off, unlock it, a new password link, delete it). Every change goes through `admin.*`; the server
// refuses what it must ("this would remove the last administrator") and the screen says so.
import { useMemo, useRef, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectItem } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { MightyClient } from "../client";
import type { RoleGrant, RoleInfo, SessionRow, SetupLinkOutput, UserSummary } from "@/gen/api";
import { Add, ArrowClockwise, Delete } from "@/lib/icons";
import { describeError } from "../messages";
import { methodText, viaText } from "../session";
import { badgeRole, directOf, fromText, hasNoRole, seenText, whereText, withoutDirect } from "./admin";
import { EVERYWHERE, Failure, type ProfileChoice, type WhereValue, WhereField, scopeFrom, useLoad } from "./parts";

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || "?";

function nameOf(u: UserSummary): string {
  return u.displayName || u.username || u.email || u.id;
}

function message(error: unknown): string {
  return describeError(error).title;
}

export interface UsersPaneProps {
  client: MightyClient;
  profiles: readonly ProfileChoice[];
  /** The caller's own user id: nobody turns their own account off here. */
  selfId: string;
}

export function UsersPane({ client, profiles, selfId }: UsersPaneProps) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [role, setRole] = useState("any");
  const [status, setStatus] = useState<"on" | "off" | "any">("on");
  const [selected, setSelected] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"addRole" | "create" | "off" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [link, setLink] = useState<SetupLinkOutput | null>(null);

  const roles = useLoad(() => client.admin.roles.list({}), [client]);
  const users = useLoad(
    () => client.admin.users.list({ text: text.trim() || null, role: role === "any" ? null : role, group: null, disabled: status === "any" ? null : status === "off", offset: null }),
    [client, text, role, status],
  );
  const sessions = useLoad(() => client.admin.sessions.list({}), [client]);
  const rows = users.data?.users ?? [];
  const user = rows.find((u) => u.id === selected) ?? null;
  const mine: SessionRow[] = useMemo(() => (sessions.data?.sessions ?? []).filter((s) => s.user === user?.id), [sessions.data, user?.id]);
  const waiting = rows.filter(hasNoRole).length;
  const table = useRef<HTMLTableSectionElement>(null);
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name;

  const act = async (what: string, run: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await run();
      if (done) toast.add({ title: done, type: "success" });
      users.reload();
      sessions.reload();
      return true;
    } catch (error) {
      setProblem(error);
      toast.add({ title: `${what} failed`, description: message(error), type: "danger" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const onKey = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(table.current?.querySelectorAll<HTMLElement>("[data-person]") ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    event.preventDefault();
    const next = buttons[Math.max(0, Math.min(buttons.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)))];
    next?.focus();
    if (next?.dataset["person"]) setSelected(next.dataset["person"]);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-md" data-testid="admin-users">
      <div className="flex flex-wrap items-center gap-inline-md">
        <SearchInput aria-label="Find a person or email" placeholder="Find a person or email" value={text} onValueChange={setText} className="w-panel-xs" />
        <Select aria-label="Role" value={role} onValueChange={(v) => setRole(v ?? "any")} className="w-panel-xxs">
          <SelectItem value="any">Role: any</SelectItem>
          {(roles.data?.roles ?? []).map((r) => (
            <SelectItem key={r.id} value={r.id}>
              Role: {r.name}
            </SelectItem>
          ))}
        </Select>
        <Select aria-label="Status" value={status} onValueChange={(v) => setStatus((v as "on" | "off" | "any") ?? "on")} className="w-panel-xxs">
          <SelectItem value="on">Status: on</SelectItem>
          <SelectItem value="off">Status: off</SelectItem>
          <SelectItem value="any">Status: any</SelectItem>
        </Select>
        <span className="flex-1" />
        <span className="text-caption-1 text-fg-muted">People appear after their first sign-in.</span>
        <Button onClick={() => { users.reload(); sessions.reload(); }} loading={users.loading}>
          <Icon icon={ArrowClockwise} /> Refresh
        </Button>
        <Button appearance="primary" onClick={() => setDialog("create")}>
          <Icon icon={Add} /> New account
        </Button>
      </div>
      {users.error ? <Failure error={users.error} onRetry={users.reload} /> : null}
      <div className="flex min-h-0 flex-1 gap-inline-lg overflow-hidden">
        <div className="min-h-0 w-3/5 shrink-0 overflow-auto">
          {users.loading && !users.data ? (
            <div aria-busy="true" aria-label="Loading people" className="flex flex-col gap-stack-sm p-inset-sm">
              <Skeleton variant="text" />
              <Skeleton variant="text" />
              <Skeleton variant="text" />
            </div>
          ) : (
            <Table aria-label="People">
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  <TableHead>Roles</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Last sign-in</TableHead>
                  <TableHead align="end">Sessions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody ref={table} onKeyDown={onKey}>
                {rows.map((u) => {
                  const badge = badgeRole(u.roles);
                  return (
                    <TableRow key={u.id} selected={u.id === selected} data-user={u.id}>
                      <TableCell>
                        <button type="button" data-person={u.id} onClick={() => setSelected(u.id)} className="flex min-w-0 items-center gap-inline-md text-start outline-none focus-visible:underline">
                          <span aria-hidden="true" className="flex size-control-md shrink-0 items-center justify-center rounded-full bg-accent-subtle text-caption-1-strong text-accent-subtle-fg">
                            {initials(nameOf(u))}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="truncate">{nameOf(u)}</span>
                            <span className="truncate text-caption-1 text-fg-muted">{u.email ?? u.username ?? u.id}</span>
                          </span>
                        </button>
                      </TableCell>
                      <TableCell>
                        {u.disabled ? <Badge variant="neutral">Off</Badge> : badge ? <Badge variant={badge.role === "admin" ? "info" : "neutral"}>{badge.limits > 0 ? `${badge.role} · ${badge.limits} limit${badge.limits === 1 ? "" : "s"}` : badge.role}</Badge> : <Badge variant="warning">No role</Badge>}
                      </TableCell>
                      <TableCell className="text-caption-1 text-fg-muted">{fromText(u.roles.filter((r) => r.via !== "default"))}</TableCell>
                      <TableCell>{seenText(u.lastSeenMs)}</TableCell>
                      <TableCell align="end">{u.sessions}</TableCell>
                    </TableRow>
                  );
                })}
                {rows.length === 0 && !users.loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-fg-muted">
                      Nobody matches.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
          <p className="px-inset-sm py-stack-sm text-caption-1 text-fg-muted" data-testid="admin-users-count">
            {users.data ? `${users.data.total} ${users.data.total === 1 ? "person" : "people"}` : ""}
            {waiting > 0 ? ` · ${waiting} waiting for a role` : ""}
          </p>
        </div>
        <section aria-label="Person" className="min-h-0 min-w-0 flex-1 overflow-auto border-s border-border-subtle ps-inset-lg" data-testid="admin-user-detail">
          {user === null ? (
            <p className="text-body-1 text-fg-muted">Pick a person to see their roles, sessions and account.</p>
          ) : (
            <div className="flex flex-col gap-stack-lg">
              <div className="flex items-center gap-inline-md">
                <span aria-hidden="true" className="flex size-control-lg items-center justify-center rounded-full bg-accent-subtle text-body-1-strong text-accent-subtle-fg">
                  {initials(nameOf(user))}
                </span>
                <div className="flex min-w-0 flex-col">
                  <h3 className="truncate text-subtitle-2">{nameOf(user)}</h3>
                  <span className="break-all text-caption-1 text-fg-muted">
                    {user.email ?? user.username ?? user.id}
                    {user.createdMs ? ` · first signed in ${new Date(user.createdMs).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}
                  </span>
                </div>
              </div>
              {problem ? <Failure error={problem} /> : null}
              <section className="flex flex-col gap-stack-sm" aria-label="Roles and where they apply">
                <h4 className="text-body-1-strong">Roles and where they apply</h4>
                {user.roles.filter((r) => r.via !== "default").length === 0 ? <p className="text-body-1 text-fg-muted">No role. Their groups map to nothing, and none was given directly.</p> : null}
                {user.roles
                  .filter((r) => r.via !== "default")
                  .map((r, i) => (
                    <AssignmentRow key={`${r.role}|${r.via}|${(r.scope ?? []).join(",")}|${i}`} grant={r} where={whereText(r.scope, profileName)} onRemove={() => {
                      const index = user.roles.filter((x) => x.via === "direct").indexOf(r);
                      void act("Taking the role away", () => client.admin.users.setRoles({ userId: user.id, assignments: withoutDirect(user, index) }), "Role taken away; their sessions ended");
                    }} busy={busy} />
                  ))}
                <div>
                  <Button size="small" onClick={() => setDialog("addRole")} disabled={busy}>
                    <Icon icon={Add} /> Add role…
                  </Button>
                </div>
                <p className="text-caption-1 text-fg-muted">A role from a group changes in the identity provider or in Group mapping. Taking a role away signs the person out of every session.</p>
              </section>
              <section className="flex flex-col gap-stack-sm" aria-label="Sessions">
                <h4 className="text-body-1-strong">Sessions</h4>
                {mine.length === 0 ? <p className="text-body-1 text-fg-muted">No live session.</p> : null}
                {mine.map((s) => (
                  <div key={s.id} className="flex items-center gap-inline-md rounded-md border border-border-subtle px-inset-sm py-inset-xs" data-session={s.id}>
                    <span className="min-w-0 flex-1 text-body-1">
                      {s.client ?? "unknown address"} · {methodText(s.method, null)} · active {seenText(s.lastActivityMs)}
                    </span>
                    <Button size="small" disabled={busy} onClick={() => void act("Signing out", () => client.admin.sessions.revoke({ sessionId: s.id }), "Session ended")}>
                      Sign out
                    </Button>
                  </div>
                ))}
              </section>
              <section className="flex flex-wrap items-center gap-inline-sm" aria-label="Account">
                {user.disabled ? (
                  <Button size="small" disabled={busy} onClick={() => void act("Turning on", () => client.admin.users.enable({ userId: user.id }), "Account turned on")}>
                    Turn on account
                  </Button>
                ) : (
                  <Button size="small" appearance="outline" disabled={busy || user.id === selfId} title={user.id === selfId ? "You cannot turn off your own account." : undefined} onClick={() => setDialog("off")}>
                    Turn off account
                  </Button>
                )}
                {user.locked ? (
                  <Button size="small" disabled={busy} onClick={() => void act("Unlocking", () => client.admin.users.unlock({ userId: user.id }), "Account unlocked")}>
                    Unlock
                  </Button>
                ) : null}
                {user.kind === "account" ? (
                  <Button
                    size="small"
                    disabled={busy}
                    onClick={() =>
                      void (async () => {
                        setBusy(true);
                        try {
                          setLink(await client.admin.users.resetPassword({ userId: user.id, removeTotp: false }));
                        } catch (error) {
                          setProblem(error);
                        } finally {
                          setBusy(false);
                        }
                      })()
                    }
                  >
                    New password link
                  </Button>
                ) : null}
                {user.kind === "account" && !user.defaultAdmin && user.id !== selfId ? (
                  <Button size="small" appearance="subtle" disabled={busy} onClick={() => setDialog("delete")}>
                    <Icon icon={Delete} /> Delete account…
                  </Button>
                ) : null}
              </section>
            </div>
          )}
        </section>
      </div>
      {user ? (
        <AlertDialog open={dialog === "off"} onOpenChange={(o) => !o && setDialog(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Turn off {nameOf(user)}?</AlertDialogTitle>
              <AlertDialogDescription>They are signed out of every session and cannot sign in until the account is turned on again. Their roles stay.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                appearance="danger"
                onClick={() => {
                  setDialog(null);
                  void act("Turning off", () => client.admin.users.disable({ userId: user.id }), "Account turned off");
                }}
              >
                Turn off account
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {user ? (
        <AlertDialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {user.username ?? nameOf(user)}?</AlertDialogTitle>
              <AlertDialogDescription>The account, its sessions and its roles are removed. The server asks you to type the name to confirm.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogBody />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                appearance="danger"
                onClick={() => {
                  setDialog(null);
                  void act("Deleting", async () => {
                    await client.admin.users.delete({ userId: user.id, username: user.username ?? "" });
                    setSelected(null);
                  }, "Account deleted");
                }}
              >
                Delete account
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
      {user ? <AddRoleDialog open={dialog === "addRole"} onOpenChange={(o) => !o && setDialog(null)} roles={roles.data?.roles ?? []} profiles={profiles} person={nameOf(user)} onAdd={async (assignment) => {
        const ok = await act("Adding the role", () => client.admin.users.setRoles({ userId: user.id, assignments: [...directOf(user), assignment] }), "Role added");
        if (ok) setDialog(null);
      }} /> : null}
      <NewAccountDialog open={dialog === "create"} onOpenChange={(o) => !o && setDialog(null)} roles={roles.data?.roles ?? []} onCreate={async (input) => {
        try {
          const out = await client.admin.users.create(input);
          setDialog(null);
          users.reload();
          setLink(out);
        } catch (error) {
          toast.add({ title: "Creating the account failed", description: message(error), type: "danger" });
        }
      }} />
      <Dialog open={link !== null} onOpenChange={(o) => !o && setLink(null)} size="md">
        <DialogContent data-testid="setup-link">
          <DialogHeader>
            <DialogTitle>Setup link</DialogTitle>
            <DialogDescription>Hand this link to the person. It sets the account's password and works once, until {link ? new Date(link.expiresMs).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }) : ""}.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Code className="break-all">{link?.url}</Code>
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => void navigator.clipboard?.writeText(link?.url ?? "").then(() => toast.add({ title: "Link copied", type: "success" }), () => undefined)}>Copy link</Button>
            <Button appearance="primary" onClick={() => setLink(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssignmentRow({ grant, where, onRemove, busy }: { grant: RoleGrant; where: string; onRemove(): void; busy: boolean }) {
  return (
    <div className="flex items-center gap-inline-md rounded-md border border-border-subtle px-inset-sm py-inset-xs" data-assignment={grant.role} data-via={grant.via}>
      <Badge variant={grant.role === "admin" ? "info" : "neutral"}>{grant.role}</Badge>
      <span className="min-w-0 flex-1 text-caption-1 text-fg-muted">
        <b className="text-fg">{where}</b> · {viaText(grant.via)}
      </span>
      {grant.via === "direct" ? (
        <Button size="small" appearance="subtle" disabled={busy} aria-label={`Remove ${grant.role} on ${where}`} onClick={onRemove}>
          Remove
        </Button>
      ) : null}
    </div>
  );
}

function AddRoleDialog({ open, onOpenChange, roles, profiles, person, onAdd }: { open: boolean; onOpenChange(open: boolean): void; roles: readonly RoleInfo[]; profiles: readonly ProfileChoice[]; person: string; onAdd(a: { role: string; scope: string[] | null }): Promise<void> }) {
  const [role, setRole] = useState("");
  const [where, setWhere] = useState<WhereValue>(EVERYWHERE);
  const [busy, setBusy] = useState(false);
  const grantable = roles.filter((r) => r.id !== "member");
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setRole(""); setWhere(EVERYWHERE); } }} size="md">
      <DialogContent data-testid="add-role">
        <DialogHeader>
          <DialogTitle>Add a role to {person}</DialogTitle>
          <DialogDescription>The role applies where you say. Adding it ends none of their sessions.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-lg">
          <Field>
            <FieldLabel>Role</FieldLabel>
            <Select aria-label="Role" value={role || null} onValueChange={(v) => setRole(v ?? "")} placeholder="Pick a role">
              {grantable.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </Select>
          </Field>
          <WhereField profiles={profiles} value={where} onChange={setWhere} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            appearance="primary"
            disabled={role === ""}
            loading={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                await onAdd({ role, scope: scopeFrom(where) });
                setBusy(false);
              })()
            }
          >
            Add role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewAccountDialog({ open, onOpenChange, roles, onCreate }: { open: boolean; onOpenChange(open: boolean): void; roles: readonly RoleInfo[]; onCreate(input: { username: string; displayName: string | null; roles: { role: string; scope: null }[] | null; groups: null }): Promise<void> }) {
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) { setUsername(""); setDisplayName(""); setRole(""); } }} size="md">
      <DialogContent data-testid="new-account">
        <DialogHeader>
          <DialogTitle>New account</DialogTitle>
          <DialogDescription>A built-in account with a password, for someone who does not sign in through the identity provider. You get a setup link to hand over.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          <Field>
            <FieldLabel>User name</FieldLabel>
            <Input value={username} onValueChange={setUsername} autoComplete="off" spellCheck={false} />
          </Field>
          <Field>
            <FieldLabel>Name (optional)</FieldLabel>
            <Input value={displayName} onValueChange={setDisplayName} autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel>Role (optional, everywhere)</FieldLabel>
            <Select aria-label="Role" value={role || null} onValueChange={(v) => setRole(v ?? "")} placeholder="No role yet">
              {roles.filter((r) => r.id !== "member").map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </Select>
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            appearance="primary"
            disabled={username.trim() === ""}
            loading={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                await onCreate({ username: username.trim(), displayName: displayName.trim() || null, roles: role ? [{ role, scope: null }] : null, groups: null });
                setBusy(false);
              })()
            }
          >
            Create account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

