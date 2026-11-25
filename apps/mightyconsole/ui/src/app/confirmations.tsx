// The destroy confirmation, functional (DOC-25 §3.3.6, TSK-138): every Destructive call is
// refused with `ApprovalRequired` until the person types the name the server asks for. The client
// is wrapped so a Destructive procedure that gets `ApprovalRequired` asks the person here
// (`app.confirmations.get` → type the phrase → `app.confirmations.confirm`) and is sent again
// once; Cancel ends the call with the original refusal. The tools' own dialogs stay as they are;
// the security UI task (TSK-140) replaces this plain dialog with the mockup's and makes the tools'
// dialogs the answer.
import { useEffect, useState } from "react";
import { RpcError } from "@byterygon/ambidex";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Code } from "@/components/ui/code";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Confirmation } from "@/gen/api";
import * as api from "@/gen/api";
import type { MightyClient } from "./client";

/** Asks the person to answer a challenge; `true` once it is confirmed. */
export type Answer = (approvalId: string) => Promise<boolean>;

/** Where the wrapped client sends a challenge: the mounted [`ConfirmationHost`]. */
export class ConfirmationGate {
  private answer: Answer | null = null;

  /** Registers the dialog; returns the unregister. */
  attach(answer: Answer): () => void {
    this.answer = answer;
    return () => {
      if (this.answer === answer) this.answer = null;
    };
  }

  /** `false` when no dialog is mounted (the call ends with its refusal). */
  ask(approvalId: string): Promise<boolean> {
    return this.answer ? this.answer(approvalId) : Promise.resolve(false);
  }
}

/** The approval id of an `ApprovalRequired` refusal, if `error` is one. */
export function approvalIdOf(error: unknown): string | null {
  if (!(error instanceof RpcError) || error.code !== "ApprovalRequired") return null;
  const details = error.details as { approval_id?: unknown } | undefined;
  return typeof details?.approval_id === "string" ? details.approval_id : null;
}

type Fn = (...args: unknown[]) => unknown;

function isDestructive(def: unknown): boolean {
  return typeof def === "object" && def !== null && (def as { risk?: unknown }).risk === "Destructive";
}

/**
 * `client` with its Destructive procedures answering their challenge through `gate`. Every
 * other function is the client's own, so its identity does not change.
 */
export function withConfirmations(client: MightyClient, gate: ConfirmationGate): MightyClient {
  const wrap = (node: Record<string, unknown>, table: Record<string, unknown> | undefined): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const def = table?.[key];
      if (typeof value === "function" && isDestructive(def)) {
        const call = value as Fn;
        out[key] = async (...args: unknown[]) => {
          try {
            return await call(...args);
          } catch (error) {
            const id = approvalIdOf(error);
            if (id === null || !(await gate.ask(id))) throw error;
            return await call(...args);
          }
        };
      } else if (typeof value === "object" && value !== null && typeof value !== "function") {
        out[key] = wrap(value as Record<string, unknown>, def as Record<string, unknown> | undefined);
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  return wrap(client as unknown as Record<string, unknown>, api.procedures as unknown as Record<string, unknown>) as unknown as MightyClient;
}

interface Pending {
  approvalId: string;
  resolve(confirmed: boolean): void;
}

/** "nats.kv.delete" → "delete"; the verb of the confirm button. */
function verbOf(action: string): string {
  const last = action.split(".").pop() ?? action;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The dialog that answers the server's challenges; mount it once under the services. */
export function ConfirmationHost({ gate, client }: { gate: ConfirmationGate; client: MightyClient }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [challenge, setChallenge] = useState<Confirmation | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(
    () =>
      gate.attach(
        (approvalId) =>
          new Promise<boolean>((resolve) => {
            setPending((previous) => {
              previous?.resolve(false);
              return { approvalId, resolve };
            });
          }),
      ),
    [gate],
  );

  useEffect(() => {
    if (pending === null) return;
    let live = true;
    setChallenge(null);
    setTyped("");
    setError(null);
    client.app.confirmations.get({ approvalId: pending.approvalId }).then(
      (c) => {
        if (live) setChallenge(c);
      },
      (e: unknown) => {
        if (live) setError(message(e));
      },
    );
    return () => {
      live = false;
    };
  }, [client, pending]);

  const close = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
    setChallenge(null);
    setBusy(false);
  };

  const confirm = async () => {
    if (pending === null || challenge === null) return;
    setBusy(true);
    setError(null);
    try {
      await client.app.confirmations.confirm({ approvalId: pending.approvalId, typed });
      close(true);
    } catch (e) {
      setBusy(false);
      setError(message(e));
    }
  };

  const where = challenge ? [challenge.tool, challenge.profileName, challenge.context, challenge.namespace].filter(Boolean).join(" · ") : "";
  return (
    <AlertDialog open={pending !== null} onOpenChange={(open) => !open && close(false)}>
      <AlertDialogContent data-confirmation={challenge?.action ?? ""} data-confirmation-phrase={challenge?.phrase ?? ""}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{challenge ? `Confirm: ${challenge.action}` : "Confirm"}</AlertDialogTitle>
            <AlertDialogDescription>
              {challenge ? (
                <>
                  {verbOf(challenge.action)} the {challenge.resourceKind} <Code>{challenge.resourceName}</Code>
                  {where ? ` (${where})` : ""}. This cannot be undone.
                </>
              ) : (
                "Loading what this destroys…"
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-stack-md">
            {challenge ? (
              <Field>
                <FieldLabel>
                  Type <Code>{challenge.phrase}</Code> to confirm
                </FieldLabel>
                <Input value={typed} onValueChange={setTyped} className="font-mono" autoComplete="off" spellCheck={false} placeholder={challenge.phrase} aria-label="Confirmation" />
                {error ? <FieldError>{error}</FieldError> : null}
              </Field>
            ) : error ? (
              <FieldError>{error}</FieldError>
            ) : null}
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction type="submit" appearance="danger" disabled={challenge === null || typed !== challenge.phrase} loading={busy}>
              {challenge ? verbOf(challenge.action) : "Confirm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
