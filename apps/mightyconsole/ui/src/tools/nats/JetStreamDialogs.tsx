// The confirmations of JetStream's destructive actions (§2's pattern, §6.4; mockup frame nats-purge):
// each names the object and the profile; purging a whole stream and deleting a stream ask for its
// name typed; the danger button names the action and, for a purge, how many messages will go.
// The server's error shows in place and the dialog stays open.
import { useEffect, useState, type ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ErrorState } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { NatsStreamInfo, NatsStreamPurgeInput } from "@/gen/api";
import type { DescribedError } from "../types";
import { parseCount } from "./stream-form";
import { validatePattern } from "./profile";

/** Runs an action, tracking its busy state and error; `ok` is called when it succeeds. */
export function useAction(note: (e: unknown) => DescribedError) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const run = async (action: () => Promise<void>, ok: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      ok();
    } catch (e) {
      setError(note(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, clear: () => setError(null) };
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: ReactNode;
  confirm: string;
  disabled: boolean;
  busy: boolean;
  error: DescribedError | null;
  onConfirm(): void;
  children?: ReactNode;
  /** The confirm button is the red one (Destructive); false for a Write such as "Put revision n back". */
  danger?: boolean;
}

/** An alert dialog naming what it acts on, with Cancel and the action; the server's error shows in place. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirm, disabled, busy, error, onConfirm, children, danger = true }: ConfirmDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled && !busy) onConfirm();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription>{description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-stack-md">
            {children}
            {error ? <ErrorState error={error} /> : null}
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction type="submit" appearance={danger ? "danger" : "primary"} disabled={disabled} loading={busy}>
              {confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function useFresh(open: boolean, reset: () => void) {
  useEffect(() => {
    if (open) reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when it opens
  }, [open]);
}

export type PurgeChoice = "all" | "subject" | "keep" | "sequence";

/**
 * How many messages a purge removes, when the screen can tell: all of them, a subject's count
 * from the stream's subject counts, all but the newest n; null otherwise.
 */
export function purgeCount(info: NatsStreamInfo, choice: PurgeChoice, subject: string, keep: number | null): number | null {
  const total = info.state.messages;
  switch (choice) {
    case "all":
      return total;
    case "subject":
      return info.subjectCounts.find((c) => c.subject === subject.trim())?.messages ?? null;
    case "keep":
      return keep === null || Number.isNaN(keep) ? null : Math.max(0, total - keep);
    case "sequence":
      return null;
  }
}

export interface PurgeDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  info: NatsStreamInfo;
  profileName: string;
  busy: boolean;
  error: DescribedError | null;
  onPurge(input: Omit<NatsStreamPurgeInput, "connId" | "stream">): void;
}

