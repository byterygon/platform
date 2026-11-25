// The signed-out page (DOC-25 §3.2.5, §3.2.6), until the real sign-in screen (TSK-140). The server
// writes `<meta name="mightyconsole-auth" content="signed-out">` when the browser has no session,
// with the pre-session token of the built-in accounts (`mightyconsole-pre`), whether sign-up is
// open (`mightyconsole-signup`) and the IdP's name when OIDC is configured (`mightyconsole-idp`).
// The page then shows a plain form (no app: nothing else can load without a session): user name
// and password, the TOTP code when the account has one, sign-up when it is open, a setup link's
// new password, and "Sign in with <IdP>". Every POST carries the pre-session token in
// `X-Mightyconsole-Csrf` (the server also checks its cookie and the Origin).
import { readRouterConfig } from "./router";

export const AUTH_META = "mightyconsole-auth";
export const IDP_META = "mightyconsole-idp";
export const PRE_META = "mightyconsole-pre";
export const SIGNUP_META = "mightyconsole-signup";
export const CSRF_HEADER = "X-Mightyconsole-Csrf";

/** What a failed OIDC sign-in's code means (DOC-25 §3.2.2). */
export const LOGIN_ERRORS: Readonly<Record<string, string>> = {
  denied: "The identity provider did not sign you in.",
  unreachable: "The identity provider cannot be reached. Try again in a moment.",
  invalid: "The sign-in could not be checked. Try again.",
  disabled: "Your account is disabled.",
  expired: "The sign-in took too long. Try again.",
  busy: "Too many people are signed in. Try again later.",
};

/** What the account routes' error codes mean. */
export const ACCOUNT_ERRORS: Readonly<Record<string, string>> = {
  invalid: "Wrong user name or password.",
  disabled: "This account is disabled.",
  too_many: "Too many attempts. Try again later.",
  busy: "Too many people are signed in. Try again later.",
  expired: "The sign-in took too long. Sign in again.",
  invalid_link: "This link was used already or has expired. Ask an administrator for a new one.",
  invalid_username: "A user name is 3 to 64 characters: a-z, 0-9, dot, underscore, dash.",
  invalid_display_name: "A display name is 1 to 128 characters.",
  username_taken: "This user name is taken.",
  signup_off: "Sign-up is turned off on this server. Ask an administrator for an account.",
  forbidden: "The page is out of date. Reload it and try again.",
};

/** Why the password policy refused a new password. */
export const PASSWORD_REASONS: Readonly<Record<string, string>> = {
  too_short: "The password needs at least 12 characters.",
  too_long: "The password can have at most 256 characters.",
  contains_username: "The password must not contain the user name.",
  common: "This password is one of the most common ones. Choose another.",
};

export type SignInState =
  | { readonly kind: "signed-in" }
  | { readonly kind: "redirect"; readonly to: string }
  | { readonly kind: "failed"; readonly message: string; readonly retry: string; readonly idp: string }
  | {
      readonly kind: "form";
      /** The pre-session token. */
      readonly pre: string;
      readonly basePath: string;
      /** Where to go once signed in. */
      readonly next: string;
      readonly signup: boolean;
      /** The IdP's name and its sign-in, when OIDC is configured. */
      readonly idp: { readonly name: string; readonly href: string } | null;
      /** A setup link's token (from the fragment). */
      readonly setupToken: string | null;
      /** A failed OIDC sign-in's message. */
      readonly message: string | null;
    };

function meta(doc: Document, name: string): string {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? "";
}

