// The one place the UI says "you cannot do this, because X, ask Y" (TSK-135 §3, TSK-140 batch 2):
// a control the person's roles do not cover (`Gated`), a tab they cannot open (`AccessPage`), a
// call the server refused (`AccessNotice`, `useRefusals`) and a tool in the navigation they cannot
// use all read the same `Refusal`: what is missing, which of their roles applies, who can grant it,
// and a plain-text request to paste anywhere. The UI only suggests; the server checks every call.
import { type ReactElement, type ReactNode, cloneElement, createContext, useCallback, useContext, useId, useMemo, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/components/ui/toast";
import type { Me } from "@/gen/api";
import { ArrowLeft, Copy, Shield } from "@/lib/icons";
import { type DeniedDetails, type Place, type Refusal, type Where, becauseText, denialOf, grantersText, headline, mayCall, permOf, placeOf, placeOfProfile, refusalAfter, refusalBefore, requestOf } from "./access";

export interface AccessValue {
  /** Who is signed in; `null` before `app.me` answers, and then nothing is locked (the server decides). */
  me: Me | null;
  /** The administrators' names, when the server tells them to people who cannot grant access. */
  admins: readonly string[] | null;
  /** Opens "My access". */
  openMyAccess(): void;
  /** The name of a stored profile, to say "on nats-prod" rather than an id. */
  profileName?(id: string): string | undefined;
}

const AccessContext = createContext<AccessValue>({ me: null, admins: null, openMyAccess: () => undefined });

export const AccessProvider = AccessContext.Provider;

export function useAccess(): AccessValue {
  return useContext(AccessContext);
}

/**
 * The refusal for a call the person's roles do not cover, or `null` when they do (or `app.me` has
 * not answered, or the procedure is unknown). `what` is the phrase before "needs": "Deleting a stream".
 */
export function useGate(procedure: string, what: string | null, where?: Where): Refusal | null {
  const { me } = useAccess();
  const place = where?.place;
  const key = `${place?.profileId ?? ""}|${place?.context ?? ""}|${place?.namespace ?? ""}|${place?.personal ? 1 : 0}`;
  return useMemo(() => {
    if (me === null || mayCall(me, procedure, place)) return null;
    const perm = permOf(procedure);
    return perm === null ? null : refusalBefore(me, perm, what, where);
    // `where` is rebuilt every render; its place is what decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, procedure, what, key, where?.profile, where?.below]);
}

/**
 * `useGate` for a call on a stored profile (and a namespace below it): the refusal says "on
 * <profile name>". `what` is the phrase before "needs".
 */
export function useGateFor(procedure: string, what: string, profile: { id: string; name: string; owner?: { kind: string; user?: string | null } | undefined }, below?: { namespace?: string | undefined; context?: string | undefined }): Refusal | null {
  const label = below?.namespace ? `namespace ${below.namespace}` : below?.context ? `context ${below.context}` : undefined;
  return useGate(procedure, what, { place: placeOfProfile(profile, below), profile: profile.name, ...(label ? { below: label } : {}) });
}

/** What a menu item takes when the person's roles do not cover it: disabled, with the reason as its title. */
export function deniedItem(refusal: Refusal | null): { disabled: true; title: string } | Record<string, never> {
  return refusal === null ? {} : { disabled: true, title: `${headline(refusal)}. ${becauseText(refusal)}` };
}

/** Copies `text`; the clipboard can be missing (an insecure page), then it says so. */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** The "Copy access request" button, in every place the refusal shows. */
export function CopyRequest({ refusal, size = "small", appearance, autoFocus }: { refusal: Refusal; size?: "small" | "medium"; appearance?: "primary" | "subtle"; autoFocus?: boolean }) {
  const { me } = useAccess();
  const toast = useToast();
  if (me === null) return null;
  return (
    <Button
      size={size}
      {...(appearance ? { appearance } : {})}
      {...(autoFocus ? { autoFocus: true } : {})}
      data-testid="copy-access-request"
      onClick={() =>
        void copy(requestOf(me, refusal)).then((ok) => toast.add(ok ? { title: "Access request copied", description: "Paste it to an administrator, in a chat or a ticket.", type: "success" } : { title: "Could not copy", description: "Select the text yourself: the clipboard is not available here.", type: "warning" }))
      }
    >
      <Icon icon={Copy} /> Copy access request
    </Button>
  );
}

function MyAccessButton({ size = "small" }: { size?: "small" | "medium" }) {
  const { openMyAccess } = useAccess();
  return (
    <Button size={size} appearance="subtle" onClick={openMyAccess}>
      My access
    </Button>
  );
}

/** The refusal's words: the headline, which role falls short, and who can grant it. */
export function RefusalLines({ refusal }: { refusal: Refusal }) {
  const { admins } = useAccess();
  return (
    <>
      <span className="text-body-1-strong">{headline(refusal)}</span>
      <span>{becauseText(refusal)}</span>
      <span className="text-fg-muted">{grantersText(admins)}</span>
    </>
  );
}

/** A refusal in place: the dialog stays open, nothing happened, and the person knows whom to ask. */
export function AccessNotice({ refusal, onClose, className }: { refusal: Refusal; onClose?: () => void; className?: string }) {
  return (
    <Alert intent="danger" role="alert" {...(className ? { className } : {})} data-testid="access-notice" data-perm={refusal.perm}>
      <AlertTitle>{`Refused: ${headline(refusal)}`}</AlertTitle>
      <AlertDescription>
        <span className="flex flex-col gap-stack-xs">
          <span>
            {becauseText(refusal)} Nothing was done.
          </span>
          <AccessGranters />
          <span className="text-caption-1 text-fg-muted">
            {refusal.at.toLocaleTimeString()} · recorded in the audit log as refused
          </span>
        </span>
      </AlertDescription>
      <AlertActions>
        <CopyRequest refusal={refusal} />
        <MyAccessButton />
        {onClose ? (
          <Button size="small" appearance="subtle" onClick={onClose}>
            Close
          </Button>
        ) : null}
      </AlertActions>
    </Alert>
  );
}

function AccessGranters() {
  const { admins } = useAccess();
  return <span>{grantersText(admins)}</span>;
}

/**
 * A tab's place when the person cannot see it (a link someone sent, a tab kept from before their
 * role changed): the tab keeps its place, so it works as soon as access is granted, and Refresh
 * tries again. Focus starts on Copy access request.
 */
export function AccessPage({ refusal, title, onBack, onRefresh }: { refusal: Refusal; title: string; onBack?: () => void; onRefresh?: () => void }) {
  const { me, admins } = useAccess();
  return (
    <EmptyState className="m-auto" data-testid="access-page" data-perm={refusal.perm}>
      <EmptyStateIcon>
        <Icon icon={Shield} filled />
      </EmptyStateIcon>
      <EmptyStateTitle render={<h2 />}>{title}</EmptyStateTitle>
      <EmptyStateDescription>{becauseText(refusal)}</EmptyStateDescription>
      <DescriptionList layout="inline" className="w-full max-w-panel-sm text-start">
        <DescriptionListItem>
          <DescriptionListTerm>Missing</DescriptionListTerm>
          <DescriptionListDetails>
            <Code>{refusal.perm}</Code>
            {refusal.where ? ` on ${refusal.where}` : ""}
          </DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Who can grant it</DescriptionListTerm>
          <DescriptionListDetails>{admins && admins.length > 0 ? `${admins.slice(0, 3).join(", ")} (administrators)` : "An administrator"}</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>When</DescriptionListTerm>
          <DescriptionListDetails>{refusal.at.toLocaleTimeString()} · recorded in the audit log as refused</DescriptionListDetails>
        </DescriptionListItem>
      </DescriptionList>
      <EmptyStateActions>
        {onBack ? (
          <Button onClick={onBack}>
            <Icon icon={ArrowLeft} /> Go back
          </Button>
        ) : null}
        {onRefresh ? <Button onClick={onRefresh}>Refresh</Button> : null}
        {me ? <CopyRequest refusal={refusal} size="medium" appearance="primary" autoFocus /> : null}
      </EmptyStateActions>
    </EmptyState>
  );
}

/**
 * A control the person's roles do not cover: shown, off, focusable, with the reason read by
 * assistive technology (`aria-describedby`), shown as a tooltip on hover and focus, and shown as a
 * toast with Copy access request when it is pressed (a click, Enter or Space). Pass `null` for a
 * control that works, and the child is rendered as it is.
 */
export function Gated({ refusal, children }: { refusal: Refusal | null; children: ReactElement<{ disabled?: boolean }> }): ReactElement {
  return refusal === null ? children : <DeniedControl refusal={refusal}>{children}</DeniedControl>;
}

function DeniedControl({ refusal, children }: { refusal: Refusal; children: ReactElement<{ disabled?: boolean }> }): ReactElement {
  const id = useId();
  const show = useRefusalToast();
  const { admins } = useAccess();
  const control = cloneElement(children, { disabled: true, focusableWhenDisabled: true, "aria-describedby": id, "data-denied": refusal.perm } as Record<string, unknown>);
  const why = `${headline(refusal)}. ${becauseText(refusal)}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex"
            onClick={() => show(refusal)}
            onKeyDown={(event) => {
              // The control is off, so it swallows its own keys; its wrapper hears them.
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                show(refusal);
              }
            }}
          />
        }
      >
        {control}
      </TooltipTrigger>
      <span id={id} hidden>
        {why}
      </span>
      <TooltipContent side="bottom" align="end" className="flex-col items-start py-inline-sm">
        <span className="text-caption-1-strong">{headline(refusal)}</span>
        <span>{becauseText(refusal)}</span>
        <span className="text-fg-muted">{grantersText(admins)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * What a handler does with an error: the refusal worded for this place if it is `PermissionDenied`,
 * else `null` and the caller shows the error as before.
 */
export function useRefusals(): (error: unknown, what?: string | null, where?: Where) => Refusal | null {
  const { me, profileName } = useAccess();
  return useCallback(
    (error, what = null, where) => {
      const details: DeniedDetails | null = error !== null && typeof error === "object" && "perm" in error ? (error as DeniedDetails) : denialOf(error);
      if (details === null || me === null) return null;
      return refusalAfter(me, details, what, where ?? whereOf(details, profileName));
    },
    [me, profileName],
  );
}

/** What the server named, in the person's words: the profile's name, and the namespace below it. */
function whereOf(details: DeniedDetails, profileName: AccessValue["profileName"]): Where | undefined {
  if (details.target?.kind !== "profile") return undefined;
  const place = placeOf(details.target.id);
  const name = place.profileId ? profileName?.(place.profileId) : undefined;
  if (!name) return { place };
  const below = place.namespace ? `namespace ${place.namespace}` : place.context ? `context ${place.context}` : undefined;
  return { place, profile: name, ...(below ? { below } : {}) };
}

/** A toast for a refusal from a menu or a toolbar: the same words, the same two actions. */
export function useRefusalToast(): (refusal: Refusal) => void {
  const toast = useToast();
  const { me, admins } = useAccess();
  return useCallback(
    (refusal) => {
      toast.add({
        title: `Refused: ${headline(refusal)}`,
        description: `${becauseText(refusal)} ${grantersText(admins)}`,
        type: "danger",
        timeout: 0,
        actionProps: {
          children: "Copy access request",
          onClick: () => {
            if (me !== null) void copy(requestOf(me, refusal));
          },
        },
      });
    },
    [toast, me, admins],
  );
}

export type { Place, Refusal, Where };

/** A tab whose profile the person cannot connect to: the access page in the tab's place, Refresh tries again. */
export function DeniedTab({ error, tool, profile, onRefresh, fallback }: { error: NonNullable<DescribedErrorLike>; tool: string; profile: string; onRefresh: () => void; fallback: ReactNode }) {
  const refuse = useRefusals();
  const refusal = error.denied ? refuse(error.denied, `Connecting to ${profile}`, error.denied.target?.kind === "profile" ? { place: placeOf(error.denied.target.id), profile } : { profile }) : null;
  if (refusal === null) return <>{fallback}</>;
  return <AccessPage refusal={refusal} title={`You don't have access to ${tool} on ${profile}`} onRefresh={onRefresh} />;
}

type DescribedErrorLike = { denied?: DeniedDetails | undefined };
