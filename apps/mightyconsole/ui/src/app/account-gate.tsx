// What a signed-in session must do before the app (DOC-25 §3.2.6, §3.2.3): `app.me` says whether
// the password must be changed (the default administrator's first sign-in, a reset), whether a
// second factor must be set up (`auth.require_totp`), or that the person has no role at all
// (`auth.default_role = ""`). Until then the server refuses everything else, so the page shows
// that step instead of the app. The pages are Byterygon UI like the sign-in; the logic is
// `gateDecision` and `GateApi`.
import { isRpcError } from "@byterygon/ambidex";
import { type FormEvent, useEffect, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import type { Me, RecoveryCodes, TotpEnrolmentOutput } from "@/gen/api";
import { Copy, SignOut } from "@/lib/icons";
import { AuthShell } from "./auth-shell";
import type { MightyClient } from "./client";
import { accessRequest, initialsOf, nameOf } from "./session";

/** The calls the gate makes (the typed client in the app, a stub in tests). */
export interface GateApi {
  me(): Promise<Me>;
  changePassword(current: string, next: string): Promise<void>;
  totpBegin(): Promise<TotpEnrolmentOutput>;
  totpConfirm(code: string): Promise<RecoveryCodes>;
}

export function gateApi(client: MightyClient): GateApi {
  return {
    me: () => client.app.me({}),
    changePassword: async (current, next) => {
      await client.app.account.changePassword({ current, new: next });
    },
    totpBegin: () => client.app.account.totp.begin({}),
    totpConfirm: (code) => client.app.account.totp.confirm({ code }),
  };
}

export type GateStep = "ready" | "changePassword" | "enrolTotp" | "noRole";

/** What the session must do before the app: the first step, in this order. */
export function gateDecision(me: Me): GateStep {
  if (me.mustChangePassword) return "changePassword";
  if (me.mustEnrolTotp) return "enrolTotp";
  // `app.me` always works; with no role every other call is refused, so the app has nothing to show.
  if (me.roles.length === 0 && me.permissions.length === 0) return "noRole";
  return "ready";
}

/** The message of a refused call. */
function message(e: unknown): string {
  if (isRpcError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

export interface GateProps {
  api: GateApi;
  me: Me;
  /** The step is done: the page loads again with the new state of the session. */
  done(): void;
  signOut(): void;
}

/** The page of the first step the session owes. */
export function Gate({ api, me, done, signOut }: GateProps) {
  switch (gateDecision(me)) {
    case "changePassword":
      return <ChangePassword api={api} done={done} />;
    case "enrolTotp":
      return <EnrolTotp api={api} done={done} />;
    default:
      return <NoRole api={api} me={me} done={done} signOut={signOut} />;
  }
}

function ChangePassword({ api, done }: { api: GateApi; done(): void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (next !== again) {
      setError("The two new passwords differ.");
      return;
    }
    setBusy(true);
    setError(null);
    api.changePassword(current, next).then(done, (e: unknown) => {
      setError(message(e));
      setBusy(false);
    });
  };
  return (
    <AuthShell title="Choose a new password">
      <p className="text-body-1 text-fg-muted">This password was set for you. Choose your own before you go on; the other sessions of this account end.</p>
      {error ? (
        <Alert intent="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <form onSubmit={submit} noValidate className="flex flex-col gap-stack-md" aria-label="Choose a new password">
        <Field>
          <FieldLabel>Current password</FieldLabel>
          <PasswordInput name="current" autoComplete="current-password" required autoFocus value={current} onValueChange={setCurrent} />
        </Field>
        <Field>
          <FieldLabel>New password</FieldLabel>
          <PasswordInput name="new" autoComplete="new-password" required value={next} onValueChange={setNext} />
          <FieldDescription>At least 12 characters, not your user name, not a common password.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel>New password again</FieldLabel>
          <PasswordInput name="again" autoComplete="new-password" required value={again} onValueChange={setAgain} />
        </Field>
        <Button type="submit" appearance="primary" size="large" loading={busy}>
          Change password
        </Button>
      </form>
    </AuthShell>
  );
}

function EnrolTotp({ api, done }: { api: GateApi; done(): void }) {
  const [enrolment, setEnrolment] = useState<TotpEnrolmentOutput | null>(null);
  const [codes, setCodes] = useState<readonly string[] | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (codes !== null) {
    return (
      <AuthShell title="Keep these recovery codes">
        <p className="text-body-1 text-fg-muted">Each code signs you in once if you lose the app. They are shown only now: write them down or store them somewhere safe.</p>
        <ul className="grid grid-cols-2 gap-stack-xs font-mono text-body-1" aria-label="Recovery codes">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <Button appearance="primary" size="large" onClick={done} autoFocus>
          I have kept them; continue
        </Button>
      </AuthShell>
    );
  }
  const begin = () => {
    setBusy(true);
    setError(null);
    api.totpBegin().then(
      (e) => {
        setEnrolment(e);
        setBusy(false);
      },
      (e: unknown) => {
        setError(message(e));
        setBusy(false);
      },
    );
  };
  const confirm = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    api.totpConfirm(code.trim()).then(
      (out) => setCodes(out.codes),
      (e: unknown) => {
        setError(message(e));
        setBusy(false);
      },
    );
  };
  return (
    <AuthShell title="Set up two-step sign-in">
      <p className="text-body-1 text-fg-muted">This server asks for a code from an authenticator app at every sign-in. Scan the image, or enter the link, in the app; then type the code it shows.</p>
      {error ? (
        <Alert intent="danger">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {enrolment === null ? (
        <Button appearance="primary" size="large" loading={busy} onClick={begin} autoFocus>
          Show the code to scan
        </Button>
      ) : (
        <>
          <img alt="QR code to scan with an authenticator app" width={200} height={200} className="self-center rounded-md" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrolment.qrSvg)}`} />
          <Code className="break-all">{enrolment.uri}</Code>
          <form onSubmit={confirm} noValidate className="flex flex-col gap-stack-md" aria-label="Confirm the code">
            <Field>
              <FieldLabel>Code from the app</FieldLabel>
              <Input name="code" autoComplete="one-time-code" inputMode="numeric" required autoFocus value={code} onValueChange={setCode} />
            </Field>
            <Button type="submit" appearance="primary" size="large" loading={busy}>
              Turn on
            </Button>
          </form>
        </>
      )}
    </AuthShell>
  );
}

/** Signed in, but no role grants anything (`auth.default_role = ""` and no group maps): who to ask. */
function NoRole({ api, me, done, signOut }: { api: GateApi; me: Me; done(): void; signOut(): void }) {
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 3_000);
    return () => clearTimeout(timer);
  }, [copied]);
  const name = nameOf(me);
  const copy = () => {
    void navigator.clipboard?.writeText(accessRequest(me, null)).then(() => setCopied(true));
  };
  // The roles may have been given since: ask again, and load the app when they have.
  const check = () => {
    setChecking(true);
    api.me().then(
      (fresh) => (gateDecision(fresh) === "ready" ? done() : setChecking(false)),
      () => setChecking(false),
    );
  };
  return (
    <AuthShell title="You're signed in, but you have no role here yet">
      <div className="flex items-center gap-inline-md">
        <span aria-hidden="true" className="flex size-control-lg items-center justify-center rounded-full bg-accent-subtle text-body-1-strong text-accent-subtle-fg">
          {initialsOf(name)}
        </span>
        <span className="flex flex-col">
          <span className="text-body-1-strong">{name}</span>
          {me.email ? <span className="text-caption-1 text-fg-muted">{me.email}</span> : null}
        </span>
      </div>
      <Alert intent="warning">
        <AlertTitle>Nothing here gives you a Mightyconsole role</AlertTitle>
        <AlertDescription>An administrator can give you one in Users and roles, or map one of your groups to a role. The request below has your name, user id and the time.</AlertDescription>
        <AlertActions>
          <Button size="small" onClick={copy} autoFocus>
            <Icon icon={Copy} />
            {copied ? "Copied" : "Copy access request"}
          </Button>
          <Button size="small" appearance="subtle" loading={checking} onClick={check}>
            Check again
          </Button>
        </AlertActions>
      </Alert>
      <Button appearance="secondary" size="large" onClick={signOut}>
        <Icon icon={SignOut} />
        Sign out
      </Button>
    </AuthShell>
  );
}
