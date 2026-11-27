// "Move my profiles to the server" (TSK-135 §8, DOC-25 §3.4.9): the browser's own profiles, with the
// secrets each holds, become profiles on the server in three steps. 1 Backup: the export with
// secrets, saved or explicitly skipped. 2 Choose: which profiles move, as personal or (for people
// who may share) shared, and under which name (a name the server already has is renamed here:
// it refuses duplicates). 3 Move: one profile at a time, with Stop; a profile's secrets leave the
// browser only after the server reports them as set, and starting again resumes where it stopped.
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectItem } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowDownload, ArrowUpload, Warning } from "@/lib/icons";
import { moveNames, type MoveOptions, type MoveResult } from "@/profiles/move";
import type { ProfileRecord } from "@/profiles/record";
import { describeError } from "@/app/messages";
import { ErrorState } from "@/app/states";
import type { DescribedError } from "@/tools/types";

/** What the person chose in step 2. */
export interface MovePlan {
  only: ReadonlySet<string>;
  shared: ReadonlySet<string>;
  names: Readonly<Record<string, string>>;
}

export interface MoveRun {
  signal: AbortSignal;
  onProgress: NonNullable<MoveOptions["onProgress"]>;
}

type Step = "backup" | "choose" | "moving" | "done" | "stopped" | "failed";

const STEPS = ["Backup", "Choose", "Move"] as const;

function Steps({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-inline-lg text-body-1" aria-label="Steps">
      {STEPS.map((label, i) => (
        <li key={label} className={i === current ? "text-body-1-strong" : i < current ? "text-fg" : "text-fg-muted"} aria-current={i === current ? "step" : undefined}>
          {i + 1}. {label}
        </li>
      ))}
    </ol>
  );
}

export interface MoveDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The browser's records still to move. */
  records: readonly ProfileRecord[];
  /** The profiles the person already sees on the server (names are unique per tool). */
  existing: readonly Pick<ProfileRecord, "tool" | "name">[];
  toolLabel(id: string): string;
  /** Where a record connects, in words (the tool's own). */
  target(record: ProfileRecord): string;
  /** Whether the person may move a profile as shared (`profiles.manage`). */
  canShare: boolean;
  /** Downloads the export with secrets and returns the file's name. */
  onBackup(): string;
  /** Moves what the plan names; resolves with the outcome (also when stopped), rejects with a failure. */
  onMove(plan: MovePlan, run: MoveRun): Promise<MoveResult>;
}

