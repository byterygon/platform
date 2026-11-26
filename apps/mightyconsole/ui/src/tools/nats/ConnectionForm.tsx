// The NATS connection form (Mightyconsole spec §6.1): servers, the five authentications, TLS and
// mTLS, then the connection name, the JetStream domain or API prefix, the inbox prefix and the
// request timeout. Secrets are write-only ("Set" / "Not set"); the name and colour are the shell's.
import { SecretControl } from "@/app/secret-control";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ConnectionFormProps } from "../types";
import { AUTH_LABELS, DEFAULT_CONNECTION_NAME, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_SERVER, type NatsAuth, authOf, tlsOf } from "./profile";

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const AUTHS = Object.keys(AUTH_LABELS) as NatsAuth[];

export function ConnectionForm({ fields, secrets, errors, onFields, onSecrets, disabled }: ConnectionFormProps) {
  const tls = tlsOf(fields);
  const setTls = (patch: Partial<typeof tls>) => onFields({ tls: { ...tls, ...patch } });
  const auth = authOf(fields);
  const servers = Array.isArray(fields["servers"]) ? (fields["servers"] as unknown[]).map(str).join("\n") : "";
  const js = typeof fields["jetstream"] === "object" && fields["jetstream"] !== null ? (fields["jetstream"] as Record<string, unknown>) : {};
  const timeout = fields["requestTimeoutMs"];
  const error = (key: string) => (errors[key] ? <FieldError match>{errors[key]}</FieldError> : null);
  return (
    <>
      <Field invalid={errors["servers"] !== undefined}>
        <FieldLabel>Servers</FieldLabel>
        <Textarea
          value={servers}
          onValueChange={(v) => onFields({ servers: v.split("\n") })}
          rows={2}
          spellCheck={false}
          placeholder={DEFAULT_SERVER}
          disabled={disabled}
        />
        <FieldDescription>One per line: nats://host:4222, or tls://host:4222 for TLS. Several for a cluster.</FieldDescription>
        {error("servers")}
      </Field>
      <Field>
        <FieldLabel>Authentication</FieldLabel>
        <Select<NatsAuth> items={AUTHS.map((a) => ({ value: a, label: AUTH_LABELS[a] }))} value={auth} onValueChange={(a) => onFields({ auth: a ?? "none" })} disabled={disabled}>
          {AUTHS.map((a) => (
            <SelectItem key={a} value={a}>
              {AUTH_LABELS[a]}
            </SelectItem>
          ))}
        </Select>
      </Field>
      {auth === "userPassword" ? (
        <>
          <Field invalid={errors["user"] !== undefined}>
            <FieldLabel>User</FieldLabel>
            <Input value={str(fields["user"])} onValueChange={(v) => onFields({ user: v })} autoComplete="off" spellCheck={false} disabled={disabled} />
            {error("user")}
          </Field>
          <Field invalid={errors["password"] !== undefined}>
            <FieldLabel>Password</FieldLabel>
            <SecretControl secretKey="password" noun="password" value={str(secrets["password"])} onValueChange={(v) => onSecrets({ password: v })} placeholder="Not set" disabled={disabled} />
            {error("password")}
          </Field>
        </>
      ) : null}
      {auth === "token" ? (
        <Field invalid={errors["token"] !== undefined}>
          <FieldLabel>Token</FieldLabel>
          <SecretControl secretKey="token" noun="token" value={str(secrets["token"])} onValueChange={(v) => onSecrets({ token: v })} placeholder="Not set" disabled={disabled} />
          {error("token")}
        </Field>
      ) : null}
      {auth === "nkey" ? (
        <Field invalid={errors["nkeySeed"] !== undefined}>
          <FieldLabel>NKey seed</FieldLabel>
          <SecretControl secretKey="nkeySeed" noun="NKey seed" value={str(secrets["nkeySeed"])} onValueChange={(v) => onSecrets({ nkeySeed: v })} placeholder="SUA…" disabled={disabled} />
          <FieldDescription>The user's seed (SU…), as in a .nk file. It signs the server's nonce; it is never sent.</FieldDescription>
          {error("nkeySeed")}
        </Field>
      ) : null}
      {auth === "creds" ? (
        <Field invalid={errors["creds"] !== undefined}>
          <FieldLabel>Credentials file</FieldLabel>
          <SecretControl secretKey="creds" noun="credentials" multiline rows={5} value={str(secrets["creds"])} onValueChange={(v) => onSecrets({ creds: v })} placeholder="-----BEGIN NATS USER JWT-----" disabled={disabled} />
          <FieldDescription>The text of a .creds file (the user JWT and its seed), for servers in operator mode.</FieldDescription>
          {error("creds")}
        </Field>
      ) : null}
      <Field invalid={errors["tls"] !== undefined}>
        <FieldLabel>
          <Switch checked={tls.enabled} onCheckedChange={(enabled) => setTls({ enabled })} disabled={disabled} /> Use TLS
        </FieldLabel>
        <FieldDescription>Also on for tls:// servers. Trusts the operating system's roots, or only the CA below. There is no option to skip verification.</FieldDescription>
        {error("tls")}
      </Field>
      {tls.enabled ? (
        <>
          <Field>
            <FieldLabel>CA certificate (PEM)</FieldLabel>
            <Textarea value={tls.caPem ?? ""} onValueChange={(v) => setTls({ caPem: v })} rows={4} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
            <FieldDescription>For a private CA: only it is trusted then.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Client certificate (PEM)</FieldLabel>
            <Textarea value={tls.clientCertPem ?? ""} onValueChange={(v) => setTls({ clientCertPem: v })} rows={4} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
            <FieldDescription>For servers that verify clients (mutual TLS).</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Client private key (PEM)</FieldLabel>
            <SecretControl secretKey="clientKeyPem" noun="private key" multiline rows={4} value={str(secrets["clientKeyPem"])} onValueChange={(v) => onSecrets({ clientKeyPem: v })} disabled={disabled} />
          </Field>
          <Field>
            <FieldLabel>Server name</FieldLabel>
            <Input value={tls.serverName ?? ""} onValueChange={(v) => setTls({ serverName: v })} placeholder="The server's host" disabled={disabled} autoComplete="off" spellCheck={false} />
            <FieldDescription>Only when the certificate names another host than the address.</FieldDescription>
          </Field>
        </>
      ) : null}
      <Field>
        <FieldLabel>Connection name</FieldLabel>
        <Input value={str(fields["connectionName"])} onValueChange={(v) => onFields({ connectionName: v })} placeholder={DEFAULT_CONNECTION_NAME} autoComplete="off" spellCheck={false} disabled={disabled} />
        <FieldDescription>How the server's connz shows this connection.</FieldDescription>
      </Field>
      <div className="flex flex-wrap gap-inline-md">
        <Field className="min-w-0 flex-1">
          <FieldLabel>JetStream domain</FieldLabel>
          <Input value={str(js["domain"])} onValueChange={(v) => onFields({ jetstream: { ...js, domain: v } })} placeholder="None" autoComplete="off" spellCheck={false} disabled={disabled} />
        </Field>
        <Field className="min-w-0 flex-1">
          <FieldLabel>JetStream API prefix</FieldLabel>
          <Input value={str(js["apiPrefix"])} onValueChange={(v) => onFields({ jetstream: { ...js, apiPrefix: v } })} placeholder="$JS.API" autoComplete="off" spellCheck={false} disabled={disabled} />
        </Field>
      </div>
      <div className="flex flex-wrap gap-inline-md">
        <Field className="min-w-0 flex-1" invalid={errors["inboxPrefix"] !== undefined}>
          <FieldLabel>Inbox prefix</FieldLabel>
          <Input value={str(fields["inboxPrefix"])} onValueChange={(v) => onFields({ inboxPrefix: v })} placeholder="_INBOX" autoComplete="off" spellCheck={false} disabled={disabled} />
          <FieldDescription>For accounts that limit where replies may go.</FieldDescription>
          {error("inboxPrefix")}
        </Field>
        <Field className="min-w-0 flex-1" invalid={errors["requestTimeoutMs"] !== undefined}>
          <FieldLabel>Request timeout (ms)</FieldLabel>
          <Input
            inputMode="numeric"
            value={typeof timeout === "number" ? String(timeout) : str(timeout)}
            onValueChange={(v) => onFields({ requestTimeoutMs: /^\d+$/.test(v.trim()) ? Number(v.trim()) : v })}
            placeholder={String(DEFAULT_REQUEST_TIMEOUT_MS)}
            disabled={disabled}
          />
          <FieldDescription>Requests and JetStream API calls.</FieldDescription>
          {error("requestTimeoutMs")}
        </Field>
      </div>
    </>
  );
}
