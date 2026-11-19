// The Temporal connection form (Mightyconsole spec §9.1): address, namespace, TLS and mTLS, an API
// key, the workflow list's page size, External Storage on S3 (TSK-103). The profile's name and
// colour are the shell's.
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { ConnectionFormProps } from "../types";
import { DEFAULT_ADDRESS, DEFAULT_NAMESPACE, DEFAULT_PAGE_SIZE, DEFAULT_THRESHOLD_BYTES, externalStorageOf, tlsOf } from "./profile";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function ConnectionForm({ fields, secrets, storedSecrets, errors, onFields, onSecrets, disabled }: ConnectionFormProps) {
  const tls = tlsOf(fields);
  const setTls = (patch: Partial<typeof tls>) => onFields({ tls: { ...tls, ...patch } });
  const pageSize = fields["pageSize"];
  const ext = externalStorageOf(fields);
  const setExt = (patch: Partial<typeof ext>) => onFields({ externalStorage: { ...ext, ...patch } });
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
      <Field>
        <FieldLabel>
          <Switch checked={ext.enabled} onCheckedChange={(enabled) => setExt({ enabled })} disabled={disabled} /> External Storage on S3
        </FieldLabel>
        <FieldDescription>Where your workers' S3 storage driver keeps payloads of 256 KiB or more. Mightyconsole reads them with these credentials, and stores large inputs when they may write.</FieldDescription>
      </Field>
      {ext.enabled ? (
        <>
          <Field invalid={errors["externalStorage.bucket"] !== undefined}>
            <FieldLabel>Bucket</FieldLabel>
            <Input value={ext.bucket} onValueChange={(v) => setExt({ bucket: v })} placeholder="temporal-payloads" disabled={disabled} autoComplete="off" spellCheck={false} />
            <FieldDescription>The bucket of your workers' driver; large inputs are written here.</FieldDescription>
            {errors["externalStorage.bucket"] ? <FieldError match>{errors["externalStorage.bucket"]}</FieldError> : null}
          </Field>
          <Field invalid={errors["externalStorage.endpoint"] !== undefined}>
            <FieldLabel>Endpoint</FieldLabel>
            <Input value={ext.endpoint} onValueChange={(v) => setExt({ endpoint: v })} placeholder="https://s3.<region>.amazonaws.com" disabled={disabled} autoComplete="off" spellCheck={false} />
            <FieldDescription>Only for an S3-compatible store (MinIO, SeaweedFS, Ceph and others).</FieldDescription>
            {errors["externalStorage.endpoint"] ? <FieldError match>{errors["externalStorage.endpoint"]}</FieldError> : null}
          </Field>
          <Field>
            <FieldLabel>Region</FieldLabel>
            <Input value={ext.region} onValueChange={(v) => setExt({ region: v })} placeholder="us-east-1" disabled={disabled} autoComplete="off" spellCheck={false} />
          </Field>
          <Field>
            <FieldLabel>
              <Switch checked={ext.pathStyle} onCheckedChange={(pathStyle) => setExt({ pathStyle })} disabled={disabled} /> Path-style addressing
            </FieldLabel>
            <FieldDescription>endpoint/bucket/key instead of bucket.endpoint/key; most S3-compatible stores need it.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Access key ID</FieldLabel>
            <PasswordInput value={str(secrets["s3AccessKeyId"])} onValueChange={(v) => onSecrets({ s3AccessKeyId: v })} placeholder={storedSecrets.has("s3AccessKeyId") ? "Set (type to replace)" : "Not set"} autoComplete="off" disabled={disabled} />
          </Field>
          <Field>
            <FieldLabel>Secret access key</FieldLabel>
            <PasswordInput value={str(secrets["s3SecretAccessKey"])} onValueChange={(v) => onSecrets({ s3SecretAccessKey: v })} placeholder={storedSecrets.has("s3SecretAccessKey") ? "Set (type to replace)" : "Not set"} autoComplete="off" disabled={disabled} />
            <FieldDescription>Read-only keys are enough to read payloads; writing large inputs needs write access to the bucket.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Session token</FieldLabel>
            <PasswordInput value={str(secrets["s3SessionToken"])} onValueChange={(v) => onSecrets({ s3SessionToken: v })} placeholder={storedSecrets.has("s3SessionToken") ? "Set (type to replace)" : "Not set"} autoComplete="off" disabled={disabled} />
            <FieldDescription>Only for temporary credentials.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Other buckets to read</FieldLabel>
            <Input value={ext.readBuckets} onValueChange={(v) => setExt({ readBuckets: v })} placeholder="None" disabled={disabled} autoComplete="off" spellCheck={false} />
            <FieldDescription>When workers write to more than one bucket; comma separated.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>CA certificate (PEM)</FieldLabel>
            <Textarea value={ext.caPem} onValueChange={(v) => setExt({ caPem: v })} rows={3} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
            <FieldDescription>Only for a store with a private CA; without one, the operating system's roots are trusted.</FieldDescription>
          </Field>
          <Field invalid={errors["externalStorage.thresholdBytes"] !== undefined}>
            <FieldLabel>Store inputs from (bytes)</FieldLabel>
            <Input
              inputMode="numeric"
              value={ext.thresholdBytes === undefined ? "" : String(ext.thresholdBytes)}
              onValueChange={(v) => setExt(/^\d+$/.test(v.trim()) ? { thresholdBytes: Number(v.trim()) } : { thresholdBytes: undefined })}
              placeholder={String(DEFAULT_THRESHOLD_BYTES)}
              disabled={disabled}
            />
            <FieldDescription>The size from which an input Mightyconsole sends is stored outside; the SDKs' default is 262144.</FieldDescription>
            {errors["externalStorage.thresholdBytes"] ? <FieldError match>{errors["externalStorage.thresholdBytes"]}</FieldError> : null}
          </Field>
        </>
      ) : null}
    </>
  );
}
