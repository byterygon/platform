// The Temporal connection form (Mightyconsole spec §9.1): address, namespace, TLS and mTLS, an API
// key, the workflow list's page size, External Storage on S3 (TSK-103). The profile's name and
// colour are the shell's.
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { CopyButton } from "@/app/page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { TemporalTestCodecOutput } from "@/gen/api";
import { testDraft } from "@/profiles/server";
import { readRouterConfig } from "@/app/router";
import type { ConnectionFormProps } from "../types";
import { DEFAULT_ADDRESS, DEFAULT_CODEC_ORIGINS, payloadCodecOf, profile, DEFAULT_NAMESPACE, DEFAULT_PAGE_SIZE, DEFAULT_THRESHOLD_BYTES, codecEndpointOf, codecServerOf, externalStorageOf, tlsOf } from "./profile";

const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function ConnectionForm({ fields, secrets, storedSecrets, errors, onFields, onSecrets, disabled, profileId, client, draft }: ConnectionFormProps) {
  const pc = payloadCodecOf(fields);
  const setPc = (patch: Partial<typeof pc>) => onFields({ codec: { ...pc, ...patch } });
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<TemporalTestCodecOutput | { failed: string } | null>(null);
  const testCodec = async () => {
    if (!client || !draft) return;
    setTesting(true);
    setTested(null);
    try {
      setTested(await client.temporal.testCodec({ draft: testDraft(draft()), ...(profileId ? { basedOn: profileId } : {}), namespace: null }));
    } catch (e) {
      setTested({ failed: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };
  const tls = tlsOf(fields);
  const setTls = (patch: Partial<typeof tls>) => onFields({ tls: { ...tls, ...patch } });
  const pageSize = fields["pageSize"];
  const ext = externalStorageOf(fields);
  const setExt = (patch: Partial<typeof ext>) => onFields({ externalStorage: { ...ext, ...patch } });
  const codec = codecServerOf(fields);
  const setCodec = (patch: Partial<typeof codec>) => onFields({ codecServer: { ...codec, ...patch } });
  const endpoint = profileId ? codecEndpointOf(window.location.origin + readRouterConfig().basePath, profileId) : null;
  const loopbackEndpoint = profileId ? codecEndpointOf("http://127.0.0.1:7444", profileId) : null;
  const namespace = str(fields["namespace"]).trim() || DEFAULT_NAMESPACE;
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
        <FieldLabel>Payload codec</FieldLabel>
        <RadioGroup aria-label="Payload codec" value={pc.enabled ? "server" : "none"} onValueChange={(v) => setPc({ enabled: v === "server" })} className="flex-row gap-inline-xl" disabled={disabled}>
          <label className="flex items-center gap-inline-md text-body-1">
            <RadioGroupItem value="none" /> None, show payloads as stored
          </label>
          <label className="flex items-center gap-inline-md text-body-1">
            <RadioGroupItem value="server" /> Codec server
          </label>
        </RadioGroup>
        <FieldDescription>Decrypt and decompress payloads for display, through your own codec server.</FieldDescription>
      </Field>
      {pc.enabled ? (
        <>
          <Field invalid={errors["codec.endpoint"] !== undefined}>
            <FieldLabel>Endpoint</FieldLabel>
            <Input value={pc.endpoint} onValueChange={(v) => setPc({ endpoint: v })} placeholder="https://codec.internal:8888" disabled={disabled} autoComplete="off" spellCheck={false} />
            <FieldDescription>Mightyconsole calls POST /decode and /encode on it, in Temporal's codec server format.</FieldDescription>
            {errors["codec.endpoint"] ? <FieldError match>{errors["codec.endpoint"]}</FieldError> : null}
          </Field>
          <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
            <Field>
              <FieldLabel>Authorization header</FieldLabel>
              <PasswordInput value={str(secrets["codecAuthorization"])} onValueChange={(v) => onSecrets({ codecAuthorization: v })} placeholder={storedSecrets.has("codecAuthorization") ? "Set (type to replace)" : "Bearer …"} autoComplete="off" disabled={disabled} />
              <FieldDescription>Stored as a secret of this profile.</FieldDescription>
            </Field>
            <Field invalid={errors["codec.caPem"] !== undefined}>
              <FieldLabel>CA certificate (PEM)</FieldLabel>
              <Textarea value={pc.caPem} onValueChange={(v) => setPc({ caPem: v })} rows={2} spellCheck={false} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
              <FieldDescription>No system roots, as for registries (Open question 31).</FieldDescription>
              {errors["codec.caPem"] ? <FieldError match>{errors["codec.caPem"]}</FieldError> : null}
            </Field>
          </div>
          <Field invalid={errors["codec.namespaces"] !== undefined}>
            <FieldLabel>Per namespace</FieldLabel>
            <Textarea value={pc.namespaces} onValueChange={(v) => setPc({ namespaces: v })} rows={2} spellCheck={false} placeholder="payments https://codec-payments.internal:8888" disabled={disabled} />
            <FieldDescription>Other namespaces use the endpoint above.</FieldDescription>
            {errors["codec.namespaces"] ? <FieldError match>{errors["codec.namespaces"]}</FieldError> : null}
          </Field>
          <Field orientation="horizontal">
            <Checkbox checked={pc.sendNamespace} onCheckedChange={(v) => setPc({ sendNamespace: v === true })} disabled={disabled} />
            <FieldLabel>Send the namespace as X-Namespace</FieldLabel>
          </Field>
          <Field orientation="horizontal">
            <Checkbox checked={pc.encodeInputs} onCheckedChange={(v) => setPc({ encodeInputs: v === true })} disabled={disabled} />
            <FieldLabel>Encode inputs I send (start, signal, schedule, query) with /encode</FieldLabel>
          </Field>
          <Field invalid={errors["codec.timeoutMs"] !== undefined}>
            <FieldLabel>Timeout (ms)</FieldLabel>
            <Input inputMode="numeric" value={pc.timeoutMs === undefined ? "" : String(pc.timeoutMs)} onValueChange={(v) => setPc({ timeoutMs: /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined })} placeholder="10000" disabled={disabled} />
            <FieldDescription>Per call, up to 100 payloads each. When the codec fails, payloads show as stored with the reason.</FieldDescription>
            {errors["codec.timeoutMs"] ? <FieldError match>{errors["codec.timeoutMs"]}</FieldError> : null}
          </Field>
          {client && draft ? (
            <Button appearance="secondary" className="self-start" loading={testing} onClick={() => void testCodec()} disabled={disabled}>
              Test codec
            </Button>
          ) : null}
          {tested === null ? null : "failed" in tested || tested.error ? (
            <Alert intent="danger">
              <AlertTitle>The codec did not answer</AlertTitle>
              <AlertDescription>{"failed" in tested ? tested.failed : tested.error}</AlertDescription>
            </Alert>
          ) : (
            <Alert intent="success">
              <AlertTitle>Codec answered</AlertTitle>
              <AlertDescription>
                Decoded {tested.decoded} of {tested.sampled} sample payloads from {tested.namespace} in {tested.ms} ms{tested.from.length > 0 ? `: ${tested.from.join(", ")} → ${tested.to.join(", ")}` : ""}. mightyconsole-server makes the call, never the browser: the token stays on the server.
              </AlertDescription>
            </Alert>
          )}
        </>
      ) : null}
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
          <Field invalid={errors["codecServer"] !== undefined}>
            <FieldLabel>
              <Switch checked={codec.enabled} onCheckedChange={(enabled) => setCodec({ enabled })} disabled={disabled} /> Serve as a codec endpoint
            </FieldLabel>
            <FieldDescription>The Temporal Web UI and the temporal CLI read payloads stored outside through this server, while this profile is connected. Temporal decides who may: the caller's token must be allowed to read the namespace, and a caller without a token is refused.</FieldDescription>
            {errors["codecServer"] ? <FieldError match>{errors["codecServer"]}</FieldError> : null}
          </Field>
          {codec.enabled ? (
            <>
              <Field invalid={errors["codecServer.allowedOrigins"] !== undefined}>
                <FieldLabel>Allowed origins</FieldLabel>
                <Input value={codec.allowedOrigins} onValueChange={(v) => setCodec({ allowedOrigins: v })} placeholder={DEFAULT_CODEC_ORIGINS} disabled={disabled} autoComplete="off" spellCheck={false} />
                <FieldDescription>The Web UI's address; other web pages are refused. The CLI sends no origin and is accepted.</FieldDescription>
                {errors["codecServer.allowedOrigins"] ? <FieldError match>{errors["codecServer.allowedOrigins"]}</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel>
                  <Switch checked={codec.allowAnonymous} onCheckedChange={(allowAnonymous) => setCodec({ allowAnonymous })} disabled={disabled} /> Allow callers without a token
                </FieldLabel>
                <FieldDescription>Only for a Temporal without authentication: anyone who can reach this server could then read the namespace's stored payloads.</FieldDescription>
              </Field>
              {endpoint && loopbackEndpoint ? (
                <div aria-label="Codec endpoint" className="flex flex-col gap-stack-xs rounded-md bg-inset p-inset-sm text-caption-1 text-fg-muted">
                  <span className="flex items-center gap-inline-xs">
                    <span className="text-caption-1-strong text-fg">Web UI</span> Settings, Data encoder: <span className="min-w-0 truncate font-mono text-fg">{endpoint}</span>
                    <CopyButton value={endpoint} what="the codec endpoint" />
                  </span>
                  <span className="flex items-center gap-inline-xs">
                    <span className="text-caption-1-strong text-fg">CLI</span> <span className="min-w-0 truncate font-mono text-fg">temporal workflow show -n {namespace} -w ID --codec-endpoint {loopbackEndpoint}</span>
                    <CopyButton value={`temporal workflow show -n ${namespace} -w ID --codec-endpoint ${loopbackEndpoint}`} what="the command" />
                  </span>
                  <span>The CLI does not trust this server's own certificate: start the server with --codec-listen 127.0.0.1:7444 for the plain loopback address above, or give it a certificate the system trusts (--tls-cert, --tls-key).</span>
                </div>
              ) : (
                <p className="text-caption-1 text-fg-muted">The endpoint's address shows once the profile is saved.</p>
              )}
            </>
          ) : null}
        </>
      ) : null}
    </>
  );
}
