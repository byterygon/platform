// Group mapping (DOC-25 §3.3.3; TSK-135 "Identity-provider groups to roles"): a mapping is a group,
// a role and where it applies. Pinned ones come from `[[auth.group_roles]]` in the configuration
// and are read-only; the others are edited here and replaced together (`admin.groups.set` with the
// etag it was read at, so a change someone else made is a conflict, not a silent overwrite).
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { MappingRow } from "@/gen/api";
import { Add, LockClosed } from "@/lib/icons";
import type { MightyClient } from "../client";
import { describeError } from "../messages";
import { whereText } from "./admin";
import { EVERYWHERE, Failure, type ProfileChoice, type WhereValue, WhereField, scopeFrom, useLoad } from "./parts";

const groupName = (g: string) => g.replace(/^(idp|local):/, "");

export function GroupsPane({ client, profiles }: { client: MightyClient; profiles: readonly ProfileChoice[] }) {
  const toast = useToast();
  const groups = useLoad(() => client.admin.groups.list({}), [client]);
  const roles = useLoad(() => client.admin.roles.list({}), [client]);
  const [editing, setEditing] = useState<{ index: number | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const profileName = (id: string) => profiles.find((p) => p.id === id)?.name;
  const data = groups.data;

  const save = async (mappings: MappingRow[], done: string) => {
    if (!data) return false;
    setBusy(true);
    try {
      await client.admin.groups.set({ etag: data.etag, mappings });
      toast.add({ title: done, type: "success" });
      groups.reload();
      return true;
    } catch (error) {
      toast.add({ title: "Saving the mappings failed", description: describeError(error).title, type: "danger" });
      groups.reload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const row = (m: MappingRow, pinned: boolean, index: number) => (
    <TableRow key={`${pinned ? "p" : "e"}${index}`} data-mapping={m.group} data-pinned={pinned ? "" : undefined}>
      <TableCell className="font-mono">{groupName(m.group)}</TableCell>
      <TableCell>
        <Badge variant={m.role === "admin" ? "info" : "neutral"}>{m.role}</Badge>
      </TableCell>
      <TableCell>{whereText(m.scope ?? null, profileName)}</TableCell>
      <TableCell>{pinned ? <span className="inline-flex items-center gap-inline-xs"><Icon icon={LockClosed} size="sm" /> Configuration (pinned)</span> : m.group.startsWith("local:") ? "Here (local group)" : "Here"}</TableCell>
      <TableCell align="end">
        {pinned ? null : (
          <span className="inline-flex gap-inline-xs">
            <Button size="small" appearance="subtle" disabled={busy} aria-label={`Edit the mapping of ${groupName(m.group)}`} onClick={() => setEditing({ index })}>
              Edit
            </Button>
            <Button size="small" appearance="subtle" disabled={busy} aria-label={`Remove the mapping of ${groupName(m.group)}`} onClick={() => void save((data?.mappings ?? []).filter((_, i) => i !== index), "Mapping removed")}>
              Remove
            </Button>
          </span>
        )}
      </TableCell>
    </TableRow>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-md" data-testid="admin-groups">
      <div className="flex flex-wrap items-center gap-inline-md">
        <p className="min-w-0 flex-1 text-caption-1 text-fg-muted">A person gets every role their identity-provider groups map to, plus roles given to them directly. Groups are read at sign-in from the claim set in the server's configuration. Someone whose groups map to nothing signs in with no role. A change applies to the next call; people who lose access are signed out.</p>
        <Button appearance="primary" disabled={!data} onClick={() => setEditing({ index: null })}>
          <Icon icon={Add} /> Add mapping
        </Button>
      </div>
      {groups.error ? <Failure error={groups.error} onRetry={groups.reload} /> : null}
      <div className="min-h-0 flex-1 overflow-auto">
        <Table aria-label="Group mappings">
          <TableHeader>
            <TableRow>
              <TableHead>Group</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Where</TableHead>
              <TableHead>Set in</TableHead>
              <TableHead align="end">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(data?.pinned ?? []).map((m, i) => row(m, true, i))}
            {(data?.mappings ?? []).map((m, i) => row(m, false, i))}
            {data && data.pinned.length + data.mappings.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-fg-muted">
                  No mapping yet: nobody gets a role from their groups.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
        <p className="px-inset-sm py-stack-md text-caption-1 text-fg-muted">Pinned mappings come from the configuration file. They cannot be changed or removed here, and they keep an administrator in place if everything else is removed.</p>
      </div>
      <MappingDialog
        key={editing === null ? "none" : String(editing.index)}
        open={editing !== null}
        initial={editing?.index != null ? (data?.mappings[editing.index] ?? null) : null}
        roles={(roles.data?.roles ?? []).filter((r) => r.id !== "member").map((r) => r.id)}
        profiles={profiles}
        onClose={() => setEditing(null)}
        onSave={async (m) => {
          const current = data?.mappings ?? [];
          const next = editing?.index != null ? current.map((x, i) => (i === editing.index ? m : x)) : [...current, m];
          if (await save(next, editing?.index != null ? "Mapping changed" : "Mapping added")) setEditing(null);
        }}
      />
    </div>
  );
}

function MappingDialog({ open, initial, roles, profiles, onClose, onSave }: { open: boolean; initial: MappingRow | null; roles: readonly string[]; profiles: readonly ProfileChoice[]; onClose(): void; onSave(m: MappingRow): Promise<void> }) {
  const [group, setGroup] = useState(initial ? groupName(initial.group) : "");
  const [local, setLocal] = useState(initial?.group.startsWith("local:") ?? false);
  const [role, setRole] = useState(initial?.role ?? "");
  const [where, setWhere] = useState<WhereValue>(() => {
    const scope = initial?.scope ?? null;
    const first = scope?.[0] ? /^profile:([^/]+)(?:\/ns:(.+))?$/.exec(scope[0]) : null;
    return scope && first ? { profiles: scope.map((s) => /^profile:([^/]+)/.exec(s)?.[1] ?? "").filter(Boolean), namespace: scope.length === 1 ? (first[2] ?? "") : "" } : EVERYWHERE;
  });
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} size="md">
      <DialogContent data-testid="mapping-dialog">
        <DialogHeader>
          <DialogTitle>{initial ? "Change the mapping" : "Add a mapping"}</DialogTitle>
          <DialogDescription>Everyone in the group gets the role, where you say.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-lg">
          <Field>
            <FieldLabel>Group</FieldLabel>
            <Input value={group} onValueChange={setGroup} className="font-mono" autoComplete="off" spellCheck={false} placeholder="platform-oncall" />
            <FieldDescription>
              {local ? "A group kept on this server." : "A group of the identity provider, as its groups claim names it."}{" "}
              <button type="button" className="underline" onClick={() => setLocal(!local)}>
                {local ? "Use an identity-provider group" : "Use a local group"}
              </button>
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Role</FieldLabel>
            <Select aria-label="Role" value={role || null} onValueChange={(v) => setRole(v ?? "")} placeholder="Pick a role">
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </Select>
          </Field>
          <WhereField profiles={profiles} value={where} onChange={setWhere} />
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            appearance="primary"
            disabled={group.trim() === "" || role === ""}
            loading={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                await onSave({ group: `${local ? "local" : "idp"}:${group.trim()}`, role, scope: scopeFrom(where) });
                setBusy(false);
              })()
            }
          >
            {initial ? "Save" : "Add mapping"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
