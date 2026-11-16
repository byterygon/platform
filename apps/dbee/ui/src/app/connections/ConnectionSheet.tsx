// New and edit connection (DBee spec §3.3): a Sheet with a TanStack Form in the spec's tab order.
// There is no "Test connection": nothing may connect before a grant exists. Submit calls
// connections.prepare and hands the preview to the approval dialog; name, description and colour
// save in place; a grant-covered change goes through prepare and approval again with `replaces`.
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldItem, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { PasswordInput } from "@/components/ui/password-input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Sheet, SheetBody, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { DatePicker } from "@/components/ui/date-picker";
import { TimePicker } from "@/components/ui/time-picker";
import type { ConnectionDraft, ConnectionSummary, GrantPreview, TlsDraft } from "@/gen/api";
import { useClient } from "../client";
import { describeError } from "../messages";

export const COLOURS = ["#2563eb", "#0d9488", "#16a34a", "#ca8a04", "#ea580c", "#dc2626", "#9333ea", "#64748b"] as const;

export interface ConnectionFormValues {
  name: string;
  description: string;
  host: string;
  port: number | null;
  database: string;
  user: string;
  password: string;
  tlsKind: TlsDraft["kind"];
  caPem: string;
  fingerprint: string;
  serverName: string;
  allowedAddresses: string;
  allowCancelConnection: boolean;
  expires: boolean;
  expiresDate: Date | null;
  expiresTime: string | null;
  colour: string;
}

export const defaultValues: ConnectionFormValues = {
  name: "",
  description: "",
  host: "",
  port: 5432,
  database: "",
  user: "",
  password: "",
  tlsKind: "deployment-ca",
  caPem: "",
  fingerprint: "",
  serverName: "",
  allowedAddresses: "",
  allowCancelConnection: true,
  expires: false,
  expiresDate: null,
  expiresTime: null,
  colour: "",
};

export function valuesOf(c: ConnectionSummary): ConnectionFormValues {
  const expiresAt = c.grant.expiresAt;
  const d = expiresAt === null ? null : new Date(expiresAt);
  return {
    ...defaultValues,
    name: c.name,
    description: c.description ?? "",
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    tlsKind: c.tls,
    allowCancelConnection: c.allowCancelConnection,
    expires: expiresAt !== null,
    expiresDate: d,
    expiresTime: d ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : null,
    colour: c.colour ?? "",
  };
}

const required = (label: string) => ({ value }: { value: string }) => (value.trim() === "" ? `${label} is required.` : undefined);

/** The TLS part of the draft from the form values. */
export function tlsDraft(v: ConnectionFormValues): TlsDraft {
  const serverName = v.serverName.trim() === "" ? null : v.serverName.trim();
  switch (v.tlsKind) {
    case "deployment-ca":
      return { kind: "deployment-ca", serverName };
    case "pinned-ca":
      return { kind: "pinned-ca", caPem: v.caPem, serverName };
    case "pinned-cert":
      return { kind: "pinned-cert", fingerprint: v.fingerprint.trim(), serverName };
    case "plaintext":
      return { kind: "plaintext" };
  }
}

export function expiresAtOf(v: ConnectionFormValues): number | null {
  if (!v.expires || v.expiresDate === null) return null;
  const d = new Date(v.expiresDate);
  const [h, m] = (v.expiresTime ?? "00:00").split(":").map(Number);
  d.setHours(h ?? 0, m ?? 0, 0, 0);
  return d.getTime();
}

/** What connections.prepare and connections.create receive. */
export function draftOf(v: ConnectionFormValues, hasSecret: boolean, widened: string[] | null): ConnectionDraft {
  return {
    name: v.name.trim(),
    description: v.description.trim() === "" ? null : v.description.trim(),
    colour: v.colour === "" ? null : v.colour,
    host: v.host.trim(),
    port: v.port ?? 5432,
    database: v.database.trim(),
    user: v.user.trim(),
    tls: tlsDraft(v),
    allowedAddresses: widened,
    allowCancelConnection: v.allowCancelConnection,
    expiresAt: expiresAtOf(v),
    hasSecret,
  };
}

