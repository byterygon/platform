// The session of the person at this page (DOC-25 §3.2.4, TSK-135 "Who you are" and "Before a
// session ends"): `app.me` kept fresh, the warning five minutes before a limit, and the dialog for
// a session that ended under the person's hands. The rule of the second: nothing typed is lost.
// The shell stays mounted under the dialog (its tabs, drafts and composer text are React state in
// this page), the person signs in again in another tab, and this page picks the new session up
// without a reload: the other tab tells it, it fetches the new anti-CSRF token, and the
// supervisor asks again. Only when a different person signed in does it ask for a reload.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogBody, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { Me } from "@/gen/api";
import type { MightyClient } from "./client";
import { RETURN_CHANNEL } from "./sign-in";
import { type Expiry, TOUCH_EVERY_MS, clock, endCause, expiryOf, minutesLeft, nameOf, refreshCsrf, signInAgainUrl } from "./session";
import type { ServerStatus } from "./supervisor";

export interface SessionState {
  /** `app.me`; `null` until the first answer (or on a server that has no `app.me`). */
  readonly me: Me | null;
  /** The last `me` the person had before another one signed in, when it was another person. */
  readonly replacedBy: Me | null;
  /** When this session started (Unix ms), from the person's own session list. */
  readonly startedMs: number | null;
  /** The clock the warning reads (Unix ms), ticking every 15 s. */
  readonly now: number;
  /** Asks the server now (`app.me` resets the idle timer). */
  refresh(): Promise<Me | null>;
}

/**
 * `app.me` once the server answers, again after every reconnection, and at most once a minute
 * when the person does something (a click or a key): that is the activity the idle limit counts.
 */
