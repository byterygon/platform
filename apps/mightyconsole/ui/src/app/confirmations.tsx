// The destroy confirmation (DOC-25 §3.3.6, TSK-138; the mockup's "Destroying something", TSK-140):
// every Destructive call is refused with `ApprovalRequired` until the person types the name the
// server asks for. The client is wrapped so a Destructive procedure that gets `ApprovalRequired`
// asks the person here (`app.confirmations.get` → type the phrase → `app.confirmations.confirm`)
// and is sent again once; Cancel ends the call with the original refusal. A challenge lasts two
// minutes: when it lapses, "Ask again" sends the call again for a new one and keeps what was typed,
// so the name has to be typed again only if it changed. Five wrong answers in a minute pause the
// session's confirmations (the server says so).
import { useEffect, useRef, useState } from "react";
import { RpcError, isRpcError } from "@byterygon/ambidex";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { Confirmation, Me } from "@/gen/api";
import * as api from "@/gen/api";
import type { MightyClient } from "./client";
import { nameOf } from "./session";

/** Asks the person to answer a challenge: `true` once it is confirmed, `"again"` to send the call for a new one. */
export type Answer = (approvalId: string) => Promise<boolean | "again">;

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
  ask(approvalId: string): Promise<boolean | "again"> {
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
          for (;;) {
            try {
              return await call(...args);
            } catch (error) {
              const id = approvalIdOf(error);
              if (id === null) throw error;
              const answer = await gate.ask(id);
              if (answer === "again") continue;
              if (!answer) throw error;
              return await call(...args);
            }
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
  resolve(answer: boolean | "again"): void;
}

/** "nats.kv.delete" → "Delete"; the verb of the title and of the confirm button. */
function verbOf(action: string): string {
  const last = action.split(".").pop() ?? action;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whether the server says the challenge lapsed (a Conflict "this confirmation expired…"). */
function lapsed(error: unknown): boolean {
  return isRpcError(error) && /expired/i.test(error.message);
}

/** Whether the server paused this session's confirmations after too many wrong answers. */
function paused(error: unknown): boolean {
  return isRpcError(error) && error.code === "ResourceExhausted";
}

const EXPIRED = "This confirmation expired after 2 minutes. Nothing was deleted. Press Ask again to get a new one.";

/** Seconds, as the dialog counts the challenge down. */
function secondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

export interface ConfirmationHostProps {
  gate: ConfirmationGate;
  client: MightyClient;
  /** When the server asks for a fresh sign-in before a destroy (`reauth`): the trip to the identity provider. */
  onSignInAgain?: () => void;
}

/** The dialog that answers the server's challenges; mount it once under the services. */
export function ConfirmationHost({ gate, client, onSignInAgain }: ConfirmationHostProps) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [challenge, setChallenge] = useState<Confirmation | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const [as, setAs] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // What was typed survives "Ask again": the new challenge reuses it, and the name is typed again only if it changed.
  const kept = useRef("");
  const field = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      gate.attach(
        (approvalId) =>
          new Promise<boolean | "again">((resolve) => {
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
    setTyped(kept.current);
    setError(null);
    setExpired(false);
    client.app.confirmations.get({ approvalId: pending.approvalId }).then(
      (c) => {
        if (live) setChallenge(c);
      },
      (e: unknown) => {
        if (!live) return;
        if (lapsed(e)) setExpired(true);
        else setError(message(e));
      },
    );
    const me = (client.app as { me?: (input: Record<string, never>) => Promise<Me> }).me;
    if (me) {
      me({}).then(
        (m) => live && setAs(nameOf(m)),
        () => undefined,
      );
    }
    return () => {
      live = false;
    };
  }, [client, pending]);

  // The challenge lapses on the server's clock; count it down here so the dialog says so before the answer is refused.
  const expiresAt = challenge?.expiresAt ?? 0;
  useEffect(() => {
    if (pending === null || expiresAt <= 0) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending, expiresAt]);
  const lapsedNow = expired || (expiresAt > 0 && now >= expiresAt);

  // Focus starts in the name field, never on the danger button; the field exists once the challenge is read.
  const ready = challenge !== null && !challenge.reauth && !lapsedNow;
  useEffect(() => {
    if (ready) field.current?.focus();
  }, [ready, challenge]);

  const close = (answer: boolean | "again") => {
    if (answer !== "again") kept.current = "";
    else kept.current = typed;
    pending?.resolve(answer);
    setPending(null);
    setChallenge(null);
    setBusy(false);
  };

  const confirm = async () => {
    if (pending === null || challenge === null || typed !== challenge.phrase || lapsedNow) return;
    setBusy(true);
    setError(null);
    try {
      await client.app.confirmations.confirm({ approvalId: pending.approvalId, typed });
      close(true);
    } catch (e) {
      setBusy(false);
      if (lapsed(e)) setExpired(true);
      else setError(paused(e) ? "Too many wrong answers. Confirmations are paused for a minute; nothing was deleted." : message(e));
    }
  };

  const verb = challenge ? verbOf(challenge.action) : "Confirm";
  const target = challenge ? `${challenge.resourceKind} ${challenge.resourceName}` : "";
  const title = challenge ? `${verb} ${target}${challenge.profileName ? ` on ${challenge.profileName}` : ""}` : "Confirm";
  const reauth = challenge?.reauth === true;
  const left = challenge && expiresAt > 0 && !lapsedNow ? secondsLeft(expiresAt, now) : null;

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
            <AlertDialogTitle>{reauth ? "Confirm it's you" : title}</AlertDialogTitle>
            <AlertDialogDescription>
              {challenge ? (
                reauth ? (
                  `This server asks for a fresh sign-in before anything is deleted. Then press ${verb} again and type the name once more.`
                ) : (
                  <>This cannot be undone. {lapsedNow ? "" : left !== null ? `This confirmation lasts ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")} more.` : ""}</>
                )
              ) : lapsedNow ? (
                "This confirmation expired."
              ) : (
                "Loading what this destroys…"
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody className="flex flex-col gap-stack-md">
            {challenge ? (
              <>
                <DescriptionList layout="inline" data-testid="confirmation-target">
                  <DescriptionListItem>
                    <DescriptionListTerm>Tool</DescriptionListTerm>
                    <DescriptionListDetails>{challenge.tool}</DescriptionListDetails>
                  </DescriptionListItem>
                  {challenge.profileName ? (
                    <DescriptionListItem>
                      <DescriptionListTerm>Profile</DescriptionListTerm>
                      <DescriptionListDetails>
                        <b>{challenge.profileName}</b>
                      </DescriptionListDetails>
                    </DescriptionListItem>
                  ) : null}
                  {challenge.context ? (
                    <DescriptionListItem>
                      <DescriptionListTerm>Context</DescriptionListTerm>
                      <DescriptionListDetails>{challenge.context}</DescriptionListDetails>
                    </DescriptionListItem>
                  ) : null}
                  {challenge.namespace ? (
                    <DescriptionListItem>
                      <DescriptionListTerm>Namespace</DescriptionListTerm>
                      <DescriptionListDetails>{challenge.namespace}</DescriptionListDetails>
                    </DescriptionListItem>
                  ) : null}
                  <DescriptionListItem>
                    <DescriptionListTerm>{challenge.resourceKind.charAt(0).toUpperCase() + challenge.resourceKind.slice(1)}</DescriptionListTerm>
                    <DescriptionListDetails>
                      <b>{challenge.resourceName}</b>
                    </DescriptionListDetails>
                  </DescriptionListItem>
                  {as ? (
                    <DescriptionListItem>
                      <DescriptionListTerm>As</DescriptionListTerm>
                      <DescriptionListDetails>{as}</DescriptionListDetails>
                    </DescriptionListItem>
                  ) : null}
                </DescriptionList>
                {reauth ? null : (
                  <Field invalid={lapsedNow || error !== null}>
                    <FieldLabel>
                      Type <Code>{challenge.phrase}</Code> to confirm
                    </FieldLabel>
                    <Input ref={field} value={typed} onValueChange={setTyped} className="font-mono" autoComplete="off" spellCheck={false} placeholder={challenge.phrase} aria-label="Confirmation" disabled={lapsedNow} />
                    {lapsedNow ? (
                      <FieldError match role="alert">{EXPIRED}</FieldError>
                    ) : error ? (
                      <FieldError match role="alert">{error}</FieldError>
                    ) : (
                      <FieldDescription>Exactly as shown, capitals included. The server checks it too.</FieldDescription>
                    )}
                  </Field>
                )}
              </>
            ) : lapsedNow || error ? (
              <Field invalid>
                <FieldError match role="alert">
                  {lapsedNow ? EXPIRED : error}
                </FieldError>
              </Field>
            ) : null}
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            {lapsedNow ? (
              <AlertDialogAction type="button" autoFocus onClick={() => close("again")}>
                Ask again
              </AlertDialogAction>
            ) : reauth ? (
              <AlertDialogAction type="button" onClick={() => onSignInAgain?.()} disabled={!onSignInAgain}>
                Sign in again
              </AlertDialogAction>
            ) : (
              <AlertDialogAction type="submit" appearance="danger" disabled={challenge === null || typed !== challenge.phrase} loading={busy}>
                {challenge ? `${verb} ${challenge.resourceKind}` : "Confirm"}
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
