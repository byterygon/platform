// Profile dialogs (Mightyconsole spec §4): add, edit and duplicate in a Sheet with the tool's
// connection form; delete; export with "Include secrets" off by default; import with a choice per
// conflicting profile (Replace, Keep both, Skip); the confirmation for closing a busy tab.
import { useContext, useEffect, useMemo, useState } from "react";
import { ServicesContext } from "@/app/client";
import { useSheetGuard } from "@/app/leave-guard";
import { SecretsProvider, useSecretsState, useShownSecrets, whenText, whoText } from "@/app/secret-control";
import { audienceText } from "@/app/sharing";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { FileInput } from "@/components/ui/file-input";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { RecordState } from "@/profiles/migrate";
import { type ProfileRecord, ulid } from "@/profiles/record";
import { testProfile } from "@/profiles/server";
import { secretsLostByTarget } from "@/profiles/targets";
import { type ImportChoice, type ImportPlan, ImportError } from "@/profiles/transfer";
import type { DescribedError, FieldErrors, ToolModule } from "@/tools/types";
import { describeError } from "@/app/messages";
import { ErrorState } from "@/app/states";
import { Icon } from "@/components/ui/icon";
import { PlugConnected } from "@/lib/icons";
import { HostKeyDialog } from "./HostKeyDialog";

/** Label colours: the eight categorical colour roles of the tokens (spec §4.2), so every theme has them. */
export const PROFILE_COLORS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6", "chart-7", "chart-8"] as const;

/** The text class of a label colour (spelled out so Tailwind sees every class). */
export const COLOR_CLASS: Record<string, string> = {
  "chart-1": "text-chart-1",
  "chart-2": "text-chart-2",
  "chart-3": "text-chart-3",
  "chart-4": "text-chart-4",
  "chart-5": "text-chart-5",
  "chart-6": "text-chart-6",
  "chart-7": "text-chart-7",
  "chart-8": "text-chart-8",
};

export interface ProfileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tool: ToolModule;
  /** The record being edited or duplicated; a new profile without it. */
  base?: ProfileRecord;
  mode: "add" | "edit" | "duplicate";
  /** Names already used by this tool's other profiles. */
  takenNames: ReadonlySet<string>;
  /** The base record's load state; `newer` makes the sheet read-only. */
  recordState?: RecordState;
  /** Saves the form's record (its `secrets`: what was typed), removing the stored secrets named
   * in `remove`; `shared` makes a new profile the tenant's. */
  onSave: (record: ProfileRecord, options: { remove: string[]; shared: boolean }) => Promise<void>;
  /** A new profile's name, filled in (a link's missing profile). */
  name?: string;
  /** The signed-in person's id, so "Set by you" can be said. */
  self?: string;
  /** Whether the person may share a new profile (`profiles.manage`); the option is not shown otherwise. */
  canShare?: boolean;
  /** How many people a shared profile of this tool reaches today, when known. */
  audience?: number | null;
}

/** The result of "Test connection". */
type TestState = { status: "idle" } | { status: "running" } | { status: "ok" } | { status: "failed"; error: DescribedError };

