// The Docker connection form (Mightyconsole spec §10.1, TSK-81 mockup frame docker-profile): host,
// port and user of the SSH server; a private key (pasted or from its file, with its passphrase), a
// password or the server's ssh-agent; the socket path and keepalive; the trusted host key, which
// only the first connection sets (spec §10.2). The profile's name and colour are the shell's.
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { DockerAuth } from "@/gen/api";
import { keyTypeLabel } from "@/app/dialogs/HostKeyDialog";
import type { ConnectionFormProps } from "../types";
import { DEFAULT_KEEPALIVE_SEC, DEFAULT_PORT, DEFAULT_SOCKET, authOf, hostKeyOf } from "./profile";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

/** A typed number stays a number; anything else stays text for the validation to name. */
const numberOrText = (v: string): number | string => (/^\d+$/.test(v.trim()) ? Number(v.trim()) : v);

const AUTH: { value: DockerAuth; label: string }[] = [
  { value: "privateKey", label: "Private key" },
  { value: "password", label: "Password" },
  { value: "agent", label: "ssh-agent" },
];

/** Private keys are small; anything bigger is not one. */
const MAX_KEY_FILE = 64 * 1024;

export function ConnectionForm({ fields, secrets, storedSecrets, errors, onFields, onSecrets, disabled }: ConnectionFormProps) {
  const auth = authOf(fields);
  const hostKey = hostKeyOf(fields);
  const placeholder = (key: string, set: string, unset: string) => (storedSecrets.has(key) ? set : unset);
  const number = (key: string) => {
    const value = fields[key];
    return typeof value === "number" ? String(value) : str(value);
  };
  const readKeyFile = async (files: File[]) => {
    const file = files[0];
    if (!file || file.size > MAX_KEY_FILE) return;
    onSecrets({ privateKey: await file.text() });
  };
  return (
    <>
      <div className="flex items-start gap-inline-md">
        <Field invalid={errors["host"] !== undefined} className="min-w-0 flex-1">
          <FieldLabel>Host</FieldLabel>
          <Input value={str(fields["host"])} onValueChange={(v) => onFields({ host: v })} placeholder="10.40.2.17 or build-host.lan" disabled={disabled} autoComplete="off" spellCheck={false} required />
          {errors["host"] ? <FieldError match>{errors["host"]}</FieldError> : null}
        </Field>
        <Field invalid={errors["port"] !== undefined} className="w-24">
          <FieldLabel>Port</FieldLabel>
          <Input inputMode="numeric" value={number("port")} onValueChange={(v) => onFields({ port: numberOrText(v) })} placeholder={String(DEFAULT_PORT)} disabled={disabled} />
          {errors["port"] ? <FieldError match>{errors["port"]}</FieldError> : null}
        </Field>
      </div>
      <Field invalid={errors["username"] !== undefined}>
        <FieldLabel>Username</FieldLabel>
        <Input value={str(fields["username"])} onValueChange={(v) => onFields({ username: v })} placeholder="deploy" disabled={disabled} autoComplete="off" spellCheck={false} required />
        <FieldDescription>A user in the host's docker group. Nothing is installed on the host.</FieldDescription>
        {errors["username"] ? <FieldError match>{errors["username"]}</FieldError> : null}
      </Field>
      <Field invalid={errors["auth"] !== undefined}>
        <FieldLabel>Authentication</FieldLabel>
        <RadioGroup aria-label="Authentication" value={auth} onValueChange={(v) => onFields({ auth: v })} className="flex-row gap-inline-lg" disabled={disabled}>
          {AUTH.map((a) => (
            <label key={a.value} className="flex items-center gap-inline-xs text-body-1">
              <RadioGroupItem value={a.value} />
              {a.label}
            </label>
          ))}
        </RadioGroup>
        {errors["auth"] ? <FieldError match>{errors["auth"]}</FieldError> : null}
      </Field>
      {auth === "privateKey" ? (
        <>
          <Field invalid={errors["privateKey"] !== undefined}>
            <FieldLabel>Private key</FieldLabel>
            <Textarea
              value={str(secrets["privateKey"])}
              onValueChange={(v) => onSecrets({ privateKey: v })}
              rows={4}
              spellCheck={false}
              placeholder={placeholder("privateKey", "Set (paste to replace)", "-----BEGIN OPENSSH PRIVATE KEY-----")}
              disabled={disabled}
            />
            <FieldDescription>A profile secret: never logged, exported only when you include secrets.</FieldDescription>
            {errors["privateKey"] ? <FieldError match>{errors["privateKey"]}</FieldError> : null}
          </Field>
          {/* Outside the Field: a Field labels one control, and the key's text area is the one to name. */}
          <FileInput aria-label="Private key file" onFilesChange={(files) => void readKeyFile(files)} chooseLabel="Choose key file" emptyLabel="Or paste OpenSSH or PEM text above" disabled={disabled} />
          <Field invalid={errors["passphrase"] !== undefined}>
            <FieldLabel>Passphrase</FieldLabel>
            <PasswordInput value={str(secrets["passphrase"])} onValueChange={(v) => onSecrets({ passphrase: v })} placeholder={placeholder("passphrase", "Set (type to replace)", "Only for an encrypted key")} autoComplete="off" disabled={disabled} />
            {errors["passphrase"] ? <FieldError match>{errors["passphrase"]}</FieldError> : null}
          </Field>
        </>
      ) : auth === "password" ? (
        <Field invalid={errors["password"] !== undefined}>
          <FieldLabel>Password</FieldLabel>
          <PasswordInput value={str(secrets["password"])} onValueChange={(v) => onSecrets({ password: v })} placeholder={placeholder("password", "Set (type to replace)", "Not set")} autoComplete="off" disabled={disabled} />
          {errors["password"] ? <FieldError match>{errors["password"]}</FieldError> : null}
        </Field>
      ) : (
        <p className="text-body-1 text-fg-muted">
          Uses the ssh-agent of the user running mightyconsole-server (<Code>SSH_AUTH_SOCK</Code>), on Linux and macOS.
        </p>
      )}
      <Field invalid={errors["socketPath"] !== undefined}>
        <FieldLabel>Docker socket</FieldLabel>
        <Input value={str(fields["socketPath"])} onValueChange={(v) => onFields({ socketPath: v })} placeholder={DEFAULT_SOCKET} disabled={disabled} autoComplete="off" spellCheck={false} />
        <FieldDescription>
          Rootless Docker: <Code>/run/user/&lt;uid&gt;/docker.sock</Code>. The host's sshd must forward Unix sockets.
        </FieldDescription>
        {errors["socketPath"] ? <FieldError match>{errors["socketPath"]}</FieldError> : null}
      </Field>
      <Field invalid={errors["keepaliveSec"] !== undefined}>
        <FieldLabel>Keepalive (seconds)</FieldLabel>
        <Input inputMode="numeric" value={number("keepaliveSec")} onValueChange={(v) => onFields({ keepaliveSec: numberOrText(v) })} placeholder={String(DEFAULT_KEEPALIVE_SEC)} disabled={disabled} />
        <FieldDescription>0 turns it off.</FieldDescription>
        {errors["keepaliveSec"] ? <FieldError match>{errors["keepaliveSec"]}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel>Host key</FieldLabel>
        {hostKey ? (
          <div className="flex items-center gap-inline-md">
            <Code className="min-w-0 break-all">
              {keyTypeLabel(hostKey.algorithm)} · {hostKey.fingerprintSha256}
            </Code>
            <Button size="small" appearance="subtle" onClick={() => onFields({ hostKey: null })} disabled={disabled}>
              Forget
            </Button>
          </div>
        ) : (
          <FieldDescription>Not trusted yet: the first connection shows its fingerprint.</FieldDescription>
        )}
      </Field>
    </>
  );
}