export function useSession(client: Pick<MightyClient, "app">, server: ServerStatus): SessionState {
  const [me, setMe] = useState<Me | null>(null);
  const [replacedBy, setReplacedBy] = useState<Me | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [startedMs, setStartedMs] = useState<number | null>(null);
  const last = useRef(0);
  const known = useRef<Me | null>(null);

  const refresh = useCallback(async (): Promise<Me | null> => {
    last.current = Date.now();
    try {
      const next = await client.app.me({});
      const before = known.current;
      known.current = next;
      if (before !== null && before.user !== next.user) setReplacedBy(next);
      else setMe(next);
      if (before === null || before.session !== next.session) {
        // When this session started: the person's own list says (the account menu shows it).
        client.app.sessions.list({}).then(
          (out) => setStartedMs(out.sessions.find((row) => row.id === next.session)?.createdMs ?? null),
          () => {},
        );
      }
      return next;
    } catch {
      return null;
    }
  }, [client]);

  useEffect(() => {
    if (server === "online") void refresh();
  }, [server, refresh]);

  useEffect(() => {
    if (server !== "online") return;
    const touch = () => {
      if (Date.now() - last.current >= TOUCH_EVERY_MS) void refresh();
    };
    window.addEventListener("pointerdown", touch, true);
    window.addEventListener("keydown", touch, true);
    return () => {
      window.removeEventListener("pointerdown", touch, true);
      window.removeEventListener("keydown", touch, true);
    };
  }, [server, refresh]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  return { me, replacedBy, startedMs, now, refresh };
}

/** Signing in again in another tab, and noticing it is done. */
export function useSignInAgain(basePath: string, active: boolean, onSignedIn: () => void) {
  const [waiting, setWaiting] = useState(false);
  const callback = useRef(onSignedIn);
  callback.current = onSignedIn;

  const check = useCallback(async () => {
    if ((await refreshCsrf(basePath)) === "signed-in") {
      setWaiting(false);
      callback.current();
    }
  }, [basePath]);

  useEffect(() => {
    if (!active) {
      setWaiting(false);
      return;
    }
    const timer = setInterval(() => void check(), 2_000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(RETURN_CHANNEL) : null;
    if (channel) channel.onmessage = () => void check();
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      channel?.close();
    };
  }, [active, check]);

  const open = useCallback(() => {
    setWaiting(true);
    window.open(signInAgainUrl(basePath), "mightyconsole-signin");
  }, [basePath]);

  return { waiting, open, check };
}

export interface ExpiryBarProps {
  expiry: Expiry;
  onStay(): void;
  onSignInAgain(): void;
  onLater(): void;
}

/** "You'll be signed out at 10:47": the warning of §3.2.4, announced once, focus not moved. */
export function ExpiryBar({ expiry, onStay, onSignInAgain, onLater }: ExpiryBarProps) {
  const idle = expiry.kind === "idle";
  return (
    <Alert layout="banner" intent="info" role="alert" data-testid="expiry-bar" data-limit={expiry.kind}>
      <AlertTitle>
        {idle ? `You'll be signed out at ${clock(expiry.at)} (${minutesLeft(expiry.inMs)})` : `Your session ends at ${clock(expiry.at)} (${minutesLeft(expiry.inMs)})`}
      </AlertTitle>
      <AlertDescription>
        {idle
          ? "Nothing has happened here for a while. Live views alone don't count as activity."
          : "That is the time limit of a session. Sign in again now: your tabs come back, and live views wait for Start."}
      </AlertDescription>
      <AlertActions>
        {idle ? (
          <Button size="small" onClick={onStay}>
            Stay signed in
          </Button>
        ) : (
          <>
            <Button size="small" onClick={onSignInAgain}>
              Sign in again
            </Button>
            <Button size="small" appearance="subtle" onClick={onLater}>
              Later
            </Button>
          </>
        )}
      </AlertActions>
    </Alert>
  );
}

/** The warning to show now, or `null`: `Later` hides an absolute-limit warning until that limit. */
export function useExpiry(me: Me | null, now: number): { expiry: Expiry | null; later(): void } {
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const expiry = me === null ? null : expiryOf(me, now);
  const later = useCallback(() => setDismissedAt(expiry?.at ?? null), [expiry?.at]);
  return { expiry: expiry !== null && dismissedAt === expiry.at ? null : expiry, later };
}

export interface SessionEndedProps {
  /** The session is gone (the server answers `Unauthenticated`). */
  open: boolean;
  /** What the page knew of the session before it ended. */
  me: Me | null;
  /** Another person signed in at the other tab. */
  replacedBy: Me | null;
  /** A sign-in tab is open and this page waits for it. */
  waiting: boolean;
  onSignInAgain(): void;
}

/**
 * The dialog of a session that ended while the app is open. The browser learns only that the
 * session is gone, so unless a limit has passed the message lists the possible causes. The shell
 * stays under it with its work.
 */
export function SessionEndedDialog({ open, me, replacedBy, waiting, onSignInAgain }: SessionEndedProps) {
  if (replacedBy !== null) {
    return (
      <AlertDialog open>
        <AlertDialogContent data-session-dialog="other-user">
          <AlertDialogHeader>
            <AlertDialogTitle>Someone else signed in</AlertDialogTitle>
            <AlertDialogDescription>
              This page was open for {me ? nameOf(me) : "another person"}, and {nameOf(replacedBy)} signed in at the other tab. Reload the page to go on as {nameOf(replacedBy)}. Unsent text in this page is not carried over, so it never reaches the wrong person.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button appearance="primary" autoFocus onClick={() => window.location.reload()}>
              Reload
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  // Read at the moment the dialog draws: the limit that has passed by now, if any.
  const cause = endCause(me, Date.now());
  const summary =
    cause === "idle"
      ? { title: "Signed out because nothing happened here for a while", text: "A session ends after the idle limit the server sets." }
      : cause === "absolute"
        ? { title: "Your session reached its time limit", text: "A session ends at most a set number of hours after sign-in, whatever you were doing." }
        : { title: "Your session was ended on the server", text: "You signed out from another browser, an administrator ended it, your access changed, or the server restarted." };
  return (
    <AlertDialog open={open}>
      <AlertDialogContent data-session-dialog={cause}>
        <AlertDialogHeader>
          <AlertDialogTitle>Your session ended</AlertDialogTitle>
          <AlertDialogDescription>Your tabs, drafts and unsent text stay on this page as they are. Sign in again, and it goes on.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="flex flex-col gap-stack-md">
          <Alert intent="info">
            <AlertTitle>{summary.title}</AlertTitle>
            <AlertDescription>{summary.text} Sign in again to go on with the access you have now.</AlertDescription>
          </Alert>
          {waiting ? (
            <p role="status" className="flex items-center gap-inline-md text-body-1 text-fg-muted">
              <Spinner label="Waiting for the sign-in" />
              Waiting for you to sign in in the other tab…
            </p>
          ) : null}
        </AlertDialogBody>
        <AlertDialogFooter>
          <Button appearance="secondary" onClick={() => window.location.reload()}>
            Reload this page
          </Button>
          <Button appearance="primary" autoFocus onClick={onSignInAgain}>
            {waiting ? "Open the sign-in again" : "Sign in again"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