export function ProfileSheet({ open, onOpenChange, tool, base, mode, takenNames, recordState, onSave, name = "", self, canShare = false, audience = null }: ProfileSheetProps) {
  const services = useContext(ServicesContext);
  // "Test connection" runs the tool's connect on the draft and disconnects.
  const client = services?.client;
  const fresh = () => {
    const defaults = tool.profile.defaults();
    if (!base) return { name, color: "", fields: defaults.fields, secrets: {} as Record<string, unknown>, extras: defaults.extras };
    return { name: mode === "duplicate" ? `${base.name} copy` : base.name, color: base.color ?? "", fields: structuredClone(base.fields), secrets: {} as Record<string, unknown>, extras: structuredClone(base.extras) };
  };
  const [draft, setDraft] = useState(fresh);
  const releaseGuard = useSheetGuard(open, draft);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [shared, setShared] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [trusting, setTrusting] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(fresh());
      setErrors({});
      setRemoved(new Set());
      setShared(false);
      setTest({ status: "idle" });
      setTrusting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, base?.id, mode, name]);
  const readOnly = recordState?.kind === "newer";
  // The secrets the server holds (never their values), less those the person removes.
  const stored = useMemo(() => new Set(base && mode !== "add" ? (base.storedSecrets ?? []).filter((k) => !removed.has(k)) : []), [base, mode, removed]);
  // A changed target takes the secrets sent to it unless they are entered again (DOC-25 §3.4.8): said before the save.
  const typedKeys = useMemo(() => new Set(Object.entries(draft.secrets).filter(([, v]) => typeof v === "string" && v !== "").map(([k]) => k)), [draft.secrets]);
  const lost = useMemo(
    () => new Set(base && mode === "edit" ? secretsLostByTarget(tool.id, base.fields, draft.fields, stored, typedKeys) : []),
    [base, mode, tool.id, draft.fields, stored, typedKeys],
  );
  const { keys: shownKeys, shown } = useShownSecrets();
  const secretsState = useSecretsState({
    stored,
    info: base?.secretInfo ?? {},
    removed,
    ...(self ? { self } : {}),
    lost,
    shown,
    remove: (key) => setRemoved((r) => new Set([...r, key])),
    keep: (key) => setRemoved((r) => new Set([...r].filter((k) => k !== key))),
  });
  const hidden = (base && mode === "edit" ? (base.storedSecrets ?? []) : []).filter((k) => !shownKeys.has(k));

  const build = (): ProfileRecord => {
    const now = new Date().toISOString();
    const typed = Object.fromEntries(Object.entries(draft.secrets).filter(([, v]) => v !== "" && v !== undefined));
    return {
      id: mode === "edit" && base ? base.id : ulid(),
      tool: tool.id,
      version: tool.profile.version,
      name: draft.name.trim(),
      ...(draft.color ? { color: draft.color } : {}),
      createdAt: mode === "edit" && base ? base.createdAt : now,
      updatedAt: now,
      fields: draft.fields,
      secrets: typed,
      extras: draft.extras,
      storedSecrets: [...stored],
      ...(base?.etag && mode === "edit" ? { etag: base.etag } : {}),
    };
  };

  const save = async () => {
    const record = build();
    const next: FieldErrors = { ...tool.profile.validate(record) };
    if (record.name === "") next["name"] = "A name is required.";
    else if (takenNames.has(record.name)) next["name"] = `Another ${tool.label} profile is called ${record.name}.`;
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setSaving(true);
    try {
      await onSave(record, { remove: [...removed], shared });
      releaseGuard();
    } finally {
      setSaving(false);
    }
  };

  /** Checks the fields, then connects with the draft and disconnects at once. */
  const runTest = async (record = build()) => {
    if (!client) return;
    const next: FieldErrors = { ...tool.profile.validate(record) };
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setTest({ status: "running" });
    try {
      await testProfile(client, record, base && mode !== "add" ? base.id : undefined);
      setTest({ status: "ok" });
    } catch (e) {
      const error = describeError(e);
      setTest({ status: "failed", error });
      if (error.hostKey && tool.trustHostKey) setTrusting(true);
    }
  };
  const failedKey = test.status === "failed" ? test.error.hostKey : undefined;

  const title = mode === "add" ? `Add ${tool.label} connection` : mode === "duplicate" ? `Duplicate ${base?.name ?? ""}` : `Edit ${base?.name ?? ""}`;
  const sharedProfile = mode === "edit" && base?.owner?.kind === "shared";
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="md">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>
            {title}
            {sharedProfile ? (
              <Badge variant="neutral" className="ms-inline-sm align-middle">
                shared
              </Badge>
            ) : null}
          </SheetTitle>
          <SheetDescription>Profiles are kept on the server. Secrets are write-only: the server stores them encrypted and never shows them again; type a new value to replace one.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="profile-form"
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {readOnly ? (
              <Alert intent="warning">
                <AlertTitle>Made by a newer version</AlertTitle>
                <AlertDescription>This profile has version {recordState.kind === "newer" ? recordState.version : ""}; this Mightyconsole reads it but cannot change it.</AlertDescription>
              </Alert>
            ) : null}
            <Field invalid={errors["name"] !== undefined}>
              <FieldLabel>Name</FieldLabel>
              <Input value={draft.name} onValueChange={(name) => setDraft((d) => ({ ...d, name }))} disabled={readOnly} required />
              {errors["name"] ? <FieldError match>{errors["name"]}</FieldError> : null}
            </Field>
            <Field>
              <FieldLabel>Label colour</FieldLabel>
              <Select aria-label="Label colour" value={draft.color || "none"} onValueChange={(v) => setDraft((d) => ({ ...d, color: v === "none" ? "" : String(v) }))} disabled={readOnly}>
                <SelectItem value="none">None</SelectItem>
                {PROFILE_COLORS.map((c) => (
                  <SelectItem key={c} value={c}>
                    <span className="flex items-center gap-inline-xs"><span aria-hidden="true" className={`${COLOR_CLASS[c]} text-body-1`}>●</span>Colour {c.slice(6)}</span>
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <SecretsProvider value={secretsState}>
            <tool.ConnectionForm
              fields={draft.fields}
              secrets={draft.secrets}
              storedSecrets={stored}
              errors={errors}
              disabled={readOnly}
              {...(mode === "edit" && base ? { profileId: base.id } : {})}
              {...(services ? { client: services.client } : {})}
              draft={build}
              onFields={(patch) => setDraft((d) => ({ ...d, fields: { ...d.fields, ...patch } }))}
              onSecrets={(patch) => setDraft((d) => ({ ...d, secrets: { ...d.secrets, ...patch } }))}
            />
            </SecretsProvider>
            {lost.size > 0 ? (
              <Alert intent="warning" data-testid="secrets-lost">
                <AlertTitle>Saving removes the stored {[...lost].join(", ")}</AlertTitle>
                <AlertDescription>You changed where this profile connects. A stored secret is only ever sent to the target it was entered for, so it goes unless you enter it again before saving.</AlertDescription>
              </Alert>
            ) : null}
            {hidden.length > 0 ? (
              <Field>
                <FieldLabel>Other stored secrets</FieldLabel>
                <FieldDescription>Set on the server for a setting this form does not show now; their values are never shown. Remove one to stop sending it.</FieldDescription>
                <ul className="flex flex-col gap-stack-xs">
                  {hidden.map((key) => (
                    <li key={key} className="flex items-center gap-inline-sm" data-secret-other={key}>
                      <span className="text-body-1">{key}</span>
                      <span className="text-caption-1 text-fg-muted">
                        {removed.has(key) ? "removed on save" : base?.secretInfo?.[key] ? `set by ${whoText(base.secretInfo[key]!.setBy, self)} on ${whenText(base.secretInfo[key]!.setAt)}` : "set"}
                      </span>
                      <Button size="small" className="ms-auto" disabled={readOnly} onClick={() => setRemoved((r) => (r.has(key) ? new Set([...r].filter((k) => k !== key)) : new Set([...r, key])))}>
                        {removed.has(key) ? "Keep" : "Remove"}
                      </Button>
                    </li>
                  ))}
                </ul>
              </Field>
            ) : null}
            {mode === "add" && canShare ? (
              <fieldset className="flex flex-col gap-stack-sm" data-testid="who-can-use">
                <legend className="text-body-1-strong">Who can use it</legend>
                <RadioGroup aria-label="Who can use it" value={shared ? "shared" : "personal"} onValueChange={(v) => setShared(v === "shared")} disabled={readOnly}>
                  <label className="flex items-start gap-inline-sm">
                    <RadioGroupItem value="personal" />
                    <span className="flex flex-col">
                      <span className="text-body-1">Only me (personal)</span>
                      <span className="text-caption-1 text-fg-muted">Nobody else sees it or connects with it. Administrators see its name and where it connects.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-inline-sm">
                    <RadioGroupItem value="shared" />
                    <span className="flex flex-col">
                      <span className="text-body-1">Everyone whose role covers it (shared)</span>
                      <span className="text-caption-1 text-fg-muted" data-testid="audience">
                        {audienceText(audience, draft.name)}
                      </span>
                    </span>
                  </label>
                </RadioGroup>
                <Alert intent="info">
                  <AlertTitle>Personal or shared is chosen once</AlertTitle>
                  <AlertDescription>A personal profile cannot be turned into a shared one later; an administrator can hand a personal one to another person.</AlertDescription>
                </Alert>
              </fieldset>
            ) : null}
            {test.status === "ok" ? (
              <Alert intent="success">
                <AlertTitle>The connection works</AlertTitle>
                <AlertDescription>Connected to {draft.name.trim() || "the target"} and disconnected again.</AlertDescription>
              </Alert>
            ) : test.status === "failed" ? (
              <ErrorState error={test.error} {...(failedKey && tool.trustHostKey ? { onTrust: () => setTrusting(true) } : {})} />
            ) : null}
          </form>
        </SheetBody>
        <HostKeyDialog
          open={trusting && failedKey !== undefined}
          name={draft.name.trim() || tool.label}
          target={tool.targetOf?.(build()) ?? draft.name}
          details={failedKey ?? null}
          onCancel={() => setTrusting(false)}
          onTrust={(key) => {
            setTrusting(false);
            if (!tool.trustHostKey || !client) return;
            const record = build();
            void tool
              .trustHostKey(client, record, key)
              .then(() => runTest(record))
              .catch((e: unknown) => setTest({ status: "failed", error: describeError(e) }));
          }}
        />
        <SheetFooter>
          {client ? (
            <Button className="me-auto" loading={test.status === "running"} disabled={readOnly} onClick={() => void runTest()}>
              <Icon icon={PlugConnected} /> Test connection
            </Button>
          ) : null}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button appearance="primary" loading={saving} disabled={readOnly} onClick={() => void save()}>
            Save
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function DeleteProfileDialog({ name, open, onCancel, onDelete }: { name: string; open: boolean; onCancel: () => void; onDelete: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>The profile and its secrets are removed from this browser; its tabs close. Export it first to keep a copy.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction appearance="danger" onClick={onDelete}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function CloseTabDialog({ title, open, onCancel, onClose }: { title: string; open: boolean; onCancel: () => void; onClose: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Close {title}?</AlertDialogTitle>
          <AlertDialogDescription>Its live stream stops and what it shows is lost.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction appearance="primary" onClick={onClose}>
            Close tab
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Leaving a tab whose sheet has changes that are not saved (DOC-21 §3.7, TSK-105). */
export function DiscardChangesDialog({ open, onKeep, onDiscard }: { open: boolean; onKeep: () => void; onDiscard: () => void }) {
  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onKeep()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard changes?</AlertDialogTitle>
          <AlertDialogDescription>A sheet in this tab has changes that are not saved. Leaving drops them.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Keep editing</AlertDialogCancel>
          <AlertDialogAction appearance="danger" onClick={onDiscard}>
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** `withSecrets`: the records hold secret values (the browser's own, before they move to the server). */
export function ExportDialog({ open, onOpenChange, count, onExport, withSecrets = false }: { open: boolean; onOpenChange: (open: boolean) => void; count: number; onExport: (includeSecrets: boolean) => void; withSecrets?: boolean }) {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  useEffect(() => {
    if (open) setIncludeSecrets(false);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export {count === 1 ? "1 profile" : `${count} profiles`}</DialogTitle>
          <DialogDescription>Writes a JSON file another server can import. Secrets stay on this server: they are write-only and never in an export.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          {withSecrets ? (
            <Field orientation="horizontal">
              <Checkbox checked={includeSecrets} onCheckedChange={(v) => setIncludeSecrets(v === true)} />
              <FieldLabel>Include secrets (passwords, keys, tokens, kubeconfigs)</FieldLabel>
            </Field>
          ) : null}
          {includeSecrets ? (
            <Alert intent="warning">
              <AlertTitle>The file will hold your secrets in plain text</AlertTitle>
              <AlertDescription>Anyone who reads the file can use these connections. Keep it as safe as the systems it opens.</AlertDescription>
            </Alert>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button />}>Cancel</DialogClose>
          <Button appearance="primary" onClick={() => onExport(includeSecrets)}>
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const CHOICES: { value: ImportChoice; label: string }[] = [
  { value: "replace", label: "Replace" },
  { value: "keepBoth", label: "Keep both" },
  { value: "skip", label: "Skip" },
];

export interface ImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Plans the import of a file's text; throws ImportError when it is not an export. */
  plan: (text: string) => ImportPlan;
  onImport: (plan: ImportPlan) => Promise<void>;
  toolLabel: (id: string) => string;
}

export function ImportDialog({ open, onOpenChange, plan: makePlan, onImport, toolLabel }: ImportDialogProps) {
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setPlan(null);
      setError(null);
    }
  }, [open]);
  const read = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    try {
      setPlan(makePlan(await file.text()));
      setError(null);
    } catch (e) {
      setPlan(null);
      setError(e instanceof ImportError ? e.message : "The file could not be read.");
    }
  };
  const choose = (index: number, choice: ImportChoice) => setPlan((p) => (p ? { ...p, rows: p.rows.map((r, i) => (i === index ? { ...r, choice } : r)) } : p));
  const importable = plan?.rows.filter((r) => r.skipReason === null && r.choice !== "skip").length ?? 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Import profiles</DialogTitle>
          <DialogDescription>Nothing is written until you press Import.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          <Field>
            <FieldLabel>Profiles file</FieldLabel>
            <FileInput accept=".json,application/json" onFilesChange={(files) => void read(files)} />
            <FieldDescription>A file exported by Mightyconsole (mightyconsole-profiles-….json). You can also drop it here.</FieldDescription>
          </Field>
          {error ? (
            <Alert intent="danger">
              <AlertTitle>Cannot import this file</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {plan ? (
            <>
              <p className="text-body-1 text-fg-muted">{plan.includesSecrets ? "The file includes secrets." : "The file has no secrets; replaced profiles keep the ones stored here."}</p>
              <Table aria-label="Profiles in the file">
                <TableHeader>
                  <TableRow>
                    <TableHead>Profile</TableHead>
                    <TableHead>Tool</TableHead>
                    <TableHead>What happens</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plan.rows.map((row, i) => (
                    <TableRow key={`${row.record.id}-${i}`}>
                      <TableCell>{row.record.name}</TableCell>
                      <TableCell>{row.record.tool ? toolLabel(row.record.tool) : "—"}</TableCell>
                      <TableCell wrap>
                        {row.skipReason !== null ? (
                          <span className="text-fg-muted">Skipped: {row.skipReason}</span>
                        ) : row.conflict === null ? (
                          "New"
                        ) : (
                          <RadioGroup aria-label={`${row.record.name}: ${row.conflict.name} already exists`} value={row.choice} onValueChange={(v) => choose(i, v as ImportChoice)} className="flex-row gap-inline-md">
                            {CHOICES.map((c) => (
                              <label key={c.value} className="flex items-center gap-inline-xs text-body-1">
                                <RadioGroupItem value={c.value} />
                                {c.label}
                              </label>
                            ))}
                          </RadioGroup>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button />}>Cancel</DialogClose>
          <Button
            appearance="primary"
            disabled={importable === 0}
            loading={busy}
            onClick={() => {
              if (!plan) return;
              setBusy(true);
              void onImport(plan).finally(() => setBusy(false));
            }}
          >
            Import {importable > 0 ? importable : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
