// The signed-out page (DOC-25 §3.2, TSK-135's "Signing in" frames): sign in with a user name and
// password (built-in accounts), "Continue with <IdP>", sign-up when it is open, the code of a
// two-step sign-in, a setup link's new password, and every way an OIDC sign-in comes back wrong.
// The page waits for a click and never sends a person to the IdP by itself. Focus starts on the
// one primary action of the step; errors are `role="alert"`, the redirect line `role="status"`.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Spinner } from "@/components/ui/spinner";
import { Person } from "@/lib/icons";
import { AuthShell } from "./auth-shell";
import { type AuthAnswer, type Post, type SignInState, postWith, refusal } from "./sign-in";

type Step = "sign-in" | "sign-up" | "code" | "setup" | "redirecting";
type PageState = Extract<SignInState, { kind: "page" }>;

const TITLES: Readonly<Record<Step, string>> = {
  "sign-in": "Sign in",
  "sign-up": "Create an account",
  code: "Two-step sign-in",
  setup: "Choose your password",
  redirecting: "Sign in",
};

export interface SignInPageProps {
  state: PageState;
  /** The POST to the account routes (the real one carries the pre-session token). */
  post?: Post;
  /** Leaves for the app after a sign-in: a full load, so the session cookie is sent. */
  go?: (to: string) => void;
  /** When the page was loaded; the failure says when it happened, as the audit log does. */
  at?: Date;
}

export function SignInPage({ state, post = postWith(state.pre), go = (to) => window.location.assign(to), at = new Date() }: SignInPageProps) {
  const [step, setStep] = useState<Step>(state.setupToken !== null && state.pre !== "" ? "setup" : "sign-in");
  const [failure, setFailure] = useState(state.failure);
  const [message, setMessage] = useState<string | null>(null);
  const accounts = state.pre !== "";
  const idp = state.idp;

  const switchTo = (next: Step) => {
    setMessage(null);
    setFailure(null);
    setStep(next);
  };

  return (
    <AuthShell title={TITLES[step]}>
      {step === "redirecting" && idp ? (
        <Redirecting idp={idp.name} href={idp.href} onCancel={() => switchTo("sign-in")} />
      ) : (
        <>
          {failure ? <FailureAlert failure={failure} at={at} accounts={accounts} /> : null}
          {message ? (
            <Alert intent="danger">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          ) : null}
          {step === "sign-in" && !accounts && idp === null ? (
            <Alert intent="warning">
              <AlertTitle>This server has no way to sign in</AlertTitle>
              <AlertDescription>Neither built-in accounts nor an identity provider are turned on. Ask whoever runs Mightyconsole to check its configuration.</AlertDescription>
            </Alert>
          ) : null}
          {accounts ? <AccountForm key={step} step={step === "redirecting" ? "sign-in" : step} state={state} post={post} go={go} onMessage={setMessage} onStep={setStep} /> : null}
          {step === "sign-in" && idp ? (
            <IdpButton idp={idp} primary={!accounts} retry={failure?.retry ?? null} divider={accounts} onGo={() => setStep("redirecting")} />
          ) : null}
          {step === "sign-in" && accounts && state.signup ? (
            <Button appearance="transparent" className="self-start" onClick={() => switchTo("sign-up")}>
              Create an account
            </Button>
          ) : null}
          {step !== "sign-in" ? (
            <Button appearance="transparent" className="self-start" onClick={() => switchTo("sign-in")}>
              Back to sign-in
            </Button>
          ) : null}
          {step === "sign-in" && accounts ? <FirstStartHint /> : null}
        </>
      )}
    </AuthShell>
  );
}

function FailureAlert({ failure, at, accounts }: { failure: NonNullable<PageState["failure"]>; at: Date; accounts: boolean }) {
  const time = at.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return (
    <Alert intent="danger" data-login-error={failure.code}>
      <AlertTitle>{failure.title}</AlertTitle>
      <AlertDescription>
        {failure.detail}
        {failure.code === "unreachable" && accounts ? " Administrators can still sign in with a user name and password." : ""}
        <span className="mt-stack-xs block text-caption-1 text-fg-muted">{time} · recorded in the audit log</span>
      </AlertDescription>
    </Alert>
  );
}

function IdpButton({ idp, primary, retry, divider, onGo }: { idp: { name: string; href: string }; primary: boolean; retry: string | null; divider: boolean; onGo: () => void }) {
  const link = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (primary) link.current?.focus();
  }, [primary]);
  return (
    <>
      {divider ? (
        <div className="flex items-center gap-inline-md text-caption-1 text-fg-muted" aria-hidden="true">
          <span className="h-px flex-1 bg-border-subtle" />
          or
          <span className="h-px flex-1 bg-border-subtle" />
        </div>
      ) : (
        <p className="text-body-1 text-fg-muted">
          You sign in with your account at <strong>{idp.name}</strong>, then come back here.
        </p>
      )}
      <Button render={<a ref={link} href={idp.href} />} nativeButton={false} appearance={primary ? "primary" : "secondary"} size="large" onClick={onGo}>
        <Icon icon={Person} />
        {retry ?? `Continue with ${idp.name}`}
      </Button>
    </>
  );
}

function Redirecting({ idp, href, onCancel }: { idp: string; href: string; onCancel: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <>
      <div role="status" className="flex items-center gap-inline-md">
        <Spinner size="lg" label={`Taking you to ${idp}`} />
        <span className="flex flex-col gap-stack-xs">
          <span className="text-body-1-strong">Taking you to {idp}…</span>
          <span className="text-caption-1 text-fg-muted">
            If nothing happens in a few seconds, <a className="text-accent-subtle-fg underline" href={href}>open {idp} yourself</a>.
          </span>
        </span>
      </div>
      <Button appearance="secondary" size="large" onClick={onCancel}>
        Cancel
      </Button>
    </>
  );
}

