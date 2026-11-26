// The SSH host editor (DOC-23 §4.3, §10, TSK-114 frame routes-host-editor; TSK-144): name, host and
// port, user, authentication (a private key with its passphrase, a password, or the server's
// ssh-agent), keepalive and the trusted host key with Forget, then the profiles that use the host.
// Secrets are write-only: the form shows whether one is stored and takes a new value to replace it.
// Test logs in on the server; an unknown key asks to be trusted, and Save keeps it.
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Code } from "@/components/ui/code";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { DockerAuth, SshHostView } from "@/gen/api";
import { PlugConnected } from "@/lib/icons";
import { AUTH_LABELS, DEFAULT_KEEPALIVE_SEC, DEFAULT_SSH_PORT, type HostErrors, type SavedHost, type SshHostDraft, type SshHostSecret, addressOf, draftOf, emptyDraft, fieldsOf, saveHost, testHost, validateHost } from "@/profiles/ssh-hosts";
import type { MightyClient } from "../client";
import { HostKeyDialog, keyTypeLabel } from "../dialogs/HostKeyDialog";
import { describeError } from "../messages";
import { ErrorState } from "../states";
import type { DescribedError } from "@/tools/types";

/** Private keys are small; anything bigger is not one. */
const MAX_KEY_FILE = 64 * 1024;

const AUTHS: readonly DockerAuth[] = ["privateKey", "password", "agent"];

export interface HostEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: MightyClient;
  /** The host to edit; none adds one. */
  host?: SshHostView | undefined;
  /** A new host for the tenant by default (a shared profile's). */
  sharedByDefault?: boolean;
  onSaved?: (saved: SavedHost) => void;
  /** Opens a profile that uses the host. */
  onOpenUser?: (profileId: string) => void;
}

type TestState = { status: "idle" } | { status: "running" } | { status: "ok"; ms: number } | { status: "failed"; error: DescribedError };

