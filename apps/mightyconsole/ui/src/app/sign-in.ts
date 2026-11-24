// The signed-out page (DOC-25 §3.2.5), until the real sign-in screen (TSK-140): the server writes
// `<meta name="mightyconsole-auth" content="signed-out">` (and the IdP's name) when the browser has
// no session. The page then goes to the server's sign-in, which returns to where it was; after a
// failed sign-in (`?login_error=<code>`) it shows why, with a link to try again.
import { readRouterConfig } from "./router";

export const AUTH_META = "mightyconsole-auth";
export const IDP_META = "mightyconsole-idp";

/** What a failed sign-in's code means (DOC-25 §3.2.2). */
export const LOGIN_ERRORS: Readonly<Record<string, string>> = {
  denied: "The identity provider did not sign you in.",
  unreachable: "The identity provider cannot be reached. Try again in a moment.",
  invalid: "The sign-in could not be checked. Try again.",
  disabled: "Your account is disabled.",
  expired: "The sign-in took too long. Try again.",
  busy: "Too many people are signed in. Try again later.",
};

export type SignInState =
  | { readonly kind: "signed-in" }
  | { readonly kind: "redirect"; readonly to: string }
  | { readonly kind: "failed"; readonly message: string; readonly retry: string; readonly idp: string };

function meta(doc: Document, name: string): string {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content ?? "";
}

/** Where a page load goes: on (signed in, or no sign-in configured), to the sign-in, or a failure. */
export function signInState(doc: Document = document, location: Location | URL = window.location): SignInState {
  if (meta(doc, AUTH_META) !== "signed-out") return { kind: "signed-in" };
  const { basePath } = readRouterConfig(doc);
  const params = new URLSearchParams(location.search);
  const error = params.get("login_error");
  params.delete("login_error");
  const search = params.toString();
  const next = `${location.pathname}${search ? `?${search}` : ""}${location.hash}`;
  const retry = `${basePath}/auth/login?next=${encodeURIComponent(next)}`;
  if (error === null) return { kind: "redirect", to: retry };
  return {
    kind: "failed",
    message: LOGIN_ERRORS[error] ?? "The sign-in failed. Try again.",
    retry,
    idp: meta(doc, IDP_META) || "your identity provider",
  };
}

/** The failure, as plain text and a link (no app: nothing can be loaded without a session). */
export function renderSignInFailure(root: HTMLElement, state: Extract<SignInState, { kind: "failed" }>): void {
  const doc = root.ownerDocument;
  const main = doc.createElement("main");
  main.style.cssText = "max-width:32rem;margin:4rem auto;padding:0 1rem;font-family:system-ui,sans-serif";
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
