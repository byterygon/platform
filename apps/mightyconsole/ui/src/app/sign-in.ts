// The signed-out page (DOC-25 §3.2.5, §3.2.6): what it must show, from the `<meta>` the server
// writes and the URL; the page itself is `sign-in-page.tsx`. The server writes
// `<meta name="mightyconsole-auth" content="signed-out">` when the browser has no session, with
// the pre-session token of the built-in accounts (`mightyconsole-pre`), whether sign-up is open
// (`mightyconsole-signup`) and the IdP's name when OIDC is configured (`mightyconsole-idp`). Every
// POST carries the pre-session token in `X-Mightyconsole-Csrf` (the server also checks its cookie
// and the Origin). The page never sends the person to the IdP by itself (TSK-135, question d): it
// waits for a click, so an error stays on screen and a person who just signed out is not sent
// straight back.
import { readRouterConfig } from "./router";

export const AUTH_META = "mightyconsole-auth";
export const IDP_META = "mightyconsole-idp";
export const PRE_META = "mightyconsole-pre";
export const SIGNUP_META = "mightyconsole-signup";
export const CSRF_HEADER = "X-Mightyconsole-Csrf";

/** The query parameter of the sign-in tab that a running app opens to sign in again. */
export const RETURN_PARAM = "mc_return";
/** The channel the sign-in tab tells the app tab on that it is done. */
export const RETURN_CHANNEL = "mightyconsole-signed-in";

/** One failed OIDC sign-in, as the page says it (DOC-25 §3.2.2): what happened, what to do. */
export interface LoginFailure {
  readonly code: string;
  readonly title: string;
  readonly detail: string;
  /** The label of the one primary action, when the person can try again. */
  readonly retry: string | null;
}

/**
 * What a failed OIDC sign-in's code means. The reason never reaches the browser (it is in the
 * audit log), so each message says whose account is the problem and who can fix it.
 */
export function loginFailure(code: string, idp: string): LoginFailure {
  switch (code) {
    case "unreachable":
      return { code, title: `Mightyconsole can't reach ${idp}`, detail: `The server got no answer from ${idp}. Your account is fine; the server keeps trying. If this goes on, ask whoever runs Mightyconsole to check its connection to ${idp}.`, retry: "Try again" };
    case "denied":
      return { code, title: `${idp} didn't sign you in`, detail: `It refused the sign-in. If you should have access, ask your identity administrator to let you use Mightyconsole in ${idp}.`, retry: "Try again" };
    case "disabled":
      return { code, title: "Your Mightyconsole account is turned off", detail: `An administrator turned it off here; ${idp} still knows you. Ask an administrator if you think this is a mistake.`, retry: null };
    case "expired":
      return { code, title: "The sign-in took too long", detail: "A sign-in must be finished within 10 minutes. Start again from this page, in this browser.", retry: "Start again" };
    case "busy":
      return { code, title: "Too many people are signed in", detail: "The server holds as many sessions as it allows. Try again in a few minutes, or ask an administrator to end idle sessions.", retry: "Try again" };
    default:
      // `invalid` and anything unknown: the page does not guess.
      return { code: "invalid", title: "The sign-in couldn't be checked", detail: "Start again from this page, in this browser. If it fails again, tell an administrator the time below; the reason is in the audit log.", retry: "Start again" };
  }
}

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

/** What the signed-out page shows, or `signed-in` when the app may start. */
export type SignInState =
  | { readonly kind: "signed-in" }
  | {
      readonly kind: "page";
      /** The pre-session token of the built-in accounts; empty when this server offers the IdP only. */
      readonly pre: string;
      readonly basePath: string;
      /** Where to go once signed in. */
      readonly next: string;
      readonly signup: boolean;
      /** The IdP's name and its sign-in, when OIDC is configured. */
      readonly idp: { readonly name: string; readonly href: string } | null;
      /** A setup link's token (from the fragment). */
      readonly setupToken: string | null;
      /** A failed OIDC sign-in. */
      readonly failure: LoginFailure | null;
    };

function meta(doc: Document, name: string): string {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? "";
}

/** What a page load shows: the app, or the sign-in page with the failure of the last attempt. */
export function signInState(doc: Document = document, location: Location | URL = window.location): SignInState {
  if (meta(doc, AUTH_META) !== "signed-out") return { kind: "signed-in" };
  const { basePath } = readRouterConfig(doc);
  const params = new URLSearchParams(location.search);
  const error = params.get("login_error");
  params.delete("login_error");
  const search = params.toString();
  const setup = /^#setup=([0-9a-f]{64})$/.exec(location.hash);
  const next = `${location.pathname}${search ? `?${search}` : ""}${setup ? "" : location.hash}`;
  const login = `${basePath}/auth/login?next=${encodeURIComponent(next)}`;
  const idpName = meta(doc, IDP_META);
  return {
    kind: "page",
    pre: meta(doc, PRE_META),
    basePath,
    next,
    signup: meta(doc, SIGNUP_META) === "open",
    idp: idpName ? { name: idpName, href: login } : null,
    setupToken: setup ? setup[1]! : null,
    failure: error === null ? null : loginFailure(error, idpName || "your identity provider"),
  };
}

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
