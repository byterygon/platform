// Add or edit the profile's Schema Registry (mockup frame codecs-registry; DOC-21 §5.3, Open
// question 45 (p)): a Confluent-compatible registry (Confluent, Apicurio, Redpanda) that only the
// server calls, with basic or bearer auth as a profile secret and a pinned CA (no system roots,
// Open question 31). On NATS, the subjects whose messages carry the Confluent wire format; other
// subjects reach the registry through a mapping to a subject and version. Test reaches it as the
// draft says, before saving: the number of subjects, the mode, the default compatibility.
import { useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import type { MightyClient } from "@/app/client";
import { Fold, Required } from "@/app/form-parts";
import { useSheetGuard } from "@/app/leave-guard";
import type { RegistryAuthKind, RegistryTestOutput } from "@/gen/api";
import { Delete, PlugConnected, Save } from "@/lib/icons";
import type { ProfileRecord } from "@/profiles/record";
import { REGISTRY_AUTH_LABELS, REGISTRY_SECRETS, type RegistryFields, registryOf, registryProblems, registrySecretSet, registryToConnect, splitPatterns } from "./registry";

const AUTHS = Object.keys(REGISTRY_AUTH_LABELS) as RegistryAuthKind[];

export interface RegistrySheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  profile: ProfileRecord;
  client: MightyClient;
  /** NATS: the subjects whose messages carry the wire format (Kafka finds it in every record). */
  wireFormatSubjects: boolean;
  /** Saves the registry (null removes it) with the secret typed, if any. */
  onSave(registry: RegistryFields | null, secrets: { password?: string; token?: string }): Promise<void>;
}

