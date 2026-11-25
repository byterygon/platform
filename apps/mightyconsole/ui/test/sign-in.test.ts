// The signed-out page (DOC-25 §3.2.5): it goes to the server's sign-in with where it was, or shows
// why the last sign-in failed.
import { describe, expect, it } from "vitest";
import { type AuthAnswer, renderSignInFailure, renderSignInForm, refusal, signInState } from "@/app/sign-in";

function page(metas: Record<string, string>): Document {
  const doc = document.implementation.createHTMLDocument("t");
  for (const [name, content] of Object.entries(metas)) {
    const meta = doc.createElement("meta");
    meta.name = name;
    meta.content = content;
    doc.head.append(meta);
  }
  return doc;
}

describe("signInState", () => {
  it("is on without the signed-out meta", () => {
    expect(signInState(page({}), new URL("https://mc.test/nats"))).toEqual({ kind: "signed-in" });
    expect(signInState(page({ "mightyconsole-auth": "signed-in" }), new URL("https://mc.test/"))).toEqual({ kind: "signed-in" });
  });

  it("goes to the sign-in with the place it was, under the base path", () => {
    const doc = page({ "mightyconsole-auth": "signed-out", "mightyconsole-base": "/tools/mc" });
    const state = signInState(doc, new URL("https://mc.test/tools/mc/nats/dev?x=1#top"));
    expect(state).toEqual({ kind: "redirect", to: `/tools/mc/auth/login?next=${encodeURIComponent("/tools/mc/nats/dev?x=1#top")}` });
  });

  it("shows a failure with a retry that drops the error", () => {
    const doc = page({ "mightyconsole-auth": "signed-out", "mightyconsole-idp": "Acme SSO" });
    const state = signInState(doc, new URL("https://mc.test/?login_error=unreachable"));
    expect(state).toEqual({
      kind: "failed",
      message: "The identity provider cannot be reached. Try again in a moment.",
      retry: `/auth/login?next=${encodeURIComponent("/")}`,
      idp: "Acme SSO",
    });
    const root = document.createElement("div");
    if (state.kind !== "failed") throw new Error("failed");
    renderSignInFailure(root, state);
    expect(root.textContent).toContain("Sign in with Acme SSO");
    expect(root.querySelector("a")?.getAttribute("href")).toBe(state.retry);
    const unknown = signInState(doc, new URL("https://mc.test/?login_error=<script>"));
    expect(unknown.kind === "failed" && unknown.message).toBe("The sign-in failed. Try again.");
  });
});

const PRE = "a".repeat(64);

function form(doc: Document, url: string) {
  const state = signInState(doc, new URL(url));
  if (state.kind !== "form") throw new Error(`a form, not ${state.kind}`);
  return state;
}

function type(root: HTMLElement, name: string, value: string): void {
  const input = root.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`no ${name}`);
  input.value = value;
}

const submit = (root: HTMLElement) => root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the sign-in form (built-in accounts)", () => {
  it("is shown with the pre-session token, sign-up and the IdP", () => {
    const doc = page({ "mightyconsole-auth": "signed-out", "mightyconsole-pre": PRE, "mightyconsole-signup": "open", "mightyconsole-idp": "Acme SSO" });
    const state = form(doc, "https://mc.test/nats?x=1");
    expect(state.pre).toBe(PRE);
    expect(state.signup).toBe(true);
    expect(state.next).toBe("/nats?x=1");
    expect(state.idp).toEqual({ name: "Acme SSO", href: `/auth/login?next=${encodeURIComponent("/nats?x=1")}` });
    expect(state.setupToken).toBeNull();
    const root = document.createElement("div");
    renderSignInForm(root, state, async () => ({ status: 500, body: {} }), () => {});
    expect(root.textContent).toContain("Sign in to Mightyconsole");
    expect(root.textContent).toContain("Create an account");
    expect(root.textContent).toContain("Sign in with Acme SSO");
    expect(root.querySelector('input[name="password"]')?.getAttribute("type")).toBe("password");
  });

  it("signs in through the code step and goes where the server says", async () => {
    const doc = page({ "mightyconsole-auth": "signed-out", "mightyconsole-pre": PRE, "mightyconsole-signup": "off" });
    const sent: [string, Record<string, unknown>][] = [];
    const answers: AuthAnswer[] = [
      { status: 401, body: { error: "invalid" } },
      { status: 200, body: { totp: true } },
      { status: 200, body: { ok: true, next: "/nats", mustChangePassword: false } },
    ];
    let went = "";
    const root = document.createElement("div");
    renderSignInForm(root, form(doc, "https://mc.test/nats"), async (path, body) => {
      sent.push([path, body]);
      return answers.shift()!;
    }, (to) => (went = to));
    expect(root.textContent).not.toContain("Create an account");
    type(root, "username", "alice");
    type(root, "password", "not it at all");
    submit(root);
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("Wrong user name or password.");
    type(root, "username", "alice");
    type(root, "password", "correct horse battery");
    submit(root);
    await flush();
    expect(root.textContent).toContain("Two-step sign-in");
    type(root, "code", "123456");
    submit(root);
    await flush();
    expect(went).toBe("/nats");
    expect(sent.map(([path]) => path)).toEqual(["/auth/password", "/auth/password", "/auth/totp"]);
    expect(sent[1]![1]).toEqual({ username: "alice", password: "correct horse battery", next: "/nats" });
    expect(sent[2]![1]).toEqual({ code: "123456" });
  });

  it("takes a setup link's token from the fragment, never the query", async () => {
    const token = "0a".repeat(32);
    const doc = page({ "mightyconsole-auth": "signed-out", "mightyconsole-pre": PRE, "mightyconsole-base": "/mc" });
    const state = form(doc, `https://mc.test/mc#setup=${token}`);
    expect(state.setupToken).toBe(token);
    expect(state.next).toBe("/mc");
    const root = document.createElement("div");
    const sent: Record<string, unknown>[] = [];
    renderSignInForm(root, state, async (path, body) => {
      expect(path).toBe("/mc/auth/setup");
      sent.push(body);
      return { status: 422, body: { error: "weak_password", reason: "common" } };
    }, () => {});
    expect(root.textContent).toContain("Choose your password");
    type(root, "password", "Unbelievable");
    submit(root);
    await flush();
    expect(sent[0]).toEqual({ token, password: "Unbelievable", next: "/mc" });
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("most common");
    expect(form(doc, "https://mc.test/mc#setup=nothex").setupToken).toBeNull();
  });

  it("explains every refusal", () => {
    expect(refusal({ status: 429, body: {} })).toContain("Too many attempts");
    expect(refusal({ status: 422, body: { error: "weak_password", reason: "too_short" } })).toContain("12 characters");
    expect(refusal({ status: 409, body: { error: "username_taken" } })).toBe("This user name is taken.");
    expect(refusal({ status: 418, body: {} })).toContain("418");
  });
});
