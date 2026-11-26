// The account button at the end of the title area, its menu, and the person's sessions (TSK-135
// "The account menu", "Your sessions"). The menu shows who the person is, which roles they hold,
// where each applies and how it reached them, when the session started and when it ends; then
// Sessions, Settings and Sign out. The sessions dialog lists the person's own login sessions
// (`app.sessions.list`) and ends one or all the others (`app.sessions.revoke`): the ended session
// gets Goaway at once, so its live views stop and its tabs show the sign-in.
import { useEffect, useState } from "react";
import { isRpcError } from "@byterygon/ambidex";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Me, SessionRow } from "@/gen/api";
import { Globe, Shield, SignOut, Settings as SettingsIcon } from "@/lib/icons";
import type { MightyClient } from "./client";
import { clock, initialsOf, methodText, nameOf, scopeText, viaText } from "./session";

export interface AccountMenuProps {
  me: Me;
  /** The IdP's name, to say how an OIDC session signed in. */
  idpName: string | null;
  /** When this session started (Unix ms), from the sessions list; unknown until it loads. */
  startedMs: number | null;
  /** The settings shortcut, shown beside the item. */
  settingsBinding?: string;
  onSessions(): void;
  /** "My access": the roles and the permissions they grant. */
  onMyAccess?(): void;
  onSettings(): void;
  onSignOut(): void;
}

/** The initials button and its menu. The button is the first stop after the title area's tools. */
export function AccountMenu({ me, idpName, startedMs, settingsBinding, onSessions, onMyAccess, onSettings, onSignOut }: AccountMenuProps) {
  const name = nameOf(me);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button appearance="subtle" aria-label={`Account: ${name}`} data-testid="account-button" className="size-control-md rounded-full border-border bg-accent-subtle p-0 text-caption-1-strong text-accent-subtle-fg hover:bg-accent-subtle-hover" />}
      >
        <span aria-hidden="true">{initialsOf(name)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="Account" className="w-panel-xs">
        <DropdownMenuGroup className="flex flex-col gap-stack-sm p-inset-xs" aria-label="Who you are" data-testid="account-summary">
          <div className="flex flex-col">
            <span className="break-all text-body-1-strong">{name}</span>
            {me.email && me.email !== name ? <span className="break-all text-caption-1 text-fg-muted">{me.email}</span> : me.username && me.username !== name ? <span className="text-caption-1 text-fg-muted">{me.username}</span> : null}
          </div>
          <div className="flex flex-col gap-stack-xs">
            {me.roles.length === 0 ? <span className="text-caption-1 text-fg-muted">No role yet</span> : null}
            {me.roles.map((grant) => (
              <div key={`${grant.role}|${grant.via}|${(grant.scope ?? []).join(",")}`} className="flex flex-wrap items-center gap-inline-sm">
                <Badge variant={grant.role === "admin" ? "info" : "neutral"}>{grant.role}</Badge>
                <span className="text-caption-1 text-fg-muted">
                  {scopeText(grant.scope)} · {viaText(grant.via)}
                </span>
              </div>
            ))}
          </div>
          <p className="text-caption-1 text-fg-muted">
            Signed in with {methodText(me.method, idpName)}
            {startedMs !== null ? ` at ${clock(startedMs)}` : ""} · this session ends by {clock(me.absoluteExpiresMs)} at the latest
          </p>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {onMyAccess ? (
          <DropdownMenuItem onClick={onMyAccess}>
            <Icon icon={Shield} />
            My access
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onClick={onSessions}>
          <Icon icon={Globe} />
          Sessions
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onSettings}>
          <Icon icon={SettingsIcon} />
          Settings
          {settingsBinding ? <span className="ms-auto ps-inline-lg text-caption-1 text-fg-subtle">{settingsBinding}</span> : null}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut}>
          <Icon icon={SignOut} />
          Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

function message(error: unknown): string {
  return isRpcError(error) || error instanceof Error ? error.message : String(error);
}

export interface SessionsDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  client: Pick<MightyClient, "app">;
  /** The caller's own session id, from `app.me`. */
  currentId: string;
  /** Told when the list loads: the account menu shows when this session started. */
  onLoaded?(rows: readonly SessionRow[]): void;
}

/** Your sessions: each with its address, sign-in time and last activity; sign out of one or of all the others. */
export function SessionsDialog({ open, onOpenChange, client, currentId, onLoaded }: SessionsDialogProps) {
  const [rows, setRows] = useState<readonly SessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    try {
      const out = await client.app.sessions.list({});
      setRows(out.sessions);
      onLoaded?.(out.sessions);
      setError(null);
    } catch (e) {
      setError(message(e));
    }
  };

  useEffect(() => {
    if (!open) return;
    setRows(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const revoke = async (ids: readonly string[], key: string) => {
    setBusy(key);
    try {
      for (const sessionId of ids) await client.app.sessions.revoke({ sessionId });
      await load();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const others = (rows ?? []).filter((r) => r.id !== currentId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your sessions</DialogTitle>
          <DialogDescription>Each place you are signed in. Signing one out ends it at once: its live views stop and its tabs show the sign-in.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          {error ? (
            <Alert intent="danger">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {rows === null && error === null ? (
            <div aria-busy="true" aria-label="Loading sessions" className="flex flex-col gap-stack-sm">
              <Skeleton variant="text" />
              <Skeleton variant="text" />
            </div>
          ) : null}
          {rows !== null ? (
            <Table aria-label="Your sessions">
              <TableHeader>
                <TableRow>
                  <TableHead>From</TableHead>
                  <TableHead>Signed in with</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id} data-session={row.id}>
                    <TableCell>
                      <span className="font-mono">{row.client ?? "unknown address"}</span>
                      {row.id === currentId ? (
                        <Badge variant="success" className="ms-inline-sm">
                          This browser
                        </Badge>
                      ) : null}
                    </TableCell>
                    <TableCell>{methodText(row.method, null)}</TableCell>
                    <TableCell>{when(row.createdMs)}</TableCell>
                    <TableCell>{when(row.lastActivityMs)}</TableCell>
                    <TableCell align="end">
                      {row.id === currentId ? null : (
                        <Button size="small" loading={busy === row.id} onClick={() => void revoke([row.id], row.id)}>
                          Sign out
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          <p className="text-caption-1 text-fg-muted">A session ends after the server's idle limit without activity, at its time limit, and when the server restarts.</p>
        </DialogBody>
        <DialogFooter>
          <Button appearance="danger" disabled={others.length === 0} loading={busy === "others"} onClick={() => void revoke(others.map((r) => r.id), "others")}>
            Sign out of other sessions
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