/** Whether a field the grant covers changed (spec §3.3: those need a new approval). */
export function grantCoveredChange(before: ConnectionSummary, v: ConnectionFormValues): boolean {
  return (
    before.host !== v.host.trim() ||
    before.port !== (v.port ?? 5432) ||
    before.database !== v.database.trim() ||
    before.user !== v.user.trim() ||
    before.tls !== v.tlsKind ||
    v.tlsKind === "pinned-ca" ||
    v.tlsKind === "pinned-cert" ||
    before.allowCancelConnection !== v.allowCancelConnection ||
    before.grant.expiresAt !== expiresAtOf(v) ||
    v.allowedAddresses.trim() !== ""
  );
}

export interface ConnectionSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The connection being edited, if any. */
  editing?: ConnectionSummary | undefined;
  existingNames: readonly string[];
  /** The preview is ready: show the approval dialog. */
  onPreview: (preview: GrantPreview, draft: ConnectionDraft, password: string | null, replaces: string | null) => void;
  /** Name, description or colour saved in place. */
  onUpdated: (connection: ConnectionSummary) => void;
}

export function ConnectionSheet({ open, onOpenChange, editing, existingNames, onPreview, onUpdated }: ConnectionSheetProps) {
  const client = useClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm({
    defaultValues: editing ? valuesOf(editing) : defaultValues,
    onSubmit: async ({ value }) => {
      setBusy(true);
      setError(null);
      try {
        if (editing && !grantCoveredChange(editing, value)) {
          const updated = await client.connections.update({
            id: editing.id,
            name: value.name.trim(),
            description: value.description.trim(),
            colour: value.colour,
          });
          onUpdated(updated);
          onOpenChange(false);
          return;
        }
        const widened = value.allowedAddresses
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const hasSecret = value.password !== "" || (editing?.hasSecret ?? false);
        const draft = draftOf(value, hasSecret, widened.length ? widened : null);
        const preview = await client.connections.prepare(draft);
        onPreview(preview, draft, value.password === "" ? null : value.password, editing?.id ?? null);
      } catch (e) {
        const d = describeError(e, "approve");
        setError(d.description ? `${d.title}. ${d.description}` : d.title);
      } finally {
        setBusy(false);
      }
    },
  });
  const title = editing ? `Edit ${editing.name}` : "New connection";
  return (
    <Sheet open={open} onOpenChange={onOpenChange} side="right" size="lg">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {editing ? "Name, description and colour save directly; any other change asks for a new approval." : "Creating a connection is the grant: the next step shows exactly what will be allowed."}
          </SheetDescription>
        </SheetHeader>
        <Form form={form} aria-label={title} className="contents">
          <SheetBody className="flex flex-col gap-stack-md">
            <form.Field
              name="name"
              validators={{
                onBlur: ({ value }) => {
                  if (value.trim() === "") return "Name is required.";
                  if (existingNames.some((n) => n === value.trim() && n !== editing?.name)) return "A connection with this name exists.";
                  return undefined;
                },
              }}
            >
              {(field) => (
                <Field field={field}>
                  <FieldLabel>Name</FieldLabel>
                  <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} autoFocus />
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <form.Field name="description">
              {(field) => (
                <Field field={field}>
                  <FieldLabel>Description</FieldLabel>
                  <Textarea rows={1} value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} />
                </Field>
              )}
            </form.Field>
            <div className="grid grid-cols-[1fr_auto] gap-gap-md">
              <form.Field name="host" validators={{ onBlur: ({ value }) => (value.trim() === "" ? "Host is required." : /\s|\//.test(value.trim()) ? "A host name or IP literal, nothing else." : undefined) }}>
                {(field) => (
                  <Field field={field}>
                    <FieldLabel>Host</FieldLabel>
                    <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} placeholder="db.example.internal" />
                    <FieldDescription>Matched exactly in the grant; resolved when you submit.</FieldDescription>
                    <FieldError />
                  </Field>
                )}
              </form.Field>
              <form.Field name="port" validators={{ onBlur: ({ value }) => (value === null || value < 1 || value > 65535 ? "A port between 1 and 65535." : undefined) }}>
                {(field) => (
                  <Field field={field} className="w-[9ch]">
                    <FieldLabel>Port</FieldLabel>
                    <NumberInput value={field.state.value} onValueChange={(v) => field.handleChange(v)} onBlur={field.handleBlur} min={1} max={65535} />
                    <FieldError />
                  </Field>
                )}
              </form.Field>
            </div>
            <form.Field name="database" validators={{ onBlur: required("Database") }}>
              {(field) => (
                <Field field={field}>
                  <FieldLabel>Database</FieldLabel>
                  <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} />
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <form.Field name="user" validators={{ onBlur: required("User") }}>
              {(field) => (
                <Field field={field}>
                  <FieldLabel>User</FieldLabel>
                  <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} autoComplete="username" />
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <form.Field name="password">
              {(field) => (
                <Field field={field}>
                  <FieldLabel>Password</FieldLabel>
                  <PasswordInput value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} autoComplete="new-password" placeholder={editing ? (editing.hasSecret ? "Set" : "Not set") : undefined} />
                  <FieldDescription>{editing ? (editing.hasSecret ? "A password is stored. Type a new one to replace it." : "No password is stored. Optional: trust authentication exists.") : "Optional (trust authentication exists). Stored in the OS keychain, never shown again."}</FieldDescription>
                </Field>
              )}
            </form.Field>
            <form.Field name="tlsKind">
              {(field) => (
                <Field field={field}>
                  <RadioGroup value={field.state.value} onValueChange={(v) => field.handleChange(v as TlsDraft["kind"])} onBlur={field.handleBlur}>
                    <FieldLegend>TLS</FieldLegend>
                    <FieldItem>
                      <FieldLabel>
                        <RadioGroupItem value="deployment-ca" /> Required, deployment CAs
                      </FieldLabel>
                      <FieldDescription>Verified against the CA bundle the deployment provides.</FieldDescription>
                    </FieldItem>
                    <FieldItem>
                      <FieldLabel>
                        <RadioGroupItem value="pinned-ca" /> Required, pinned CA file
                      </FieldLabel>
                    </FieldItem>
                    <FieldItem>
                      <FieldLabel>
                        <RadioGroupItem value="pinned-cert" /> Required, pinned server certificate
                      </FieldLabel>
                      <FieldDescription>The SHA-256 fingerprint your DBA gives you. Nothing connects to fetch it.</FieldDescription>
                    </FieldItem>
                    <FieldItem>
                      <FieldLabel>
                        <RadioGroupItem value="plaintext" /> Plaintext
                      </FieldLabel>
                    </FieldItem>
                  </RadioGroup>
                </Field>
              )}
            </form.Field>
            <form.Subscribe selector={(s) => s.values.tlsKind}>
              {(tlsKind) => (
                <>
                  {tlsKind === "pinned-ca" ? (
                    <form.Field name="caPem" validators={{ onBlur: ({ value }) => (value.includes("-----BEGIN CERTIFICATE-----") ? undefined : "A PEM file with at least one CERTIFICATE block.") }}>
                      {(field) => (
                        <Field field={field}>
                          <FieldLabel>CA certificate (PEM)</FieldLabel>
                          <FileInput
                            accept=".pem,.crt,.cer"
                            onFilesChange={(files) => {
                              const file = files[0];
                              if (!file) return field.handleChange("");
                              void file.text().then((text) => {
                                field.handleChange(text);
                                field.handleBlur();
                              });
                            }}
                          />
                          <FieldDescription>{field.state.value ? "Loaded; the digest is shown at approval." : "The file never leaves this computer."}</FieldDescription>
                          <FieldError />
                        </Field>
                      )}
                    </form.Field>
                  ) : null}
                  {tlsKind === "pinned-cert" ? (
                    <form.Field name="fingerprint" validators={{ onBlur: ({ value }) => (/^(sha256:)?([0-9a-f]{2}:?){32}$/i.test(value.trim()) ? undefined : "sha256:<64 hex digits>, with or without colons.") }}>
                      {(field) => (
                        <Field field={field}>
                          <FieldLabel>Server certificate fingerprint</FieldLabel>
                          <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} placeholder="sha256:…" className="font-mono" />
                          <FieldError />
                        </Field>
                      )}
                    </form.Field>
                  ) : null}
                  {tlsKind !== "plaintext" ? (
                    <form.Field name="serverName">
                      {(field) => (
                        <Field field={field}>
                          <FieldLabel>Server name (optional)</FieldLabel>
                          <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} placeholder="defaults to the host" />
                        </Field>
                      )}
                    </form.Field>
                  ) : (
                    <Alert variant="warning">
                      <AlertTitle>Plaintext</AlertTitle>
                      <AlertDescription>The password and data travel unencrypted. Allowed only because the PostgreSQL driver's template permits it; the approval button will say so.</AlertDescription>
                    </Alert>
                  )}
                </>
              )}
            </form.Subscribe>
            <form.Field name="allowedAddresses" validators={{ onBlur: ({ value }) => (value.trim() === "" || value.split(/[\s,]+/).filter(Boolean).every((c) => /^[0-9a-f.:]+\/\d{1,3}$/i.test(c)) ? undefined : "CIDR networks, e.g. 10.0.0.0/8, separated by spaces.") }}>
              {(field) => (
                <Field field={field}>
                  <FieldLabel>Allowed addresses</FieldLabel>
                  <Textarea rows={1} value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} placeholder="Proposed from the host at approval" className="font-mono" />
                  <FieldDescription>Leave empty to allow exactly the addresses the host resolves to now; add CIDRs to widen it.</FieldDescription>
                  <FieldError />
                </Field>
              )}
            </form.Field>
            <form.Field name="allowCancelConnection">
              {(field) => (
                <Field field={field}>
                  <FieldLabel>
                    <Switch checked={field.state.value} onCheckedChange={(v) => field.handleChange(v)} onBlur={field.handleBlur} /> Allow cancel connection
                  </FieldLabel>
                  <FieldDescription>PostgreSQL's out-of-band cancel needs it; off means Cancel waits for the statement.</FieldDescription>
                </Field>
              )}
            </form.Field>
            <FieldSet>
              <FieldLegend>Access expires</FieldLegend>
              <form.Field name="expires">
                {(field) => (
                  <Field field={field}>
                    <FieldLabel>
                      <Switch checked={field.state.value} onCheckedChange={(v) => field.handleChange(v)} onBlur={field.handleBlur} /> Expire access
                    </FieldLabel>
                    <FieldDescription>Off by default for personal connections.</FieldDescription>
                  </Field>
                )}
              </form.Field>
              <form.Subscribe selector={(s) => s.values.expires}>
                {(expires) =>
                  expires ? (
                    <div className="grid grid-cols-2 gap-gap-md">
                      <form.Field name="expiresDate" validators={{ onBlur: ({ value }) => (value === null ? "Choose a date." : undefined) }}>
                        {(field) => (
                          <Field field={field}>
                            <FieldLabel>Date</FieldLabel>
                            <DatePicker value={field.state.value} onValueChange={(v) => field.handleChange(v as Date | null)} min={new Date()} />
                            <FieldError />
                          </Field>
                        )}
                      </form.Field>
                      <form.Field name="expiresTime">
                        {(field) => (
                          <Field field={field}>
                            <FieldLabel>Time</FieldLabel>
                            <TimePicker value={field.state.value} onValueChange={field.handleChange} />
                          </Field>
                        )}
                      </form.Field>
                    </div>
                  ) : null
                }
              </form.Subscribe>
            </FieldSet>
            <form.Field name="colour">
              {(field) => (
                <Field field={field}>
                  <RadioGroup value={field.state.value} onValueChange={(v) => field.handleChange(v)} className="flex flex-row flex-wrap gap-inline-sm">
                    <FieldLegend>Colour</FieldLegend>
                    <FieldItem>
                      <FieldLabel>
                        <RadioGroupItem value="" /> None
                      </FieldLabel>
                    </FieldItem>
                    {COLOURS.map((c) => (
                      <FieldItem key={c}>
                        <FieldLabel>
                          <RadioGroupItem value={c} /> <span aria-hidden className="inline-block size-icon-sm rounded-full" style={{ background: c }} /> <span className="sr-only">{c}</span>
                        </FieldLabel>
                      </FieldItem>
                    ))}
                  </RadioGroup>
                </Field>
              )}
            </form.Field>
            {error ? (
              <Alert variant="danger">
                <AlertTitle>Could not prepare the connection</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </SheetBody>
          <SheetFooter>
            <SheetClose render={<Button variant="ghost" />}>Cancel</SheetClose>
            <Button type="submit" loading={busy}>
              {editing ? "Save" : "Continue to approval"}
            </Button>
          </SheetFooter>
        </Form>
      </SheetContent>
    </Sheet>
  );
}