/** Where a page load goes: on (signed in), the sign-in form, the IdP, or an IdP failure. */
export function signInState(doc: Document = document, location: Location | URL = window.location): SignInState {
  if (meta(doc, AUTH_META) !== "signed-out") return { kind: "signed-in" };
  const { basePath } = readRouterConfig(doc);
  const params = new URLSearchParams(location.search);
  const error = params.get("login_error");
  params.delete("login_error");
  const search = params.toString();
  const setup = /^#setup=([0-9a-f]{64})$/.exec(location.hash);
  const next = `${location.pathname}${search ? `?${search}` : ""}${setup ? "" : location.hash}`;
  const retry = `${basePath}/auth/login?next=${encodeURIComponent(next)}`;
  const idpName = meta(doc, IDP_META);
  const pre = meta(doc, PRE_META);
  const message = error === null ? null : (LOGIN_ERRORS[error] ?? "The sign-in failed. Try again.");
  if (pre === "") {
    // No built-in accounts on this server's page: the IdP only (as before TSK-142).
    if (error === null) return { kind: "redirect", to: retry };
    return { kind: "failed", message: message!, retry, idp: idpName || "your identity provider" };
  }
  return {
    kind: "form",
    pre,
    basePath,
    next,
    signup: meta(doc, SIGNUP_META) === "open",
    idp: idpName ? { name: idpName, href: retry } : null,
    setupToken: setup ? setup[1]! : null,
    message,
  };
}

/** The failure, as plain text and a link (no app: nothing can be loaded without a session). */
export function renderSignInFailure(root: HTMLElement, state: Extract<SignInState, { kind: "failed" }>): void {
  const doc = root.ownerDocument;
  const main = doc.createElement("main");
  main.style.cssText = MAIN_STYLE;
  const title = doc.createElement("h1");
  title.textContent = "Sign-in failed";
  const text = doc.createElement("p");
  text.textContent = state.message;
  const link = doc.createElement("a");
  link.href = state.retry;
  link.textContent = `Sign in with ${state.idp}`;
  main.append(title, text, link);
  root.replaceChildren(main);
}

const MAIN_STYLE = "max-width:26rem;margin:4rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.5";
const FIELD_STYLE = "display:block;width:100%;box-sizing:border-box;margin:.25rem 0 .75rem;padding:.5rem;font:inherit";

/** The answer of a POST to the account routes. */
export interface AuthAnswer {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

export type Post = (path: string, body: Record<string, unknown>) => Promise<AuthAnswer>;

/** A POST as the routes want it: JSON, the pre-session token, same-origin cookies. */
export function postWith(pre: string, fetchImpl: typeof fetch = fetch): Post {
  return async (path, body) => {
    const response = await fetchImpl(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", [CSRF_HEADER]: pre },
      body: JSON.stringify(body),
    });
    let parsed: Record<string, unknown> = {};
    try {
      parsed = (await response.json()) as Record<string, unknown>;
    } catch {
      // not JSON (a proxy's page): the status says enough
    }
    return { status: response.status, body: parsed };
  };
}

/** The message for a refused POST. */
export function refusal(answer: AuthAnswer): string {
  const error = typeof answer.body["error"] === "string" ? (answer.body["error"] as string) : "";
  if (error === "weak_password") {
    const reason = typeof answer.body["reason"] === "string" ? (answer.body["reason"] as string) : "";
    return PASSWORD_REASONS[reason] ?? "Choose a stronger password.";
  }
  if (answer.status === 429) return ACCOUNT_ERRORS["too_many"]!;
  return ACCOUNT_ERRORS[error] ?? `The server refused (${answer.status}). Try again.`;
}

type Step = "sign-in" | "sign-up" | "code" | "setup";

interface Field {
  readonly name: string;
  readonly label: string;
  readonly type: "text" | "password";
  readonly autocomplete: string;
  readonly optional?: boolean;
}

const FIELDS: Readonly<Record<Step, readonly Field[]>> = {
  "sign-in": [
    { name: "username", label: "User name", type: "text", autocomplete: "username" },
    { name: "password", label: "Password", type: "password", autocomplete: "current-password" },
  ],
  "sign-up": [
    { name: "username", label: "User name", type: "text", autocomplete: "username" },
    { name: "displayName", label: "Display name (optional)", type: "text", autocomplete: "name", optional: true },
    { name: "password", label: "Password (at least 12 characters)", type: "password", autocomplete: "new-password" },
  ],
  code: [{ name: "code", label: "Code from your authenticator app, or a recovery code", type: "text", autocomplete: "one-time-code" }],
  setup: [{ name: "password", label: "New password (at least 12 characters)", type: "password", autocomplete: "new-password" }],
};

