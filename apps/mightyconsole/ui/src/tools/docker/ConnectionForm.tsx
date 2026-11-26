// The Docker connection form (Mightyconsole spec §10.1, DOC-23 §6.4, TSK-114 frame
// routes-docker-ssh; TSK-144): the SSH host to log into, chosen from Settings → SSH hosts (or made
// here with New SSH host…), a summary of it, and the Docker socket on it, the only field that is
// Docker's own. The address, user, key and trusted host key are the host's. The profile's name
// and colour are the shell's.
import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { keyTypeLabel } from "@/app/dialogs/HostKeyDialog";
import { HostEditor } from "@/app/ssh-hosts/HostEditor";
import { Add, Edit } from "@/lib/icons";
import { AUTH_LABELS, addressOf, authOf, sshHostById, usedByText, useSshHosts } from "@/profiles/ssh-hosts";
import type { ConnectionFormProps } from "../types";
import { DEFAULT_SOCKET, hostIdOf } from "./profile";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails>{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

/** The picker's item that opens the host editor. */
const NEW_HOST = "__new__";

export function ConnectionForm({ fields, errors, onFields, disabled, client, profileId }: ConnectionFormProps) {
  const hosts = useSshHosts();
  const hostId = hostIdOf(fields);
  const host = sshHostById(hostId);
  const [editor, setEditor] = useState<"new" | "edit" | null>(null);
  const others = host ? host.usedBy.filter((u) => u.id !== profileId) : [];
  return (
    <>
      <Field invalid={errors["sshHostId"] !== undefined}>
        <FieldLabel>SSH host</FieldLabel>
        <Select<string>
          aria-label="SSH host"
          value={hostId === "" ? null : hostId}
          placeholder={hosts.length === 0 ? "No SSH host yet: add one" : "Choose the SSH host"}
          onValueChange={(v) => {
            if (v === NEW_HOST) setEditor("new");
            else if (typeof v === "string") onFields({ sshHostId: v });
          }}
          disabled={disabled}
        >
          {hosts.map((h) => (
            <SelectItem key={h.id} value={h.id}>
              <span className="flex min-w-0 items-center gap-inline-sm">
                <b>{h.name}</b>
                <span className="font-mono text-fg-muted">{addressOf(h.fields)}</span>
                <span className="ms-auto text-caption-1 text-fg-muted">{usedByText(h)}</span>
              </span>
            </SelectItem>
          ))}
          {client ? (
            <SelectItem value={NEW_HOST}>
              <span className="flex items-center gap-inline-sm">
                <Icon icon={Add} /> New SSH host…
              </span>
            </SelectItem>
          ) : null}
        </Select>
        <FieldDescription>Saved in Settings → SSH hosts. Address, user, key and host key live there, not here.</FieldDescription>
        {errors["sshHostId"] ? <FieldError match>{errors["sshHostId"]}</FieldError> : null}
      </Field>
      {host ? (
        <div className="rounded-md border border-border-subtle bg-layer-alt px-inset-md py-inset-sm">
          <DescriptionList layout="aligned" aria-label="The SSH host">
            <Item term="Address">
              <span className="font-mono">{addressOf(host.fields)}</span>
            </Item>
            <Item term="User">
              <span className="font-mono">{host.fields.username}</span>
            </Item>
            <Item term="Authentication">{AUTH_LABELS[authOf(host.fields)]}</Item>
            <Item term="Host key">{host.fields.hostKey ? <Code className="break-all">{keyTypeLabel(host.fields.hostKey.algorithm)} · {host.fields.hostKey.fingerprintSha256}</Code> : "Not trusted yet: the first connection shows its fingerprint."}</Item>
            <Item term="Also used by">{others.length + host.usedByHidden === 0 ? "Nothing else" : [...others.map((u) => u.name), ...(host.usedByHidden > 0 ? [`${host.usedByHidden} more`] : [])].join(", ")}</Item>
          </DescriptionList>
        </div>
      ) : hostId !== "" ? (
        <p className="text-body-1 text-fg-muted">This host is not one you can see: choose another.</p>
      ) : null}
      {client ? (
        <div className="flex gap-inline-sm">
          {host && (host.access === "owner" || host.access === "edit") ? (
            <Button size="small" onClick={() => setEditor("edit")} disabled={disabled}>
              <Icon icon={Edit} /> Edit host…
            </Button>
          ) : null}
          <Button size="small" onClick={() => setEditor("new")} disabled={disabled}>
            <Icon icon={Add} /> New SSH host…
          </Button>
        </div>
      ) : null}
      {host ? <p className="text-caption-1 text-fg-muted">Changing the host's user, key or trusted host key changes every Docker host that uses it.</p> : null}
      <Field invalid={errors["socketPath"] !== undefined}>
        <FieldLabel>Docker socket on the host</FieldLabel>
        <Input value={str(fields["socketPath"])} onValueChange={(v) => onFields({ socketPath: v })} placeholder={DEFAULT_SOCKET} disabled={disabled} autoComplete="off" spellCheck={false} />
        <FieldDescription>
          Rootless Docker: <Code>/run/user/&lt;uid&gt;/docker.sock</Code>. The host's sshd must forward Unix sockets.
        </FieldDescription>
        {errors["socketPath"] ? <FieldError match>{errors["socketPath"]}</FieldError> : null}
      </Field>
      {client && editor ? (
        <HostEditor
          open
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
          client={client}
          host={editor === "edit" ? host : undefined}
          onSaved={(saved) => onFields({ sshHostId: saved.host.id })}
        />
      ) : null}
    </>
  );
}
