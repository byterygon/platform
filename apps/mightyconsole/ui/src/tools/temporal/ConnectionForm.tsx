// The Temporal connection form (Mightyconsole spec §9.1): address, namespace, TLS and mTLS, an API
// key, the workflow list's page size. The profile's name and colour are the shell's.
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ConnectionFormProps } from "../types";
import { DEFAULT_ADDRESS, DEFAULT_NAMESPACE, DEFAULT_PAGE_SIZE, tlsOf } from "./profile";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function ConnectionForm({ fields, secrets, storedSecrets, errors, onFields, onSecrets, disabled }: ConnectionFormProps) {
  const tls = tlsOf(fields);
  const setTls = (patch: Partial<typeof tls>) => onFields({ tls: { ...tls, ...patch } });
  const pageSize = fields["pageSize"];
  return (
    <>
      <Field invalid={errors["address"] !== undefined}>
        <FieldLabel>Address</FieldLabel>
        <Input value={str(fields["address"])} onValueChange={(v) => onFields({ address: v })} placeholder={DEFAULT_ADDRESS} disabled={disabled} autoComplete="off" spellCheck={false} />
        <FieldDescription>The frontend's host:port. Temporal Cloud: your-namespace.a1b2c.tmprl.cloud:7233.</FieldDescription>
        {errors["address"] ? <FieldError match>{errors["address"]}</FieldError> : null}
      </Field>
      <Field invalid={errors["namespace"] !== undefined}>
        <FieldLabel>Namespace</FieldLabel>
        <Input value={str(fields["namespace"])} onValueChange={(v) => onFields({ namespace: v })} placeholder={DEFAULT_NAMESPACE} disabled={disabled} autoComplete="off" spellCheck={false} />
        <FieldDescription>The namespace opened first; the others of the cluster are listed in the Workflows tab.</FieldDescription>
        {errors["namespace"] ? <FieldError match>{errors["namespace"]}</FieldError> : null}
      </Field>
      <Field invalid={errors["pageSize"] !== undefined}>
        <FieldLabel>Workflows per page</FieldLabel>
        <Input
          inputMode="numeric"
          value={typeof pageSize === "number" ? String(pageSize) : str(pageSize)}
          onValueChange={(v) => onFields({ pageSize: /^\d+$/.test(v.trim()) ? Number(v.trim()) : v })}
          placeholder={String(DEFAULT_PAGE_SIZE)}
          disabled={disabled}
        />
        {errors["pageSize"] ? <FieldError match>{errors["pageSize"]}</FieldError> : null}
      </Field>
      <Field invalid={errors["tls"] !== undefined}>
        <FieldLabel>
          <Switch checked={tls.enabled} onCheckedChange={(enabled) => setTls({ enabled })} disabled={disabled} /> Use TLS
        </FieldLabel>
        <FieldDescription>Trusts the operating system's roots and the CA below. There is no option to skip verification.</FieldDescription>
        {errors["tls"] ? <FieldError match>{errors["tls"]}</FieldError> : null}
      </Field>
      {tls.enabled ? (
        <>
          <Field>
            <FieldLabel>CA certificate (PEM)</FieldLabel>
            <Textarea value={tls.caPem ?? ""} onValueChange={(v) => setTls({ caPem: v })} rows={4} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
            <FieldDescription>Only for a private CA; public CAs are trusted already.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Client certificate (PEM)</FieldLabel>
            <Textarea value={tls.clientCertPem ?? ""} onValueChange={(v) => setTls({ clientCertPem: v })} rows={4} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
            <FieldDescription>For mutual TLS (Temporal Cloud with a certificate).</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Client private key (PEM)</FieldLabel>
            <Textarea
              value={str(secrets["clientKeyPem"])}
              onValueChange={(v) => onSecrets({ clientKeyPem: v })}
              rows={4}
              spellCheck={false}
              placeholder={storedSecrets.has("clientKeyPem") ? "Set (paste to replace)" : "Not set"}
              disabled={disabled}
            />
          </Field>
          <Field>
            <FieldLabel>Server name</FieldLabel>
            <Input value={tls.serverName ?? ""} onValueChange={(v) => setTls({ serverName: v })} placeholder="The address's host" disabled={disabled} autoComplete="off" spellCheck={false} />
            <FieldDescription>Only when the certificate names a different host than the address.</FieldDescription>
          </Field>
        </>
      ) : null}
      <Field>
        <FieldLabel>API key</FieldLabel>
        <PasswordInput
          value={str(secrets["apiKey"])}
          onValueChange={(v) => onSecrets({ apiKey: v })}
          placeholder={storedSecrets.has("apiKey") ? "Set (type to replace)" : "Not set"}
          autoComplete="off"
          disabled={disabled}
        />
        <FieldDescription>Temporal Cloud API key, sent as a bearer token over TLS only.</FieldDescription>
      </Field>
    </>
  );
}
