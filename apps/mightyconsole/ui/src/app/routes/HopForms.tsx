// The route editor's hop forms (DOC-23 §4, (ac), (x), (y); mockup frames routes-hop-http,
// routes-hop-socks, routes-hop-ssh, routes-hop-pick, routes-hop-exec, routes-hop-command):
// - HTTP CONNECT and SOCKS5 choose a saved proxy, or make one: the form is the proxy's editor,
//   and its password is write-only and stays with the proxy;
// - an SSH hop and an SSH command choose a saved SSH host (New SSH host… opens the host editor);
// - a local command: the program, its arguments one per row (no shell, no splitting), variables
//   with a Secret tick, a working directory; {host} and {port} are the only placeholders.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Code } from "@/components/ui/code";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectItem } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { EnvView, HopInput, ProxyKind, ProxyView } from "@/gen/api";
import { Add, Delete } from "@/lib/icons";
import { type ProxyDraft, type ProxyErrors, DEFAULT_PROXY_PORT, emptyProxyDraft, proxyDraftOf, proxyUrl, saveProxy, useProxies, validateProxy } from "@/profiles/routes";
import { addressOf, useSshHosts } from "@/profiles/ssh-hosts";
import type { MightyClient } from "../client";
import { describeError } from "../messages";
import { ErrorState } from "../states";
import type { DescribedError } from "@/tools/types";
import { HostEditor } from "../ssh-hosts/HostEditor";

const NEW = "__new__";

export interface ProxyHopFormProps {
  client: MightyClient;
  kind: ProxyKind;
  proxyId: string;
  shared: boolean;
  onChange: (proxyId: string) => void;
}

/** A proxy hop: a saved proxy of `kind`, or a new one made here. */
export function ProxyHopForm({ client, kind, proxyId, shared, onChange }: ProxyHopFormProps) {
  const all = useProxies();
  const owner = shared ? "shared" : "personal";
  const choices = all.filter((p) => p.fields.kind === kind && p.owner.kind === owner);
  const current = all.find((p) => p.id === proxyId);
  const [editing, setEditing] = useState<{ base?: ProxyView } | null>(proxyId === "" ? {} : null);
  return (
    <div className="flex flex-col gap-stack-sm">
      <Field>
        <FieldLabel>Proxy</FieldLabel>
        <Select
          aria-label="Proxy"
          value={proxyId === "" ? NEW : proxyId}
          onValueChange={(v) => {
            if (v === NEW) {
              setEditing({});
            } else if (typeof v === "string") {
              setEditing(null);
              onChange(v);
            }
          }}
        >
          {choices.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name} · {p.url}
            </SelectItem>
          ))}
          <SelectItem value={NEW}>New {kind === "socks5" ? "SOCKS5" : "HTTP"} proxy…</SelectItem>
        </Select>
        <FieldDescription>
          {kind === "socks5"
            ? "The target's name goes to the proxy, which resolves it (socks5h). SOCKS4 and GSSAPI are not offered."
            : "Always CONNECT, also for the HTTP tools: TLS runs end to end and the proxy never sees the request. The name goes to the proxy (no local DNS)."}
        </FieldDescription>
      </Field>
      {current && !editing ? (
        <div className="flex items-center gap-inline-sm text-body-1">
          <Code>{current.url}</Code>
          {current.fields.username ? <span className="text-fg-muted">as {current.fields.username}</span> : null}
          {current.usedBy.length + current.usedByHidden > 1 ? <span className="text-caption-1 text-fg-muted">also used by {current.usedBy.length + current.usedByHidden - 1} other route(s)</span> : null}
          {current.access === "owner" || current.access === "edit" ? (
            <Button size="small" appearance="subtle" className="ms-auto" onClick={() => setEditing({ base: current })}>
              Edit proxy
            </Button>
          ) : null}
        </div>
      ) : null}
      {editing ? (
        <ProxyForm
          client={client}
          kind={kind}
          shared={shared}
          base={editing.base}
          onSaved={(p) => {
            setEditing(null);
            onChange(p.id);
          }}
          {...(editing.base || choices.length > 0 ? { onCancel: () => setEditing(null) } : {})}
        />
      ) : null}
    </div>
  );
}