const TITLES: Readonly<Record<Step, string>> = {
  "sign-in": "Sign in to Mightyconsole",
  "sign-up": "Create an account",
  code: "Two-step sign-in",
  setup: "Choose your password",
};

const BUTTONS: Readonly<Record<Step, string>> = {
  "sign-in": "Sign in",
  "sign-up": "Create account",
  code: "Continue",
  setup: "Set password and sign in",
};

/** The sign-in form. `go` leaves for the app (a full load, so the session cookie is sent). */
export function renderSignInForm(
  root: HTMLElement,
  state: Extract<SignInState, { kind: "form" }>,
  post: Post = postWith(state.pre),
  go: (to: string) => void = (to) => window.location.assign(to),
): void {
  const doc = root.ownerDocument;
  let message = state.message;
  const show = (step: Step): void => {
    const main = doc.createElement("main");
    main.style.cssText = MAIN_STYLE;
    const title = doc.createElement("h1");
    title.textContent = TITLES[step];
    main.append(title);
    if (message !== null) {
      const alert = doc.createElement("p");
      alert.setAttribute("role", "alert");
      alert.style.color = "#b10e1c";
      alert.textContent = message;
      main.append(alert);
    }
    const form = doc.createElement("form");
    form.noValidate = true;
    const inputs = new Map<string, HTMLInputElement>();
    for (const field of FIELDS[step]) {
      const label = doc.createElement("label");
      label.textContent = field.label;
      const input = doc.createElement("input");
      input.name = field.name;
      input.type = field.type;
      input.setAttribute("autocomplete", field.autocomplete);
      input.required = !field.optional;
      input.style.cssText = FIELD_STYLE;
      label.append(input);
      form.append(label);
      inputs.set(field.name, input);
    }
    const submit = doc.createElement("button");
    submit.type = "submit";
    submit.textContent = BUTTONS[step];
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      submit.disabled = true;
      const value = (name: string) => inputs.get(name)?.value ?? "";
      const base = state.basePath;
      const request: Record<Step, () => Promise<AuthAnswer>> = {
        "sign-in": () => post(`${base}/auth/password`, { username: value("username"), password: value("password"), next: state.next }),
        "sign-up": () =>
          post(`${base}/auth/signup`, {
            username: value("username"),
            password: value("password"),
            next: state.next,
            ...(value("displayName").trim() ? { displayName: value("displayName") } : {}),
          }),
        code: () => post(`${base}/auth/totp`, { code: value("code") }),
        setup: () => post(`${base}/auth/setup`, { token: state.setupToken, password: value("password"), next: state.next }),
      };
      void request[step]()
        .then((answer) => {
          if (answer.status === 200 && answer.body["totp"] === true) {
            message = null;
            show("code");
          } else if (answer.status === 200 && answer.body["ok"] === true) {
            go(typeof answer.body["next"] === "string" ? (answer.body["next"] as string) : `${base}/`);
          } else {
            message = refusal(answer);
            show(step === "code" && answer.body["error"] === "expired" ? "sign-in" : step);
          }
        })
        .catch(() => {
          message = "The server cannot be reached. Try again.";
          show(step);
        });
    });
    main.append(form);
    const links = doc.createElement("p");
    if (step === "sign-in" && state.signup) links.append(switcher("Create an account", "sign-up"));
    if (step !== "sign-in") links.append(switcher("Back to sign-in", "sign-in"));
    if (state.idp !== null && (step === "sign-in" || step === "sign-up")) {
      const idp = doc.createElement("a");
      idp.href = state.idp.href;
      idp.textContent = `Sign in with ${state.idp.name}`;
      idp.style.display = "block";
      links.append(idp);
    }
    main.append(links);
    root.replaceChildren(main);
    inputs.values().next().value?.focus();
  };
  const switcher = (text: string, step: Step): HTMLElement => {
    const button = doc.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.style.cssText = "display:block;margin:.5rem 0;background:none;border:0;padding:0;color:#0f6cbd;cursor:pointer;font:inherit";
    button.addEventListener("click", () => {
      message = null;
      show(step);
    });
    return button;
  };
  show(state.setupToken !== null ? "setup" : "sign-in");
}