export function HostEditor({ open, onOpenChange, client, host, sharedByDefault = false, onSaved, onOpenUser }: HostEditorProps) {
  const [draft, setDraft] = useState<SshHostDraft>(() => (host ? draftOf(host) : { ...emptyDraft(), shared: sharedByDefault }));
  const [errors, setErrors] = useState<HostErrors>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<DescribedError | null>(null);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [trusting, setTrusting] = useState(false);
  useEffect(() => {
    if (!open) return;
    setDraft(host ? draftOf(host) : { ...emptyDraft(), shared: sharedByDefault });
    setErrors({});
    setSaveError(null);
    setTest({ status: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, host?.id]);

  const stored = new Set(host?.secrets.filter((s) => s.set).map((s) => s.field) ?? []);
  const readOnly = host !== undefined && host.access !== "owner" && host.access !== "edit";
  const set = (patch: Partial<SshHostDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const setSecret = (key: SshHostSecret, value: string) => setDraft((d) => ({ ...d, secrets: { ...d.secrets, [key]: value } }));
  const isStored = (key: SshHostSecret) => stored.has(key) && !draft.remove.includes(key);
  const placeholder = (key: SshHostSecret, unset: string) => (isStored(key) ? "Set (type to replace)" : unset);
  const toggleRemove = (key: SshHostSecret) => setDraft((d) => ({ ...d, remove: d.remove.includes(key) ? d.remove.filter((k) => k !== key) : [...d.remove, key] }));

  const readKeyFile = async (files: File[]) => {
    const file = files[0];
    if (!file || file.size > MAX_KEY_FILE) return;
    setSecret("privateKey", await file.text());
  };

  const save = async () => {
    const next = validateHost(draft, stored);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveHost(client, draft, host);
      onSaved?.(saved);
      onOpenChange(false);
    } catch (e) {
      setSaveError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const runTest = async (d: SshHostDraft = draft) => {
    const next = validateHost(d, stored);
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setTest({ status: "running" });
    try {
      const out = await testHost(client, d, host);
      setTest({ status: "ok", ms: out.ms });
    } catch (e) {
      const error = describeError(e);
      setTest({ status: "failed", error });
      if (error.hostKey) setTrusting(true);
    }
  };
  const failedKey = test.status === "failed" ? test.error.hostKey : undefined;

  const title = host ? `Edit ${host.name}` : "New SSH host";
  const users = host ? host.usedBy.length + host.usedByHidden : 0;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="md">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {host ? `${host.name} · ${users === 0 ? "not used yet" : `used by ${users}`}` : "A login to one machine, saved once: Docker hosts over SSH choose it."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="ssh-host-form"
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field invalid={errors.name !== undefined}>
              <FieldLabel>Name</FieldLabel>
              <Input value={draft.name} onValueChange={(name) => set({ name })} placeholder="bastion-prod" disabled={readOnly} required autoComplete="off" />
              <FieldDescription>How Docker hosts list it.</FieldDescription>
              {errors.name ? <FieldError match>{errors.name}</FieldError> : null}
            </Field>
            <div className="flex items-start gap-inline-md">
              <Field invalid={errors.host !== undefined} className="min-w-0 flex-1">
                <FieldLabel>Host</FieldLabel>
                <Input value={draft.host} onValueChange={(v) => set({ host: v })} placeholder="10.40.2.17 or build-host.lan" disabled={readOnly} autoComplete="off" spellCheck={false} required />
                {errors.host ? <FieldError match>{errors.host}</FieldError> : null}
              </Field>
              <Field invalid={errors.port !== undefined} className="w-24">
                <FieldLabel>Port</FieldLabel>
                <Input inputMode="numeric" value={draft.port} onValueChange={(v) => set({ port: v })} placeholder={String(DEFAULT_SSH_PORT)} disabled={readOnly} />
                {errors.port ? <FieldError match>{errors.port}</FieldError> : null}
              </Field>
            </div>
            <Field invalid={errors.username !== undefined}>
              <FieldLabel>Username</FieldLabel>
              <Input value={draft.username} onValueChange={(v) => set({ username: v })} placeholder="deploy" disabled={readOnly} autoComplete="off" spellCheck={false} required />
              <FieldDescription>For Docker: a user in the host's docker group. Nothing is installed on the host.</FieldDescription>
              {errors.username ? <FieldError match>{errors.username}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel>Authentication</FieldLabel>
              <RadioGroup aria-label="Authentication" value={draft.auth} onValueChange={(v) => set({ auth: v as DockerAuth })} className="flex-row gap-inline-lg" disabled={readOnly}>
                {AUTHS.map((a) => (
                  <label key={a} className="flex items-center gap-inline-xs text-body-1">
                    <RadioGroupItem value={a} />
                    {AUTH_LABELS[a]}
                  </label>
                ))}
              </RadioGroup>
            </Field>
            {draft.auth === "privateKey" ? (
              <>
                <Field invalid={errors.privateKey !== undefined}>
                  <FieldLabel>Private key</FieldLabel>
                  <Textarea value={draft.secrets.privateKey ?? ""} onValueChange={(v) => setSecret("privateKey", v)} rows={4} spellCheck={false} placeholder={placeholder("privateKey", "-----BEGIN OPENSSH PRIVATE KEY-----")} disabled={readOnly} />
                  <FieldDescription>A secret of this host: write-only, and every Docker host that uses the host shares it.</FieldDescription>
                  {errors.privateKey ? <FieldError match>{errors.privateKey}</FieldError> : null}
                </Field>
                {/* Outside the Field: a Field labels one control, and the key's text area is the one to name. */}
                <FileInput aria-label="Private key file" onFilesChange={(files) => void readKeyFile(files)} chooseLabel="Choose key file" emptyLabel="Or paste OpenSSH or PEM text above" disabled={readOnly} />
                <Field>
                  <FieldLabel>Passphrase</FieldLabel>
                  <PasswordInput value={draft.secrets.passphrase ?? ""} onValueChange={(v) => setSecret("passphrase", v)} placeholder={placeholder("passphrase", "Only for an encrypted key")} autoComplete="off" disabled={readOnly} />
                </Field>
              </>
            ) : draft.auth === "password" ? (
              <Field invalid={errors.password !== undefined}>
                <FieldLabel>Password</FieldLabel>
                <PasswordInput value={draft.secrets.password ?? ""} onValueChange={(v) => setSecret("password", v)} placeholder={placeholder("password", "Not set")} autoComplete="off" disabled={readOnly} />
                {errors.password ? <FieldError match>{errors.password}</FieldError> : null}
              </Field>
            ) : (
              <p className="text-body-1 text-fg-muted">
                Uses the ssh-agent of the user running mightyconsole-server (<Code>SSH_AUTH_SOCK</Code>), on Linux and macOS.
              </p>
            )}
            {host && stored.size > 0 ? (
              <Field>
                <FieldLabel>Stored secrets</FieldLabel>
                <FieldDescription>Set on the server; their values are never shown.</FieldDescription>
                <ul className="flex flex-col gap-stack-xs">
                  {[...stored].map((key) => (
                    <li key={key} className="flex items-center gap-inline-sm">
                      <span className="text-body-1">{key}</span>
                      <span className="text-caption-1 text-fg-muted">{draft.remove.includes(key as SshHostSecret) ? "removed on save" : "set"}</span>
                      <Button size="small" className="ms-auto" disabled={readOnly} onClick={() => toggleRemove(key as SshHostSecret)}>
                        {draft.remove.includes(key as SshHostSecret) ? "Keep" : "Remove"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Field>
            ) : null}
            <Field invalid={errors.keepaliveSec !== undefined}>
              <FieldLabel>Keepalive (seconds)</FieldLabel>
              <Input inputMode="numeric" value={draft.keepaliveSec} onValueChange={(v) => set({ keepaliveSec: v })} placeholder={String(DEFAULT_KEEPALIVE_SEC)} disabled={readOnly} />
              <FieldDescription>0 turns it off.</FieldDescription>
              {errors.keepaliveSec ? <FieldError match>{errors.keepaliveSec}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel>Host key</FieldLabel>
              {draft.hostKey ? (
                <div className="flex items-center gap-inline-md">
                  <Code className="min-w-0 break-all">
                    {keyTypeLabel(draft.hostKey.algorithm)} · {draft.hostKey.fingerprintSha256}
                  </Code>
                  <Button size="small" appearance="subtle" onClick={() => set({ hostKey: null })} disabled={readOnly}>
                    Forget
                  </Button>
                </div>
              ) : null}
              <FieldDescription>
                {draft.hostKey
                  ? "Checked every time anything connects to this host. A different key stops the connection; there is no option to skip the check. Forgetting or replacing a trusted key removes the stored secrets."
                  : "Not trusted yet: Test or the first connection shows its fingerprint."}
              </FieldDescription>
            </Field>
            {!host ? (
              <Field orientation="horizontal">
                <Checkbox checked={draft.shared} onCheckedChange={(v) => set({ shared: v === true })} />
                <FieldLabel>Shared: for shared Docker profiles (needs profiles.manage); a personal host serves only your own profiles</FieldLabel>
              </Field>
            ) : null}
            {host && host.usedBy.length > 0 ? (
              <Field>
                <FieldLabel>Used by</FieldLabel>
                <FieldDescription>A change applies to all of these at their next connect.</FieldDescription>
                <ul className="flex flex-col gap-stack-xs">
                  {host.usedBy.map((u) => (
                    <li key={u.id} className="flex items-center gap-inline-sm text-body-1">
                      <span>
                        {u.tool === "docker" ? "Docker" : u.tool} <b>{u.name}</b>
                      </span>
                      {onOpenUser ? (
                        <Button size="small" appearance="subtle" className="ms-auto" onClick={() => onOpenUser(u.id)}>
                          Open
                        </Button>
                      ) : null}
                    </li>
                  ))}
                  {host.usedByHidden > 0 ? <li className="text-caption-1 text-fg-muted">and {host.usedByHidden} you do not see</li> : null}
                </ul>
              </Field>
            ) : null}
            {test.status === "ok" ? (
              <Alert intent="success">
                <AlertTitle>The login works</AlertTitle>
                <AlertDescription>
                  Logged in to {addressOf(fieldsOf(draft))} as {draft.username.trim()} in {test.ms} ms and closed again.
                </AlertDescription>
              </Alert>
            ) : test.status === "failed" ? (
              <ErrorState error={test.error} {...(failedKey ? { onTrust: () => setTrusting(true) } : {})} />
            ) : null}
            {saveError ? <ErrorState error={saveError} /> : null}
          </form>
        </SheetBody>
        <HostKeyDialog
          open={trusting && failedKey !== undefined}
          name={draft.name.trim() || "SSH host"}
          target={addressOf(fieldsOf(draft))}
          details={failedKey ?? null}
          onCancel={() => setTrusting(false)}
          onTrust={(key) => {
            setTrusting(false);
            const next = { ...draft, hostKey: { algorithm: key.algorithm, fingerprintSha256: key.fingerprintSha256 } };
            setDraft(next);
            void runTest(next);
          }}
        />
        <SheetFooter>
          <Button className="me-auto" loading={test.status === "running"} disabled={readOnly} onClick={() => void runTest()}>
            <Icon icon={PlugConnected} /> Test
          </Button>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button appearance="primary" loading={saving} disabled={readOnly} onClick={() => void save()}>
            Save host
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