interface ProxyFormProps {
  client: MightyClient;
  kind: ProxyKind;
  shared: boolean;
  base?: ProxyView | undefined;
  onSaved: (proxy: ProxyView) => void;
  onCancel?: () => void;
}

/** A proxy's editor, inside the hop it is made for (DOC-23 (ac)). */
function ProxyForm({ client, kind, shared, base, onSaved, onCancel }: ProxyFormProps) {
  const [draft, setDraft] = useState<ProxyDraft>(() => (base ? proxyDraftOf(base) : { ...emptyProxyDraft(kind), shared }));
  const [errors, setErrors] = useState<ProxyErrors>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const set = (patch: Partial<ProxyDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const stored = base?.secrets.some((s) => s.field === "password" && s.set) ?? false;
  const save = async () => {
    const next = validateProxy(draft);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(await saveProxy(client, draft, base));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  const port = draft.port.trim() === "" ? DEFAULT_PROXY_PORT[draft.kind] : Number(draft.port);
  return (
    <fieldset className="flex flex-col gap-stack-sm rounded-md border border-border-subtle p-inset-sm" aria-label={base ? `Edit proxy ${base.name}` : "New proxy"}>
      <div className="grid grid-cols-2 gap-inline-md">
        <Field invalid={errors.name !== undefined}>
          <FieldLabel>Proxy name</FieldLabel>
          <Input value={draft.name} onValueChange={(name) => set({ name })} placeholder="proxy-corp" autoComplete="off" />
          {errors.name ? <FieldError match>{errors.name}</FieldError> : null}
        </Field>
        {draft.kind === "httpConnect" ? (
          <Field orientation="horizontal" className="self-end">
            <Checkbox checked={draft.tls} onCheckedChange={(v) => set({ tls: v === true })} />
            <FieldLabel>https:// to the proxy</FieldLabel>
          </Field>
        ) : (
          <span />
        )}
        <Field invalid={errors.host !== undefined}>
          <FieldLabel>Host</FieldLabel>
          <Input value={draft.host} onValueChange={(host) => set({ host })} placeholder="proxy.corp" autoComplete="off" spellCheck={false} />
          {errors.host ? <FieldError match>{errors.host}</FieldError> : null}
        </Field>
        <Field invalid={errors.port !== undefined}>
          <FieldLabel>Port</FieldLabel>
          <Input inputMode="numeric" value={draft.port} onValueChange={(p) => set({ port: p })} placeholder={String(DEFAULT_PROXY_PORT[draft.kind])} />
          {errors.port ? <FieldError match>{errors.port}</FieldError> : null}
        </Field>
        <Field invalid={errors.username !== undefined}>
          <FieldLabel>Username</FieldLabel>
          <Input value={draft.username} onValueChange={(username) => set({ username })} placeholder="No login" autoComplete="off" />
          {errors.username ? <FieldError match>{errors.username}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel>Password</FieldLabel>
          <PasswordInput value={draft.password} onValueChange={(password) => set({ password })} placeholder={stored ? "Set (type to replace)" : "Not set"} autoComplete="off" />
          <FieldDescription>Write-only; it stays with the proxy and every route through it uses it.</FieldDescription>
        </Field>
      </div>
      {draft.kind === "httpConnect" && draft.tls ? (
        <Field invalid={errors.caPem !== undefined}>
          <FieldLabel>Pinned CA (PEM)</FieldLabel>
          <Textarea value={draft.caPem} onValueChange={(caPem) => set({ caPem })} rows={3} spellCheck={false} placeholder="-----BEGIN CERTIFICATE----- (the system's roots when empty)" />
          <FieldDescription>The proxy's certificate is checked against its own name, {draft.host.trim() || "the host"}.</FieldDescription>
          {errors.caPem ? <FieldError match>{errors.caPem}</FieldError> : null}
        </Field>
      ) : null}
      <p className="text-caption-1 text-fg-muted">
        {proxyUrl({ kind: draft.kind, tls: draft.tls, host: draft.host.trim() || "host", port: Number.isFinite(port) ? port : 0 })}
        {base && base.usedBy.length + base.usedByHidden > 1 ? ` · a change applies to every route through it (${base.usedBy.length + base.usedByHidden})` : ""}
      </p>
      {error ? <ErrorState error={error} /> : null}
      <div className="flex justify-end gap-inline-sm">
        {onCancel ? <Button onClick={onCancel}>Cancel</Button> : null}
        <Button appearance="primary" loading={saving} onClick={() => void save()}>
          Save proxy
        </Button>
      </div>
    </fieldset>
  );
}

export interface SshHopFormProps {
  client: MightyClient;
  hop: Extract<HopInput, { kind: "ssh" } | { kind: "sshCommand" }>;
  shared: boolean;
  onChange: (hop: HopInput) => void;
}

/** An SSH hop or an SSH command: a saved SSH host (and the command run there). */
export function SshHopForm({ client, hop, shared, onChange }: SshHopFormProps) {
  const hosts = useSshHosts();
  const owner = shared ? "shared" : "personal";
  const choices = hosts.filter((h) => h.owner.kind === owner);
  const current = hosts.find((h) => h.id === hop.sshHostId);
  const [making, setMaking] = useState(false);
  const others = current ? current.usedBy.length + current.usedByHidden : 0;
  return (
    <div className="flex flex-col gap-stack-sm">
      <Field>
        <FieldLabel>SSH host</FieldLabel>
        <Select
          aria-label="SSH host"
          value={hop.sshHostId === "" ? null : hop.sshHostId}
          placeholder="Choose an SSH host"
          onValueChange={(v) => {
            if (v === NEW) setMaking(true);
            else if (typeof v === "string") onChange({ ...hop, sshHostId: v });
          }}
        >
          {choices.map((h) => (
            <SelectItem key={h.id} value={h.id}>
              {h.name} · {h.fields.username}@{addressOf(h.fields)}
            </SelectItem>
          ))}
          <SelectItem value={NEW}>New SSH host…</SelectItem>
        </Select>
        <FieldDescription>
          {current
            ? `Logs in as ${current.fields.username} with ${current.fields.auth ?? "privateKey"}; ${current.fields.hostKey ? "host key trusted" : "host key not trusted yet (Test shows it)"}${others > 0 ? `; also used by ${others}` : ""}.`
            : "The address, user, key and trusted host key are the SSH host's (Settings → SSH hosts): a machine is declared once."}
        </FieldDescription>
      </Field>
      {hop.kind === "sshCommand" ? (
        <Field>
          <FieldLabel>Command run on the host</FieldLabel>
          <Input value={hop.command} onValueChange={(command) => onChange({ ...hop, command })} placeholder="nc {host} {port}" spellCheck={false} className="font-mono" />
          <FieldDescription>
            Its stdin and stdout are the stream to the next address. Only <Code>{"{host}"}</Code> and <Code>{"{port}"}</Code> are replaced (by a valid name or address and digits); the host's login shell reads the line. It runs as {current ? current.fields.username : "the host's user"} on {current ? current.name : "the host"}, so it is confirmed before its first run.
          </FieldDescription>
        </Field>
      ) : null}
      {making ? (
        <HostEditor
          open
          onOpenChange={(open) => !open && setMaking(false)}
          client={client}
          sharedByDefault={shared}
          onSaved={(saved) => {
            setMaking(false);
            onChange({ ...hop, sshHostId: saved.host.id });
          }}
        />
      ) : null}
    </div>
  );
}

export interface CommandHopFormProps {
  hop: Extract<HopInput, { kind: "command" }>;
  /** The stored variables of the saved hop (which secrets are set). */
  stored?: readonly EnvView[] | undefined;
  /** The next address, for the preview: the next hop or the target. */
  next: string;
  onChange: (hop: HopInput) => void;
}

/** A program on this server, first in a route (DOC-23 4.4). */
export function CommandHopForm({ hop, stored, next, onChange }: CommandHopFormProps) {
  const set = (patch: Partial<typeof hop>) => onChange({ ...hop, ...patch });
  const [host, port] = splitAddress(next);
  const preview = [hop.program.trim() || "program", ...hop.args.map((a) => a.replaceAll("{host}", host).replaceAll("{port}", port))].map((a) => (/\s/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
  return (
    <div className="flex flex-col gap-stack-sm">
      <Field>
        <FieldLabel>Program</FieldLabel>
        <Input value={hop.program} onValueChange={(program) => set({ program })} placeholder="/usr/local/bin/tsh or ssh" spellCheck={false} className="font-mono" />
        <FieldDescription>An absolute path, or a name found on the server's PATH. Recipes (Teleport, Cloudflare Access, AWS SSM, GCP IAP) are in the guide, unverified until someone runs them.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Arguments, one per row</FieldLabel>
        <div className="flex flex-col gap-stack-xs">
          {hop.args.map((a, i) => (
            <div key={i} className="flex items-center gap-inline-xs">
              <Input aria-label={`Argument ${i + 1}`} value={a} onValueChange={(v) => set({ args: hop.args.map((x, j) => (j === i ? v : x)) })} spellCheck={false} className="font-mono" />
              <IconButton aria-label={`Remove argument ${i + 1}`} size="small" appearance="subtle" onClick={() => set({ args: hop.args.filter((_, j) => j !== i) })}>
                <Icon icon={Delete} />
              </IconButton>
            </div>
          ))}
          <Button size="small" className="self-start" onClick={() => set({ args: [...hop.args, ""] })}>
            <Icon icon={Add} /> Add argument
          </Button>
        </div>
        <FieldDescription>
          No shell and no splitting: each row is one argument. <Code>{"{host}"}</Code> and <Code>{"{port}"}</Code> are the next address; nothing else is expanded.
        </FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Environment</FieldLabel>
        <div className="flex flex-col gap-stack-xs">
          {hop.env.map((v, i) => {
            const isSet = stored?.find((s) => s.name === v.name)?.set ?? false;
            const update = (patch: Partial<typeof v>) => set({ env: hop.env.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <div key={i} className="flex items-center gap-inline-xs">
                <Input aria-label={`Variable ${i + 1} name`} value={v.name} onValueChange={(name) => update({ name })} placeholder="NAME" spellCheck={false} className="w-panel-xs font-mono" />
                {v.secret ? (
                  <PasswordInput aria-label={`Variable ${i + 1} value`} value={v.value ?? ""} onValueChange={(value) => update({ value: value === "" ? null : value })} placeholder={isSet ? "Set (type to replace)" : "Not set"} autoComplete="off" />
                ) : (
                  <Input aria-label={`Variable ${i + 1} value`} value={v.value ?? ""} onValueChange={(value) => update({ value })} spellCheck={false} />
                )}
                <label className="flex items-center gap-inline-xs text-caption-1">
                  <Checkbox checked={v.secret} onCheckedChange={(c) => update({ secret: c === true, value: c === true ? null : "" })} />
                  Secret
                </label>
                <IconButton aria-label={`Remove variable ${i + 1}`} size="small" appearance="subtle" onClick={() => set({ env: hop.env.filter((_, j) => j !== i) })}>
                  <Icon icon={Delete} />
                </IconButton>
              </div>
            );
          })}
          <Button size="small" className="self-start" onClick={() => set({ env: [...hop.env, { name: "", secret: false, value: "" }] })}>
            <Icon icon={Add} /> Add variable
          </Button>
        </div>
        <FieldDescription>The program starts with a clean environment (PATH, HOME, USER, LANG, TMPDIR) plus these; a secret's value never appears in an error or the log.</FieldDescription>
      </Field>
      <Field>
        <FieldLabel>Working directory</FieldLabel>
        <Input value={hop.cwd ?? ""} onValueChange={(cwd) => set({ cwd: cwd === "" ? null : cwd })} placeholder="The server's own" spellCheck={false} className="font-mono" />
      </Field>
      <Field>
        <FieldLabel>What will run</FieldLabel>
        <Code className="break-all">{preview}</Code>
        <FieldDescription>On the server's own machine, as the user running mightyconsole-server; confirmed before its first run.</FieldDescription>
      </Field>
    </div>
  );
}

function splitAddress(address: string): [string, string] {
  const at = address.lastIndexOf(":");
  if (at <= 0) return [address || "{host}", "{port}"];
  return [address.slice(0, at).replace(/^\[|\]$/g, ""), address.slice(at + 1)];
}
