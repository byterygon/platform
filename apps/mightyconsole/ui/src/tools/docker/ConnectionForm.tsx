// The Docker connection form (Mightyconsole spec §10.1, DOC-23 §6, TSK-114 frames
// routes-docker-ssh, routes-docker-socket, routes-docker-tcp-tls and routes-docker-tcp-plain):
// a Transport control on top, then the transport's own fields.
//
// - SSH (TSK-144): the SSH host to log into, chosen from Settings → SSH hosts (or made here with
//   New SSH host…), a summary of it, and the Docker socket on it. The address, user, key and
//   trusted host key are the host's.
// - Local socket: a path on the server's machine with the usual places in a menu, and the plain
//   warning that whoever can open the page is root on that machine (DOC-23 §11.4).
// - TCP: host and port, Use TLS (the pinned CA, the client certificate, its key as a write-only
//   secret, the server name; no "skip verification"), or without TLS the danger alert and the
//   tick that accepts it for this profile (DOC-23 (u)).
//
// Connect through (routes) comes with TSK-117. The profile's name and colour are the shell's.
import { type ReactNode, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { keyTypeLabel } from "@/app/dialogs/HostKeyDialog";
import { HostEditor } from "@/app/ssh-hosts/HostEditor";
import { Add, ChevronDown, Edit, Globe, HardDrive, LockClosed } from "@/lib/icons";
import { AUTH_LABELS, addressOf, authOf, sshHostById, usedByText, useSshHosts } from "@/profiles/ssh-hosts";
import type { ConnectionFormProps } from "../types";
import { DEFAULT_SOCKET, DEFAULT_TCP_PORT, DEFAULT_TLS_PORT, type DockerTransport, TRANSPORTS, TRANSPORT_LABELS, USUAL_SOCKETS, acceptanceOf, hostIdOf, tlsOf, transportFields, transportOf, unencryptedAccepted, withTransport } from "./profile";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const TRANSPORT_ICONS = { ssh: LockClosed, socket: HardDrive, tcp: Globe } as const;

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

export function ConnectionForm(props: ConnectionFormProps) {
  const { fields, onFields, disabled } = props;
  const transport = transportOf(fields);
  // What the person typed for a transport they left, to give back if they return to it.
  const left = useRef<Partial<Record<DockerTransport, Record<string, unknown>>>>({});
  const choose = (next: DockerTransport) => {
    if (next === transport) return;
    left.current[transport] = transportFields(fields);
    const after = withTransport(fields, next, left.current[next]);
    // The sheet merges a patch: the fields `after` drops go up as undefined (left out of the JSON).
    const cleared = Object.fromEntries(Object.keys(fields).map((k) => [k, undefined]));
    onFields({ ...cleared, ...after });
  };
  return (
    <>
      <Field>
        <FieldLabel>Transport</FieldLabel>
        <ToggleGroup aria-label="Transport" value={[transport]} onValueChange={(v) => v[0] && choose(v[0] as DockerTransport)} disabled={disabled}>
          {TRANSPORTS.map((t) => (
            <ToggleGroupItem key={t} value={t}>
              <Icon icon={TRANSPORT_ICONS[t]} /> {TRANSPORT_LABELS[t]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </Field>
      {transport === "ssh" ? <SshFields {...props} /> : transport === "socket" ? <SocketFields {...props} /> : <TcpFields {...props} />}
    </>
  );
}

function SshFields({ fields, errors, onFields, disabled, client, profileId }: ConnectionFormProps) {
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

function SocketFields({ fields, errors, onFields, disabled }: ConnectionFormProps) {
  return (
    <>
      <Field invalid={errors["socketPath"] !== undefined}>
        <FieldLabel>Socket</FieldLabel>
        <div className="flex gap-inline-sm">
          <Input className="min-w-0 flex-1 font-mono" value={str(fields["socketPath"])} onValueChange={(v) => onFields({ socketPath: v })} placeholder={DEFAULT_SOCKET} disabled={disabled} autoComplete="off" spellCheck={false} required />
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button disabled={disabled} />}>
              Usual places <Icon icon={ChevronDown} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" aria-label="Usual sockets">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Usual places on the server's machine</DropdownMenuLabel>
                {USUAL_SOCKETS.map((s) => (
                  <DropdownMenuItem key={s.path} onClick={() => onFields({ socketPath: s.path })}>
                    <span className="flex min-w-0 flex-col">
                      <span className="font-mono">{s.path}</span>
                      <span className="text-caption-1 text-fg-muted">{s.label}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <FieldDescription>A Unix socket, or on Windows a named pipe. ~ is the home of the user running mightyconsole-server, in this field only.</FieldDescription>
        {errors["socketPath"] ? <FieldError match>{errors["socketPath"]}</FieldError> : null}
      </Field>
      <Alert intent="warning">
        <AlertTitle>Whoever can open this page is root on the server's machine.</AlertTitle>
        <AlertDescription>
          Docker's socket gives full control of the machine that runs Mightyconsole. Saving a profile like this needs the <Code>profiles.hostAccess</Code> permission (administrators by default).
        </AlertDescription>
      </Alert>
      <p className="text-caption-1 text-fg-muted">The socket is on the machine that runs Mightyconsole, so there is no route to go through.</p>
    </>
  );
}

function TcpFields({ fields, secrets, storedSecrets, errors, onFields, onSecrets, disabled }: ConnectionFormProps) {
  const tls = tlsOf(fields);
  const setTls = (patch: Partial<typeof tls>) => onFields({ tls: { ...tls, ...patch } });
  const error = (key: string) => (errors[key] ? <FieldError match>{errors[key]}</FieldError> : null);
  const accepted = unencryptedAccepted(fields);
  const recorded = acceptanceOf(fields);
  // The acceptance is for one Engine: another host or port asks for it again (the server too).
  const target = (patch: Record<string, unknown>) => onFields(recorded ? { ...patch, unencrypted: undefined } : patch);
  const port = fields["port"];
  const name = str(fields["host"]).trim() || "this host";
  return (
    <>
      <div className="flex flex-wrap gap-inline-md">
        <Field className="min-w-0 flex-1" invalid={errors["host"] !== undefined}>
          <FieldLabel>Host</FieldLabel>
          <Input className="font-mono" value={str(fields["host"])} onValueChange={(v) => target({ host: v })} placeholder="docker.example.internal" disabled={disabled} autoComplete="off" spellCheck={false} required />
          {error("host")}
        </Field>
        <Field className="min-w-0 flex-1" invalid={errors["port"] !== undefined}>
          <FieldLabel>Port</FieldLabel>
          <NumberInput aria-label="Port" value={typeof port === "number" ? port : null} min={1} max={65535} onValueChange={(v) => target({ port: v ?? undefined })} placeholder={String(tls.enabled ? DEFAULT_TLS_PORT : DEFAULT_TCP_PORT)} disabled={disabled} />
          <FieldDescription>2376 with TLS, 2375 without.</FieldDescription>
          {error("port")}
        </Field>
      </div>
      <Field>
        <FieldLabel>
          <Switch checked={tls.enabled} onCheckedChange={(enabled) => setTls({ enabled })} disabled={disabled} /> Use TLS
        </FieldLabel>
        <FieldDescription>{tls.enabled ? "Verify the daemon against the pinned CA and sign in with a client certificate (dockerd --tlsverify)." : "Off: everything travels in clear text."}</FieldDescription>
      </Field>
      {tls.enabled ? (
        <>
          <Field invalid={errors["tls.caPem"] !== undefined}>
            <FieldLabel>CA certificate (PEM)</FieldLabel>
            <Textarea value={tls.caPem} onValueChange={(v) => setTls({ caPem: v })} rows={3} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
            <FieldDescription>Pinned for this host: only this CA is trusted.</FieldDescription>
            {error("tls.caPem")}
          </Field>
          <Field invalid={errors["tls.clientCertPem"] !== undefined}>
            <FieldLabel>Client certificate (PEM)</FieldLabel>
            <Textarea value={tls.clientCertPem} onValueChange={(v) => setTls({ clientCertPem: v })} rows={3} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
            {error("tls.clientCertPem")}
          </Field>
          <Field invalid={errors["tls.clientKeyPem"] !== undefined}>
            <FieldLabel>Client key (PEM)</FieldLabel>
            <Textarea
              value={str(secrets["clientKeyPem"])}
              onValueChange={(v) => onSecrets({ clientKeyPem: v })}
              rows={3}
              spellCheck={false}
              placeholder={storedSecrets.has("clientKeyPem") ? "Set (paste to replace)" : "Not set"}
              disabled={disabled}
            />
            <FieldDescription>A profile secret: write-only, never shown again.</FieldDescription>
            {error("tls.clientKeyPem")}
          </Field>
          <Field>
            <FieldLabel>Server name</FieldLabel>
            <Input className="font-mono" value={tls.serverName} onValueChange={(v) => setTls({ serverName: v })} placeholder="The host" disabled={disabled} autoComplete="off" spellCheck={false} />
            <FieldDescription>Only when the certificate names another host than the address. There is no option to skip verification.</FieldDescription>
          </Field>
        </>
      ) : (
        <Alert intent="danger">
          <AlertTitle>Unencrypted: anyone on the network who reaches this port is root on that host.</AlertTitle>
          <AlertDescription>
            <span className="flex flex-col gap-stack-sm">
              <span>Nothing is encrypted or authenticated. Use it only for a host on a network you fully control, or turn TLS on.</span>
              <Field invalid={errors["unencrypted"] !== undefined}>
                <FieldLabel className="flex items-center gap-inline-sm text-body-1-strong">
                  <Checkbox checked={accepted} onCheckedChange={(on) => onFields({ unencrypted: on === true ? { accepted: true } : undefined })} disabled={disabled} />I understand, and I accept this for {name}
                </FieldLabel>
                {recorded && accepted ? <FieldDescription>Accepted on {recorded.at.slice(0, 10)}; it is recorded with the profile.</FieldDescription> : null}
                {error("unencrypted")}
              </Field>
            </span>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