export function MoveDialog({ open, onOpenChange, records, existing, toolLabel, target, canShare, onBackup, onMove }: MoveDialogProps) {
  const [step, setStep] = useState<Step>("backup");
  const [backup, setBackup] = useState<string | null>(null);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [shared, setShared] = useState<ReadonlySet<string>>(new Set());
  const [edited, setEdited] = useState<Readonly<Record<string, string>>>({});
  const [progress, setProgress] = useState<{ index: number; total: number; name: string } | null>(null);
  const [outcome, setOutcome] = useState<{ moved: number; left: number } | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const abort = useRef<AbortController | null>(null);
  /** How many profiles the browser held when the run began: the list shrinks as they move. */
  const before = useRef(0);
  const stopButton = useRef<HTMLButtonElement>(null);

  // Names settled once per opening: the server's names, then the records' own.
  const suggested = useMemo(() => moveNames(records, existing), [records, existing]);
  useEffect(() => {
    if (!open) return;
    setStep("backup");
    setBackup(null);
    setPicked(new Set(records.map((r) => r.id)));
    setShared(new Set());
    setEdited({});
    setProgress(null);
    setOutcome(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when the dialog opens, not when the records are reloaded under it
  }, [open]);
  useEffect(() => {
    if (step === "moving") stopButton.current?.focus();
  }, [step]);

  const nameOf = (r: ProfileRecord) => edited[r.id] ?? suggested[r.id]?.name ?? r.name;
  const chosen = records.filter((r) => picked.has(r.id));
  // A name is in the way when the server has it, or another chosen profile of the tool takes it.
  const problem = (r: ProfileRecord): string | null => {
    const name = nameOf(r).trim();
    if (name === "") return "A name is required.";
    const key = (tool: string, n: string) => `${tool}\u0000${n.trim().toLowerCase()}`;
    if (existing.some((p) => key(p.tool, p.name) === key(r.tool, name))) return `The server already has a ${toolLabel(r.tool)} profile called ${name}.`;
    if (chosen.some((o) => o.id !== r.id && o.tool === r.tool && key(o.tool, nameOf(o)) === key(r.tool, name))) return `Another profile of this move is called ${name}.`;
    return null;
  };
  const blocked = chosen.length === 0 || chosen.some((r) => problem(r) !== null);
  const renamed = chosen.filter((r) => nameOf(r) !== r.name);
  const secretsOf = (r: ProfileRecord) => Object.keys(r.secrets).filter((k) => typeof r.secrets[k] === "string" && r.secrets[k] !== "").length;

  const toggle = (id: string, on: boolean) => setPicked((s) => (on ? new Set([...s, id]) : new Set([...s].filter((x) => x !== id))));
  const run = async () => {
    const controller = new AbortController();
    abort.current = controller;
    before.current = records.length;
    setStep("moving");
    setProgress({ index: 0, total: chosen.length, name: chosen[0]?.name ?? "" });
    setError(null);
    const plan: MovePlan = { only: new Set(chosen.map((r) => r.id)), shared: new Set([...shared].filter((id) => picked.has(id))), names: Object.fromEntries(chosen.map((r) => [r.id, nameOf(r).trim()])) };
    try {
      const result = await onMove(plan, { signal: controller.signal, onProgress: (p) => setProgress({ index: p.index, total: p.total, name: p.record.name }) });
      const left = before.current - result.moved.length;
      setOutcome({ moved: result.moved.length, left });
      if (result.failed) {
        setError(describeError(result.failed.error));
        setStep("failed");
      } else setStep(result.stopped ? "stopped" : "done");
    } catch (e) {
      setError(describeError(e));
      setStep("failed");
    }
  };

  const moving = step === "moving";
  return (
    <Dialog open={open} onOpenChange={(next) => (moving && !next ? undefined : onOpenChange(next))} size="xl">
      <DialogContent data-testid="move-dialog">
        <DialogHeader>
          <DialogTitle>Move my profiles to the server</DialogTitle>
          <DialogDescription>
            {records.length === 1 ? "1 profile is" : `${records.length} profiles are`} kept in this browser. On the server their secrets are stored encrypted and never shown again; this browser then keeps none.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          {step === "backup" || step === "choose" || step === "moving" ? <Steps current={step === "backup" ? 0 : step === "choose" ? 1 : 2} /> : null}

          {step === "backup" ? (
            <>
              <p className="text-body-1">
                Before anything moves, save a backup of these {records.length === 1 ? "profile" : `${records.length} profiles`} with their secrets. If the move goes wrong, you can import it again.
              </p>
              <Alert intent="warning">
                <AlertTitle>The backup file holds your secrets in plain text</AlertTitle>
                <AlertDescription>Keep it somewhere only you can read, and delete it once your profiles work from the server.</AlertDescription>
              </Alert>
            </>
          ) : null}

          {step === "choose" ? (
            <>
              <p className="text-body-1 text-fg-muted">Each becomes your personal profile{canShare ? "; as an administrator you may share some instead" : ""}. Secrets travel once over TLS and are encrypted on arrival.</p>
              <Table aria-label="Profiles to move">
                <TableHeader>
                  <TableRow>
                    <TableHead>
                      <Checkbox
                        aria-label="Select all"
                        checked={picked.size === records.length && records.length > 0}
                        indeterminate={picked.size > 0 && picked.size < records.length}
                        onCheckedChange={(on) => setPicked(on === true ? new Set(records.map((r) => r.id)) : new Set())}
                      />
                    </TableHead>
                    <TableHead>Profile</TableHead>
                    <TableHead>Connects to</TableHead>
                    <TableHead>Secrets</TableHead>
                    <TableHead>Move as</TableHead>
                    <TableHead>Name on the server</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {records.map((r) => {
                    const on = picked.has(r.id);
                    const why = on ? problem(r) : null;
                    const changed = nameOf(r) !== r.name;
                    return (
                      <TableRow key={r.id} data-record={r.id}>
                        <TableCell>
                          <Checkbox aria-label={`Move ${r.name}`} checked={on} onCheckedChange={(v) => toggle(r.id, v === true)} />
                        </TableCell>
                        <TableCell>
                          {r.name} <span className="text-caption-1 text-fg-muted">{toolLabel(r.tool)}</span>
                        </TableCell>
                        <TableCell className="break-all font-mono text-caption-1">{target(r)}</TableCell>
                        <TableCell className="text-caption-1">{secretsOf(r) === 0 ? "none" : `${secretsOf(r)} secret${secretsOf(r) === 1 ? "" : "s"}`}</TableCell>
                        <TableCell>
                          {on ? (
                            canShare ? (
                              <Select aria-label={`Move ${r.name} as`} value={shared.has(r.id) ? "shared" : "personal"} onValueChange={(v) => setShared((s) => (v === "shared" ? new Set([...s, r.id]) : new Set([...s].filter((x) => x !== r.id))))} items={{ personal: "Personal", shared: "Shared" }} className="w-auto shrink-0">
                                <SelectItem value="personal">Personal</SelectItem>
                                <SelectItem value="shared">Shared</SelectItem>
                              </Select>
                            ) : (
                              "Personal"
                            )
                          ) : (
                            <span className="text-fg-muted">not moved</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {on && (changed || why) ? (
                            <span className="flex flex-col gap-stack-xs">
                              <span className="flex items-center gap-inline-xs">
                                <Icon icon={Warning} tone="warning" />
                                <Input aria-label={`Name of ${r.name} on the server`} value={nameOf(r)} onValueChange={(v) => setEdited((e) => ({ ...e, [r.id]: v }))} className="font-mono" autoComplete="off" spellCheck={false} />
                              </span>
                              {why ? <span className="text-caption-1 text-danger-fg">{why}</span> : null}
                            </span>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {renamed.length > 0 ? (
                <p className="flex items-center gap-inline-xs text-caption-1 text-warning-fg" data-testid="rename-note">
                  <Icon icon={Warning} tone="warning" />
                  {renamed.length === 1 ? `The server already has a profile called ${renamed[0]!.name}, so yours moves as ${nameOf(renamed[0]!)}.` : `${renamed.length} names are already taken on the server, so those profiles move under the new names shown.`} Change the name if you like.
                </p>
              ) : null}
            </>
          ) : null}

          {step === "moving" && progress ? (
            <div className="flex flex-col gap-stack-md" role="status" aria-live="polite" data-testid="move-progress">
              <div className="flex items-center gap-inline-sm">
                <Spinner size="sm" label="Moving" />
                <span className="text-body-1-strong">
                  Moving {Math.min(progress.index + 1, progress.total)} of {progress.total}: {progress.name}
                </span>
              </div>
              <Progress aria-label="Moving profiles" value={Math.round((progress.index / Math.max(progress.total, 1)) * 100)} />
              <span className="text-caption-1 text-fg-muted">Each profile's secrets leave this browser only after the server confirms they are set. If this stops, the rest stay here untouched; start again to go on where it stopped.</span>
            </div>
          ) : null}

          {step === "done" && outcome ? (
            <>
              <Alert intent="success" data-testid="move-done">
                <AlertTitle>
                  {outcome.moved} {outcome.moved === 1 ? "profile" : "profiles"} moved{outcome.left > 0 ? `; ${outcome.left} left in this browser` : ""}
                </AlertTitle>
                <AlertDescription>They are on the server with their secrets encrypted{outcome.left === 0 ? ", and no longer in this browser" : ""}.</AlertDescription>
              </Alert>
              <DescriptionList layout="stacked" divided aria-label="What happened">
                {outcome.left > 0 ? (
                  <DescriptionListItem>
                    <DescriptionListTerm>Left here</DescriptionListTerm>
                    <DescriptionListDetails>{records.map((r) => r.name).join(", ")}. They stay in this browser until you move them.</DescriptionListDetails>
                  </DescriptionListItem>
                ) : null}
                <DescriptionListItem>
                  <DescriptionListTerm>Backup</DescriptionListTerm>
                  <DescriptionListDetails>{backup ? `${backup}, with secrets in plain text. Delete it once everything works.` : "None was saved."}</DescriptionListDetails>
                </DescriptionListItem>
              </DescriptionList>
            </>
          ) : null}

          {step === "stopped" && outcome ? (
            <Alert intent="info" data-testid="move-stopped">
              <AlertTitle>
                Stopped after {outcome.moved} {outcome.moved === 1 ? "profile" : "profiles"}
              </AlertTitle>
              <AlertDescription>The {outcome.left === 1 ? "other one is" : `other ${outcome.left} are`} still in this browser with {outcome.left === 1 ? "its" : "their"} secrets, untouched. Move the rest when you are ready: it goes on where it stopped.</AlertDescription>
            </Alert>
          ) : null}

          {step === "failed" && error ? (
            <>
              <ErrorState error={error} />
              {outcome && outcome.moved > 0 ? (
                <Alert intent="info">
                  <AlertDescription>
                    {outcome.moved} {outcome.moved === 1 ? "profile" : "profiles"} moved before this; the rest are untouched. Fix the cause and move again: it goes on where it stopped.
                  </AlertDescription>
                  <AlertActions />
                </Alert>
              ) : null}
            </>
          ) : null}
        </DialogBody>
        <DialogFooter>
          {step === "backup" ? (
            <>
              <Button appearance="subtle" className="me-auto" onClick={() => setStep("choose")}>
                Skip the backup
              </Button>
              <Button onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                appearance="primary"
                autoFocus
                onClick={() => {
                  setBackup(onBackup());
                  setStep("choose");
                }}
              >
                <Icon icon={ArrowDownload} /> Save backup file…
              </Button>
            </>
          ) : null}
          {step === "choose" ? (
            <>
              <Button onClick={() => setStep("backup")}>Back</Button>
              <Button appearance="primary" disabled={blocked} onClick={() => void run()}>
                <Icon icon={ArrowUpload} /> Move {chosen.length === 1 ? "1 profile" : `${chosen.length} profiles`}
              </Button>
            </>
          ) : null}
          {step === "moving" ? (
            <Button ref={stopButton} onClick={() => abort.current?.abort()}>
              Stop
            </Button>
          ) : null}
          {step === "done" ? (
            <Button appearance="primary" autoFocus onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : null}
          {step === "stopped" || step === "failed" ? (
            <>
              <Button onClick={() => onOpenChange(false)}>Close</Button>
              <Button
                appearance="primary"
                onClick={() => {
                  setPicked(new Set(records.map((r) => r.id)));
                  setStep("choose");
                }}
              >
                {step === "stopped" ? "Move the rest" : "Back to the list"}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