export function RegistrySheet({ open, onOpenChange, profile, client, wireFormatSubjects, onSave }: RegistrySheetProps) {
  const saved = registryOf(profile);
  const [url, setUrl] = useState(saved?.url ?? "");
  const [auth, setAuth] = useState<RegistryAuthKind>(saved?.auth ?? "none");
  const [username, setUsername] = useState(saved?.username ?? "");
  const [secret, setSecret] = useState("");
  const [caPem, setCaPem] = useState(saved?.tls.caPem ?? "");
  const [serverName, setServerName] = useState(saved?.tls.serverName ?? "");
  const [subjects, setSubjects] = useState((saved?.wireFormatSubjects ?? []).join(", "));
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [answer, setAnswer] = useState<RegistryTestOutput | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const generation = useRef(0);
  const releaseGuard = useSheetGuard(open, { url, auth, username, secret, caPem, serverName, subjects });
  useEffect(() => {
    if (!open) return;
    const r = registryOf(profile);
    setUrl(r?.url ?? "");
    setAuth(r?.auth ?? "none");
    setUsername(r?.username ?? "");
    setSecret("");
    setCaPem(r?.tls.caPem ?? "");
    setServerName(r?.tls.serverName ?? "");
    setSubjects((r?.wireFormatSubjects ?? []).join(", "));
    setTried(false);
    setFailure(null);
    setAnswer(null);
    setTestError(null);
    // The profile changes when this sheet saves; only opening resets it.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on open only, not on the save's own profile change
  }, [open]);

  const stored = registrySecretSet(profile, auth);
  const draft = (): RegistryFields => {
    const out: RegistryFields = { url: url.trim(), auth, tls: {} };
    if (auth === "basic" && username.trim() !== "") out.username = username.trim();
    if (caPem.trim() !== "") out.tls.caPem = caPem.trim();
    if (serverName.trim() !== "") out.tls.serverName = serverName.trim();
    if (wireFormatSubjects) out.wireFormatSubjects = splitPatterns(subjects);
    return out;
  };
  const problems = registryProblems(draft(), secret !== "" || stored);
  const invalid = Object.keys(problems).length > 0;
  const changed = () => {
    setAnswer(null);
    setTestError(null);
    setFailure(null);
  };
  const secretKey = auth === "basic" ? REGISTRY_SECRETS.password : REGISTRY_SECRETS.token;
  const secretsNow = (): Record<string, unknown> => ({ ...profile.secrets, ...(secret !== "" ? { [secretKey]: secret } : {}) });

  const runTest = async () => {
    setTried(true);
    if (invalid) return;
    const mine = ++generation.current;
    setTesting(true);
    setTestError(null);
    setAnswer(null);
    try {
      const out = await client.messaging.registry.test({ registry: registryToConnect(draft(), secretsNow(), wireFormatSubjects) });
      if (mine === generation.current) setAnswer(out);
    } catch (e) {
      if (mine === generation.current) setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === generation.current) setTesting(false);
    }
  };
  const save = async (registry: RegistryFields | null) => {
    setTried(true);
    if (registry !== null && invalid) return;
    setSaving(true);
    try {
      releaseGuard();
      const typed = secret === "" ? {} : auth === "basic" ? { password: secret } : { token: secret };
      await onSave(registry, typed);
      onOpenChange(false);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const error = (key: string) => (tried && problems[key] ? <FieldError match>{problems[key]}</FieldError> : null);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{saved ? "The schema registry" : "Add a schema registry"}</SheetTitle>
          <SheetDescription>{profile.name} · called by mightyconsole-server only</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="registry-form"
            aria-label="Schema registry"
            className="grid grid-cols-2 gap-x-inline-md gap-y-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void save(draft());
            }}
          >
            <div className="col-span-2 flex flex-col gap-stack-xs">
              <span className="text-body-1-strong text-fg">Kind</span>
              <span className="text-body-1 text-fg">Confluent-compatible (Confluent, Apicurio, Redpanda)</span>
            </div>
            <Field className="col-span-2" invalid={tried && problems["url"] !== undefined}>
              <FieldLabel>
                URL
                <Required />
              </FieldLabel>
              <Input
                value={url}
                onValueChange={(v) => {
                  setUrl(v);
                  changed();
                }}
                placeholder="https://registry.internal:8081"
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              {error("url")}
            </Field>
            <Field>
              <FieldLabel>Authentication</FieldLabel>
              <Select<RegistryAuthKind>
                items={AUTHS.map((a) => ({ value: a, label: REGISTRY_AUTH_LABELS[a] }))}
                value={auth}
                onValueChange={(a) => {
                  if (!a) return;
                  setAuth(a);
                  setSecret("");
                  changed();
                }}
              >
                {AUTHS.map((a) => (
                  <SelectItem key={a} value={a}>
                    {REGISTRY_AUTH_LABELS[a]}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            {auth === "basic" ? (
              <Field invalid={tried && problems["username"] !== undefined}>
                <FieldLabel>
                  User
                  <Required />
                </FieldLabel>
                <Input
                  value={username}
                  onValueChange={(v) => {
                    setUsername(v);
                    changed();
                  }}
                  autoComplete="off"
                />
                {error("username")}
              </Field>
            ) : (
              <span />
            )}
            {auth !== "none" ? (
              <Field className="col-span-2" invalid={tried && problems["secret"] !== undefined}>
                <FieldLabel>
                  {auth === "basic" ? "Password" : "Token"}
                  {stored ? (
                    <Badge appearance="tint" variant="success">
                      Set
                    </Badge>
                  ) : null}
                </FieldLabel>
                <PasswordInput
                  value={secret}
                  onValueChange={(v) => {
                    setSecret(v);
                    changed();
                  }}
                  placeholder={stored ? "Set (type to replace)" : "Not set"}
                  autoComplete="off"
                />
                <FieldDescription>A secret of this profile.</FieldDescription>
                {error("secret")}
              </Field>
            ) : null}
            <Field className="col-span-2" invalid={tried && problems["caPem"] !== undefined}>
              <FieldLabel>CA certificate (PEM)</FieldLabel>
              <Textarea
                value={caPem}
                onValueChange={(v) => {
                  setCaPem(v);
                  changed();
                }}
                rows={4}
                spellCheck={false}
                placeholder="-----BEGIN CERTIFICATE-----"
                className="font-mono"
              />
              <FieldDescription>Needed for https: no system roots are trusted (Open question 31).</FieldDescription>
              {error("caPem")}
            </Field>
            <div className="col-span-2">
              <Fold title="More TLS" value={serverName.trim() !== "" ? `server name ${serverName.trim()}` : "the server name is the URL's host"}>
                <Field>
                  <FieldLabel>Server name</FieldLabel>
                  <Input
                    value={serverName}
                    onValueChange={(v) => {
                      setServerName(v);
                      changed();
                    }}
                    placeholder="When the certificate names another host"
                    className="font-mono"
                    autoComplete="off"
                  />
                </Field>
              </Fold>
            </div>
            {wireFormatSubjects ? (
              <section aria-label="For NATS messages" className="col-span-2 flex flex-col gap-stack-sm border-t border-border-subtle pt-stack-md">
                <h3 className="text-body-1-strong text-fg">For NATS messages</h3>
                <p className="text-caption-1 text-fg-muted">Kafka finds the schema from the id in each record. NATS messages carry it only when the producer wrote the Confluent wire format; otherwise map a subject to a registry subject and version.</p>
                <Field invalid={tried && problems["wireFormatSubjects"] !== undefined}>
                  <FieldLabel>Detect the wire format on</FieldLabel>
                  <Input
                    value={subjects}
                    onValueChange={(v) => {
                      setSubjects(v);
                      changed();
                    }}
                    placeholder="orders.>, payments.>"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <FieldDescription>Subject patterns, separated by commas. Elsewhere a leading zero byte is not taken for a schema id.</FieldDescription>
                  {error("wireFormatSubjects")}
                </Field>
              </section>
            ) : null}
          </form>
          {answer ? (
            <Alert intent="success" className="mt-stack-md">
              <AlertDescription>
                <b>Registry answered.</b> {answer.subjects.toLocaleString()} {answer.subjects === 1 ? "subject" : "subjects"}
                {answer.mode ? ` · mode ${answer.mode}` : ""}
                {answer.compatibility ? ` · compatibility ${answer.compatibility}` : ""}.
              </AlertDescription>
            </Alert>
          ) : null}
          {testError ? (
            <Alert intent="danger" className="mt-stack-md">
              <AlertDescription>{testError}</AlertDescription>
            </Alert>
          ) : null}
          {failure ? (
            <Alert intent="danger" className="mt-stack-md">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
        </SheetBody>
        <SheetFooter>
          {saved ? (
            <Button appearance="subtle" onClick={() => void save(null)} disabled={saving}>
              <Icon icon={Delete} /> Remove registry
            </Button>
          ) : null}
          <span className="min-w-0 flex-1" />
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => void runTest()} loading={testing}>
            <Icon icon={PlugConnected} /> Test
          </Button>
          <Button appearance="primary" type="submit" form="registry-form" loading={saving}>
            <Icon icon={Save} /> Save registry
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
