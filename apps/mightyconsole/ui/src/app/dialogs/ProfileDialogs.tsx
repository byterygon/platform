// Profile dialogs (Mightyconsole spec §4): add, edit and duplicate in a Sheet with the tool's
// connection form; delete; export with "Include secrets" off by default; import with a choice per
// conflicting profile (Replace, Keep both, Skip); the confirmation for closing a busy tab.
import { useEffect, useMemo, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import { type ProfileRecord, hasSecrets, ulid } from "@/profiles/record";
import { type ImportChoice, type ImportPlan, ImportError } from "@/profiles/transfer";
import type { FieldErrors, ToolModule } from "@/tools/types";

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
  onSave: (record: ProfileRecord) => Promise<void>;
}

export function ProfileSheet({ open, onOpenChange, tool, base, mode, takenNames, recordState, onSave }: ProfileSheetProps) {
  const fresh = () => {
    const defaults = tool.profile.defaults();
    if (!base) return { name: "", color: "", fields: defaults.fields, secrets: {} as Record<string, unknown>, extras: defaults.extras };
    return { name: mode === "duplicate" ? `${base.name} copy` : base.name, color: base.color ?? "", fields: structuredClone(base.fields), secrets: {} as Record<string, unknown>, extras: structuredClone(base.extras) };
  };
  const [draft, setDraft] = useState(fresh);
  const [clearSecrets, setClearSecrets] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(fresh());
      setErrors({});
      setClearSecrets(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, base?.id, mode]);
  const readOnly = recordState?.kind === "newer";
  const stored = useMemo(() => new Set(base && mode !== "add" && !clearSecrets ? Object.keys(base.secrets).filter((k) => base.secrets[k] !== "" && base.secrets[k] != null) : []), [base, mode, clearSecrets]);

  const build = (): ProfileRecord => {
    const now = new Date().toISOString();
    const typed = Object.fromEntries(Object.entries(draft.secrets).filter(([, v]) => v !== "" && v !== undefined));
    const keptSecrets = base && !clearSecrets && mode !== "add" ? base.secrets : {};
    return {
      id: mode === "edit" && base ? base.id : ulid(),
      tool: tool.id,
      version: tool.profile.version,
      name: draft.name.trim(),
      ...(draft.color ? { color: draft.color } : {}),
      createdAt: mode === "edit" && base ? base.createdAt : now,
      updatedAt: now,
      fields: draft.fields,
      secrets: { ...keptSecrets, ...typed },
      extras: draft.extras,
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
      await onSave(record);
    } finally {
      setSaving(false);
    }
  };

  const title = mode === "add" ? `Add ${tool.label} connection` : mode === "duplicate" ? `Duplicate ${base?.name ?? ""}` : `Edit ${base?.name ?? ""}`;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="md">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>Profiles stay in this browser; secrets are stored in plain and left out of exports unless you include them.</SheetDescription>
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
            <tool.ConnectionForm
              fields={draft.fields}
              secrets={draft.secrets}
              storedSecrets={stored}
              errors={errors}
              disabled={readOnly}
              {...(mode === "edit" && base ? { profileId: base.id } : {})}
              onFields={(patch) => setDraft((d) => ({ ...d, fields: { ...d.fields, ...patch } }))}
              onSecrets={(patch) => setDraft((d) => ({ ...d, secrets: { ...d.secrets, ...patch } }))}
            />
            {base && mode !== "add" && hasSecrets(base) ? (
              <Field orientation="horizontal">
                <Checkbox checked={clearSecrets} onCheckedChange={(v) => setClearSecrets(v === true)} disabled={readOnly} />
                <FieldLabel>Remove the stored secrets</FieldLabel>
              </Field>
            ) : null}
          </form>
        </SheetBody>
        <SheetFooter>
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

export function ExportDialog({ open, onOpenChange, count, onExport }: { open: boolean; onOpenChange: (open: boolean) => void; count: number; onExport: (includeSecrets: boolean) => void }) {
  const [includeSecrets, setIncludeSecrets] = useState(false);
  useEffect(() => {
    if (open) setIncludeSecrets(false);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export {count === 1 ? "1 profile" : `${count} profiles`}</DialogTitle>
          <DialogDescription>Writes a JSON file another browser can import.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          <Field orientation="horizontal">
            <Checkbox checked={includeSecrets} onCheckedChange={(v) => setIncludeSecrets(v === true)} />
            <FieldLabel>Include secrets (passwords, keys, tokens, kubeconfigs)</FieldLabel>
          </Field>
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