/** The administrator the server makes on its first start: how to find its password. */
function FirstStartHint() {
  return (
    <details className="text-caption-1 text-fg-muted">
      <summary className="cursor-pointer text-fg">First time on this server?</summary>
      <p className="mt-stack-xs">
        The server made an administrator account named <Code>admin</Code> and wrote its password to the file <Code>admin-password</Code> in its data directory (it printed the path when it started, never the password). In the container: <Code>docker cp &lt;container&gt;:/data/admin-password -</Code>. You choose your own password right after signing in.
      </p>
    </details>
  );
}

interface FormProps {
  step: Exclude<Step, "redirecting">;
  state: PageState;
  post: Post;
  go: (to: string) => void;
  onMessage: (message: string | null) => void;
  onStep: (step: Step) => void;
}

interface FieldSpec {
  name: string;
  label: string;
  password?: boolean;
  autoComplete: string;
  optional?: boolean;
  description?: string;
}

const FIELDS: Readonly<Record<Exclude<Step, "redirecting">, readonly FieldSpec[]>> = {
  "sign-in": [
    { name: "username", label: "User name", autoComplete: "username" },
    { name: "password", label: "Password", password: true, autoComplete: "current-password" },
  ],
  "sign-up": [
    { name: "username", label: "User name", autoComplete: "username", description: "3 to 64 characters: a-z, 0-9, dot, underscore, dash." },
    { name: "displayName", label: "Display name (optional)", autoComplete: "name", optional: true },
    { name: "password", label: "Password", password: true, autoComplete: "new-password", description: "At least 12 characters." },
  ],
  code: [{ name: "code", label: "Code from your authenticator app, or a recovery code", autoComplete: "one-time-code" }],
  setup: [{ name: "password", label: "New password", password: true, autoComplete: "new-password", description: "At least 12 characters." }],
};

const BUTTONS: Readonly<Record<Exclude<Step, "redirecting">, string>> = {
  "sign-in": "Sign in",
  "sign-up": "Create account",
  code: "Continue",
  setup: "Set password and sign in",
};

function AccountForm({ step, state, post, go, onMessage, onStep }: FormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  const base = state.basePath;

  const request = (): Promise<AuthAnswer> => {
    const v = (name: string) => values[name] ?? "";
    switch (step) {
      case "sign-in":
        return post(`${base}/auth/password`, { username: v("username"), password: v("password"), next: state.next });
      case "sign-up":
        return post(`${base}/auth/signup`, { username: v("username"), password: v("password"), next: state.next, ...(v("displayName").trim() ? { displayName: v("displayName") } : {}) });
      case "code":
        return post(`${base}/auth/totp`, { code: v("code") });
      case "setup":
        return post(`${base}/auth/setup`, { token: state.setupToken, password: v("password"), next: state.next });
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    onMessage(null);
    request().then(
      (answer) => {
        if (answer.status === 200 && answer.body["totp"] === true) {
          onStep("code");
        } else if (answer.status === 200 && answer.body["ok"] === true) {
          go(typeof answer.body["next"] === "string" ? (answer.body["next"] as string) : `${base}/`);
        } else {
          onMessage(refusal(answer));
          setBusy(false);
          // A pending two-step sign-in that timed out starts again from the password.
          if (step === "code" && answer.body["error"] === "expired") onStep("sign-in");
        }
      },
      () => {
        onMessage("The server cannot be reached. Try again.");
        setBusy(false);
      },
    );
  };

  const lead: ReactNode =
    step === "setup" ? <p className="text-body-1 text-fg-muted">An administrator gave you this link to choose a password. It works once.</p> : step === "code" ? <p className="text-body-1 text-fg-muted">This account asks for a second step. Each recovery code works once.</p> : null;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-stack-md" aria-label={TITLES[step]}>
      {lead}
      {FIELDS[step].map((spec, i) => (
        <Field key={spec.name}>
          <FieldLabel>{spec.label}</FieldLabel>
          {spec.password ? (
            <PasswordInput name={spec.name} autoComplete={spec.autoComplete} required value={values[spec.name] ?? ""} onValueChange={(value) => setValues((previous) => ({ ...previous, [spec.name]: value }))} {...(i === 0 ? { ref: first } : {})} />
          ) : (
            <Input name={spec.name} autoComplete={spec.autoComplete} required={!spec.optional} spellCheck={false} value={values[spec.name] ?? ""} onValueChange={(value) => setValues((previous) => ({ ...previous, [spec.name]: value }))} {...(i === 0 ? { ref: first } : {})} />
          )}
          {spec.description ? <FieldDescription>{spec.description}</FieldDescription> : null}
        </Field>
      ))}
      <Button type="submit" appearance="primary" size="large" loading={busy}>
        {BUTTONS[step]}
      </Button>
    </form>
  );
}

/** The page a sign-in tab shows when it was opened by a running app (see `RETURN_PARAM`). */
export function SignedInTab({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    onClose();
  }, [onClose]);
  return (
    <AuthShell title="You are signed in">
      <Alert intent="success">
        <AlertDescription>Go back to the Mightyconsole tab you came from: it goes on with your tabs and drafts as they were. You can close this one.</AlertDescription>
        <AlertActions>
          <Button size="small" onClick={() => window.close()}>
            Close this tab
          </Button>
        </AlertActions>
      </Alert>
    </AuthShell>
  );
}
