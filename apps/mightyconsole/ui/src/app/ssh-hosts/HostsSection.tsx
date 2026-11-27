// Settings → SSH hosts (DOC-23 §10, TSK-114 frames routes-hosts and routes-host-in-use; TSK-144):
// every saved login the person sees, with its address, user, authentication, trusted host key and
// who uses it; New SSH host and Edit open the host editor. A host that a profile names is not
// deleted: Delete explains why and lists them, with Open; a host nobody uses is deleted after the
// server's confirmation (typing its name).
import { useMemo, useState } from "react";
import { AlertDialog, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { SshHostView } from "@/gen/api";
import { Add, Delete, Edit } from "@/lib/icons";
import { AUTH_LABELS, addressOf, authOf, deleteHost, useSshHosts } from "@/profiles/ssh-hosts";
import type { MightyClient } from "../client";
import { keyTypeLabel } from "../dialogs/HostKeyDialog";
import { describeError } from "../messages";
import { ErrorState } from "../states";
import type { DescribedError } from "@/tools/types";
import { HostEditor } from "./HostEditor";

export interface HostsSectionProps {
  client: MightyClient;
  /** Opens a profile that uses a host (its editor). */
  onOpenProfile?: (profileId: string, tool: string) => void;
}

/** "Docker", "Route", or the tool's id. */
export const toolLabel = (tool: string): string => (tool === "docker" ? "Docker" : tool === "route" ? "Route" : tool);

const shortKey = (fingerprint: string) => (fingerprint.length > 22 ? `${fingerprint.slice(0, 13)}…${fingerprint.slice(-5)}` : fingerprint);

function usedBy(host: SshHostView): string {
  const names = host.usedBy.map((u) => `${toolLabel(u.tool)} ${u.name}`);
  if (host.usedByHidden > 0) names.push(`${host.usedByHidden} you do not see`);
  return names.join(", ");
}

export function HostsSection({ client, onOpenProfile }: HostsSectionProps) {
  const hosts = useSshHosts();
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<{ host?: SshHostView } | null>(null);
  const [inUse, setInUse] = useState<SshHostView | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (f === "") return hosts;
    return hosts.filter((h) => [h.name, addressOf(h.fields), h.fields.username].some((s) => s.toLowerCase().includes(f)));
  }, [hosts, filter]);

  const remove = async (host: SshHostView) => {
    setError(null);
    if (host.usedBy.length + host.usedByHidden > 0) return setInUse(host);
    try {
      await deleteHost(client, host);
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="flex flex-col gap-stack-sm">
      <div className="flex items-start gap-inline-md">
        <div className="flex min-w-0 flex-1 flex-col gap-stack-xs">
          <h3 className="text-subtitle-2">SSH hosts</h3>
          <p className="text-body-1 text-fg-muted">
            {hosts.length} host{hosts.length === 1 ? "" : "s"} · a saved login to one machine, chosen by Docker's SSH profiles
          </p>
        </div>
        <Button appearance="primary" onClick={() => setEditing({})}>
          <Icon icon={Add} /> New SSH host
        </Button>
      </div>
      <Input aria-label="Filter SSH hosts" value={filter} onValueChange={setFilter} placeholder="Filter by name, address or user" className="w-panel-xs" />
      {error ? <ErrorState error={error} /> : null}
      <Table aria-label="SSH hosts" size="small">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Address</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Authentication</TableHead>
            <TableHead>Host key</TableHead>
            <TableHead>Used by</TableHead>
            <TableHead align="end">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.length === 0 ? (
            <TableRow>
              <TableCell colSpan={7} className="text-fg-muted">
                {hosts.length === 0 ? "No SSH host yet. A Docker host over SSH needs one: New SSH host." : "No host matches the filter."}
              </TableCell>
            </TableRow>
          ) : (
            shown.map((h) => {
              const editable = h.access === "owner" || h.access === "edit";
              const used = h.usedBy.length + h.usedByHidden > 0;
              return (
                <TableRow key={h.id}>
                  <TableCell>
                    <b>{h.name}</b>
                    {h.owner.kind === "shared" ? <span className="ms-inline-xs text-caption-1 text-fg-muted">shared</span> : null}
                  </TableCell>
                  <TableCell className="font-mono">{addressOf(h.fields)}</TableCell>
                  <TableCell className="font-mono">{h.fields.username}</TableCell>
                  <TableCell>{AUTH_LABELS[authOf(h.fields)]}</TableCell>
                  <TableCell className="font-mono">{h.fields.hostKey ? `${keyTypeLabel(h.fields.hostKey.algorithm)} · ${shortKey(h.fields.hostKey.fingerprintSha256)}` : <span className="text-fg-muted">Not trusted yet</span>}</TableCell>
                  <TableCell className="text-fg-muted">{usedBy(h) || "Not used"}</TableCell>
                  <TableCell align="end">
                    <span className="inline-flex gap-inline-xs">
                      <IconButton aria-label={`Edit ${h.name}`} title="Edit" size="small" appearance="subtle" onClick={() => setEditing({ host: h })}>
                        <Icon icon={Edit} />
                      </IconButton>
                      <IconButton aria-label={`Delete ${h.name}`} title={used ? "In use: see who" : "Delete the host"} size="small" appearance="subtle" disabled={!editable} onClick={() => void remove(h)}>
                        <Icon icon={Delete} />
                      </IconButton>
                    </span>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      <p className="text-caption-1 text-fg-muted">Keys and passphrases are write-only. The host key is trusted once, here, for everything that uses the host; a host in use cannot be deleted.</p>
      {editing ? (
        <HostEditor
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          client={client}
          host={editing.host}
          {...(onOpenProfile
            ? {
                onOpenUser: (id: string) => {
                  const user = editing.host?.usedBy.find((u) => u.id === id);
                  setEditing(null);
                  if (user) onOpenProfile(user.id, user.tool);
                },
              }
            : {})}
        />
      ) : null}
      <AlertDialog open={inUse !== null} onOpenChange={(open) => !open && setInUse(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{inUse?.name} is in use</AlertDialogTitle>
            <AlertDialogDescription>It cannot be deleted while a Docker host or a route uses it, because they would lose their login. Choose another host in each of them first (a route in Settings → Routes).</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <ul className="flex flex-col gap-stack-xs" aria-label="Used by">
              {inUse?.usedBy.map((u) => (
                <li key={u.id} className="flex items-center gap-inline-sm text-body-1">
                  <span>
                    {toolLabel(u.tool)} <b>{u.name}</b>
                  </span>
                  {onOpenProfile && u.tool !== "route" ? (
                    <Button
                      size="small"
                      appearance="subtle"
                      className="ms-auto"
                      onClick={() => {
                        setInUse(null);
                        onOpenProfile(u.id, u.tool);
                      }}
                    >
                      Open
                    </Button>
                  ) : null}
                </li>
              ))}
              {inUse && inUse.usedByHidden > 0 ? <li className="text-caption-1 text-fg-muted">and {inUse.usedByHidden} you do not see</li> : null}
            </ul>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>Close</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