/** Purge all, only a subject, keep the newest n, or below a sequence (§6.4). */
export function PurgeDialog({ open, onOpenChange, info, profileName, busy, error, onPurge }: PurgeDialogProps) {
  const name = info.config.name;
  const [choice, setChoice] = useState<PurgeChoice>("all");
  const [subject, setSubject] = useState("");
  const [keep, setKeep] = useState("");
  const [sequence, setSequence] = useState("");
  const [typed, setTyped] = useState("");
  useFresh(open, () => {
    setChoice("all");
    setSubject(info.subjectCounts[0]?.subject ?? "");
    setKeep("");
    setSequence("");
    setTyped("");
  });
  const keepN = parseCount(keep);
  const seqN = parseCount(sequence);
  const problem =
    choice === "subject"
      ? subject.trim() === ""
        ? "Name the subject."
        : validatePattern(subject.trim())
      : choice === "keep"
        ? keepN === null || Number.isNaN(keepN)
          ? "How many of the newest to keep."
          : null
        : choice === "sequence"
          ? seqN === null || Number.isNaN(seqN) || seqN < 1
            ? "A sequence from 1."
            : null
          : null;
  const count = purgeCount(info, choice, subject, keepN);
  const confirm = count === null ? "Purge messages" : `Purge ${formatCount(count)} ${count === 1 ? "message" : "messages"}`;
  const disabled = (choice === "all" && typed !== name) || (choice !== "all" && problem !== null) || count === 0;
  const input = (): Omit<NatsStreamPurgeInput, "connId" | "stream"> => {
    switch (choice) {
      case "all":
        return {};
      case "subject":
        return { subject: subject.trim() };
      case "keep":
        return { keep: keepN ?? 0 };
      case "sequence":
        return { upToSequence: seqN ?? 1 };
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Purge messages from ${name} on ${profileName}?`}
      description="Purged messages are gone from every replica. Consumers keep their positions."
      confirm={confirm}
      disabled={disabled}
      busy={busy}
      error={error}
      onConfirm={() => onPurge(input())}
    >
      <RadioGroup aria-label="What to purge" value={choice} onValueChange={(v) => setChoice(v as PurgeChoice)} className="flex flex-col gap-stack-sm">
        <label className="flex items-center gap-inline-sm text-body-1">
          <RadioGroupItem value="all" /> All messages ({formatCount(info.state.messages)})
        </label>
        <label className="flex items-center gap-inline-sm text-body-1">
          <RadioGroupItem value="subject" /> Only a subject
        </label>
        <label className="flex items-center gap-inline-sm text-body-1">
          <RadioGroupItem value="keep" /> Keep the newest n
        </label>
        <label className="flex items-center gap-inline-sm text-body-1">
          <RadioGroupItem value="sequence" /> Up to a sequence
        </label>
      </RadioGroup>
      {choice === "subject" ? (
        <Field invalid={problem !== null && subject !== ""}>
          <FieldLabel>Subject</FieldLabel>
          <Input value={subject} onValueChange={setSubject} className="font-mono" autoComplete="off" spellCheck={false} placeholder="orders.eu.created" />
          <FieldDescription>A subject or pattern; its messages go, the others stay.</FieldDescription>
          {problem && subject !== "" ? <FieldError match>{problem}</FieldError> : null}
        </Field>
      ) : null}
      {choice === "keep" ? (
        <Field>
          <FieldLabel>Keep</FieldLabel>
          <Input value={keep} onValueChange={setKeep} inputMode="numeric" className="font-mono" placeholder="n" />
          <FieldDescription>The newest n messages stay, the older ones go.</FieldDescription>
        </Field>
      ) : null}
      {choice === "sequence" ? (
        <Field>
          <FieldLabel>Sequence</FieldLabel>
          <Input value={sequence} onValueChange={setSequence} inputMode="numeric" className="font-mono" placeholder={String(info.state.lastSequence)} />
          <FieldDescription>Messages before this sequence go; this one and the later ones stay.</FieldDescription>
        </Field>
      ) : null}
      {choice === "all" ? (
        <Field>
          <FieldLabel>Type {name} to purge all</FieldLabel>
          <Input value={typed} onValueChange={setTyped} className="font-mono" autoComplete="off" spellCheck={false} placeholder={name} />
          <FieldDescription>Asked only for "All messages".</FieldDescription>
        </Field>
      ) : null}
    </ConfirmDialog>
  );
}

export interface DeleteStreamDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  name: string;
  consumers: number;
  messages: number;
  profileName: string;
  busy: boolean;
  error: DescribedError | null;
  onDelete(): void;
}

/** Deletes a stream: its messages and consumers go with it; the name is typed. */
export function DeleteStreamDialog({ open, onOpenChange, name, consumers, messages, profileName, busy, error, onDelete }: DeleteStreamDialogProps) {
  const [typed, setTyped] = useState("");
  useFresh(open, () => setTyped(""));
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete stream ${name} on ${profileName}?`}
      description={`Its ${formatCount(messages)} ${messages === 1 ? "message" : "messages"} and ${consumers} ${consumers === 1 ? "consumer" : "consumers"} are deleted from every replica. This cannot be undone.`}
      confirm="Delete stream"
      disabled={typed !== name}
      busy={busy}
      error={error}
      onConfirm={onDelete}
    >
      <Field>
        <FieldLabel>Type {name} to confirm</FieldLabel>
        <Input value={typed} onValueChange={setTyped} className="font-mono" autoComplete="off" spellCheck={false} placeholder={name} />
      </Field>
    </ConfirmDialog>
  );
}

export interface DeleteConsumerDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  stream: string;
  name: string;
  profileName: string;
  busy: boolean;
  error: DescribedError | null;
  onDelete(): void;
}

/** Deletes a consumer: its position in the stream goes with it. */
export function DeleteConsumerDialog({ open, onOpenChange, stream, name, profileName, busy, error, onDelete }: DeleteConsumerDialogProps) {
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete consumer ${name} of ${stream} on ${profileName}?`}
      description="Its position and its pending acknowledgements are lost; clients reading through it stop getting messages. The stream's messages stay."
      confirm="Delete consumer"
      disabled={false}
      busy={busy}
      error={error}
      onConfirm={onDelete}
    />
  );
}
