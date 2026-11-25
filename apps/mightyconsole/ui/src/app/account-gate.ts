// What a signed-in session must do before the app (DOC-25 §3.2.6), until the real screens
// (TSK-140): `app.me` says whether the password must be changed (the default administrator's
// first sign-in, a reset) or a second factor set up (`auth.require_totp`). Until then the server
// refuses everything else, so the page shows a plain form instead of the app, then reloads.
import { isRpcError } from "@byterygon/ambidex";
import type { Me, RecoveryCodes, TotpEnrolmentOutput } from "@/gen/api";
import type { MightyClient } from "./client";

const MAIN_STYLE = "max-width:26rem;margin:4rem auto;padding:0 1rem;font-family:system-ui,sans-serif;line-height:1.5";
const FIELD_STYLE = "display:block;width:100%;box-sizing:border-box;margin:.25rem 0 .75rem;padding:.5rem;font:inherit";

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

/** The message of a refused call. */
function message(e: unknown): string {
  if (isRpcError(e)) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** `true` when the app may start; otherwise the gate's form is shown and the page reloads when
 * it is done (`done`). */
export async function accountGate(root: HTMLElement, api: GateApi, done: () => void = () => window.location.reload()): Promise<boolean> {
  let me: Me;
  try {
    me = await api.me();
  } catch {
    // Not answered (an older server, a lost connection): the app shows its own state.
    return true;
  }
  if (me.mustChangePassword) {
    renderChangePassword(root, api, done);
    return false;
  }
  if (me.mustEnrolTotp) {
    renderEnrolTotp(root, api, done);
    return false;
  }
  return true;
}

function page(root: HTMLElement, title: string, text: string): { main: HTMLElement; alert: HTMLElement } {
  const doc = root.ownerDocument;
  const main = doc.createElement("main");
  main.style.cssText = MAIN_STYLE;
  const h1 = doc.createElement("h1");
  h1.textContent = title;
  const p = doc.createElement("p");
  p.textContent = text;
  const alert = doc.createElement("p");
  alert.setAttribute("role", "alert");
  alert.style.color = "#b10e1c";
  main.append(h1, p, alert);
  root.replaceChildren(main);
  return { main, alert };
}

function field(doc: Document, label: string, type: string, autocomplete: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const l = doc.createElement("label");
  l.textContent = label;
  const input = doc.createElement("input");
  input.type = type;
  input.setAttribute("autocomplete", autocomplete);
  input.required = true;
  input.style.cssText = FIELD_STYLE;
  l.append(input);
  return { label: l, input };
}

export function renderChangePassword(root: HTMLElement, api: GateApi, done: () => void): void {
  const doc = root.ownerDocument;
  const { main, alert } = page(root, "Choose a new password", "This password was set for you. Choose your own before you go on; the other sessions of this account end.");
  const form = doc.createElement("form");
  form.noValidate = true;
  const current = field(doc, "Current password", "password", "current-password");
  const next = field(doc, "New password (at least 12 characters)", "password", "new-password");
  const again = field(doc, "New password again", "password", "new-password");
  const submit = doc.createElement("button");
  submit.type = "submit";
  submit.textContent = "Change password";
  form.append(current.label, next.label, again.label, submit);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (next.input.value !== again.input.value) {
      alert.textContent = "The two new passwords differ.";
      return;
    }
    submit.disabled = true;
    api
      .changePassword(current.input.value, next.input.value)
      .then(done)
      .catch((e: unknown) => {
        alert.textContent = message(e);
        submit.disabled = false;
      });
  });
  main.append(form);
  current.input.focus();
}

export function renderEnrolTotp(root: HTMLElement, api: GateApi, done: () => void): void {
  const doc = root.ownerDocument;
  const { main, alert } = page(root, "Set up two-step sign-in", "This server asks for a code from an authenticator app at every sign-in. Scan the image, or enter the link, in the app; then type the code it shows.");
  const start = doc.createElement("button");
  start.type = "button";
  start.textContent = "Show the code to scan";
  main.append(start);
  start.addEventListener("click", () => {
    start.disabled = true;
    api
      .totpBegin()
      .then((enrolment) => {
        start.remove();
        const image = doc.createElement("img");
        image.alt = "QR code to scan with an authenticator app";
        image.width = 200;
        image.height = 200;
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(enrolment.qrSvg)}`;
        const uri = doc.createElement("code");
        uri.textContent = enrolment.uri;
        uri.style.cssText = "display:block;word-break:break-all;font-size:.8rem;margin:.5rem 0";
        const form = doc.createElement("form");
        form.noValidate = true;
        const code = field(doc, "Code from the app", "text", "one-time-code");
        const submit = doc.createElement("button");
        submit.type = "submit";
        submit.textContent = "Turn on";
        form.append(code.label, submit);
        form.addEventListener("submit", (event) => {
          event.preventDefault();
          submit.disabled = true;
          api
            .totpConfirm(code.input.value.trim())
            .then((codes) => showRecoveryCodes(root, codes.codes, done))
            .catch((e: unknown) => {
              alert.textContent = message(e);
              submit.disabled = false;
            });
        });
        main.append(image, uri, form);
        code.input.focus();
      })
      .catch((e: unknown) => {
        alert.textContent = message(e);
        start.disabled = false;
      });
  });
}

function showRecoveryCodes(root: HTMLElement, codes: readonly string[], done: () => void): void {
  const doc = root.ownerDocument;
  const { main } = page(root, "Keep these recovery codes", "Each code signs you in once if you lose the app. They are shown only now: write them down or store them somewhere safe.");
  const list = doc.createElement("ul");
  list.style.fontFamily = "monospace";
  for (const code of codes) {
    const item = doc.createElement("li");
    item.textContent = code;
    list.append(item);
  }
  const go = doc.createElement("button");
  go.type = "button";
  go.textContent = "I have kept them; continue";
  go.addEventListener("click", done);
  main.append(list, go);
}
