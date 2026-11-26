// The signed-out page (DOC-25 §3.2.5, TSK-135 "Signing in"): what it shows from the page's metas and
// URL, every way an OIDC sign-in comes back wrong, the built-in accounts' form with its second step
// and a setup link, and that it never sends a person to the IdP by itself. axe in both themes.
import { afterEach, describe, expect, it } from "vitest";
import { type AuthAnswer, loginFailure, refusal, signInState } from "@/app/sign-in";
import { SignInPage, SignedInTab } from "@/app/sign-in-page";
import { act, axeViolations, byRole, cleanup, click, render, settle, type } from "./support/render";

afterEach(() => cleanup());

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

const PRE = "a".repeat(64);
const SIGNED_OUT = { "mightyconsole-auth": "signed-out" };

function pageState(metas: Record<string, string>, url: string) {
  const state = signInState(page({ ...SIGNED_OUT, ...metas }), new URL(url));
  if (state.kind !== "page") throw new Error("a page, not the app");
  return state;
}

const input = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const submit = async () => {
  await act(async () => {
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle(2);
};

describe("signInState", () => {
  it("is the app without the signed-out meta", () => {
    expect(signInState(page({}), new URL("https://mc.test/nats"))).toEqual({ kind: "signed-in" });
    expect(signInState(page({ "mightyconsole-auth": "signed-in" }), new URL("https://mc.test/"))).toEqual({ kind: "signed-in" });
  });

  it("is a page with the place the person was at, under the base path, and no automatic redirect", () => {
    const state = pageState({ "mightyconsole-base": "/tools/mc", "mightyconsole-idp": "Acme SSO" }, "https://mc.test/tools/mc/nats/dev?x=1#top");
    expect(state.pre).toBe("");
    expect(state.next).toBe("/tools/mc/nats/dev?x=1#top");
    expect(state.idp).toEqual({ name: "Acme SSO", href: `/tools/mc/auth/login?next=${encodeURIComponent("/tools/mc/nats/dev?x=1#top")}` });
    expect(state.failure).toBeNull();
  });

  it("takes the account routes' pre-session token and whether sign-up is open", () => {
    const state = pageState({ "mightyconsole-pre": PRE, "mightyconsole-signup": "open" }, "https://mc.test/");
    expect(state.pre).toBe(PRE);
    expect(state.signup).toBe(true);
    expect(pageState({ "mightyconsole-pre": PRE, "mightyconsole-signup": "off" }, "https://mc.test/").signup).toBe(false);
  });

  it("takes a setup link's token from the fragment, never the query", () => {
    const token = "0a".repeat(32);
    const state = pageState({ "mightyconsole-pre": PRE, "mightyconsole-base": "/mc" }, `https://mc.test/mc#setup=${token}`);
    expect(state.setupToken).toBe(token);
    expect(state.next).toBe("/mc");
    expect(pageState({ "mightyconsole-pre": PRE }, "https://mc.test/mc#setup=nothex").setupToken).toBeNull();
  });

  it("names the failure the server sent and drops it from the retry's place", () => {
    const state = pageState({ "mightyconsole-idp": "Acme SSO" }, "https://mc.test/?login_error=unreachable&x=1");
    expect(state.failure?.code).toBe("unreachable");
    expect(state.next).toBe("/?x=1");
    expect(pageState({}, "https://mc.test/?login_error=<script>").failure?.code).toBe("invalid");
  });
});

describe("loginFailure: every error state of the mockup", () => {
  const codes = ["unreachable", "denied", "invalid", "disabled", "expired", "busy"];
  it.each(codes)("%s says whose account is the problem and who can fix it", (code) => {
    const failure = loginFailure(code, "Keycloak");
    expect(failure.title.length).toBeGreaterThan(10);
    expect(failure.detail.length).toBeGreaterThan(30);
    // The reason stays in the audit log: no message repeats an IdP's own words or an internal code.
    expect(`${failure.title} ${failure.detail}`).not.toMatch(/invalid_grant|access_denied|login_error/);
  });
  it("offers a retry except for a disabled account", () => {
    expect(loginFailure("disabled", "Keycloak").retry).toBeNull();
    expect(loginFailure("unreachable", "Keycloak").retry).toBe("Try again");
    expect(loginFailure("invalid", "Keycloak").retry).toBe("Start again");
  });
});

describe("the page, with the IdP only", () => {
  it("waits for a click: one primary button, a link to the IdP, nothing sent", async () => {
    const wents: string[] = [];
    const state = pageState({ "mightyconsole-idp": "Acme SSO" }, "https://mc.test/nats");
    render(<SignInPage state={state} go={(to) => wents.push(to)} />);
    await settle();
    expect(document.querySelector("h1")?.textContent).toBe("Sign in");
    const link = byRole("link", /Continue with Acme SSO/)!;
    expect(link.getAttribute("href")).toBe(`/auth/login?next=${encodeURIComponent("/nats")}`);
    expect(document.activeElement).toBe(link);
    expect(document.querySelector("form")).toBeNull();
    expect(wents).toEqual([]);
  });

  it("shows the taking-you line after the click, and Cancel brings the page back", async () => {
    const state = pageState({ "mightyconsole-idp": "Acme SSO" }, "https://mc.test/");
    render(<SignInPage state={state} />);
    const link = byRole("link", /Continue with Acme SSO/)!;
    link.addEventListener("click", (e) => e.preventDefault());
    await click(link);
    expect(document.querySelector('[role="status"]')?.textContent).toContain("Taking you to Acme SSO");
    await click(byRole("button", "Cancel"));
    expect(byRole("link", /Continue with Acme SSO/)).not.toBeNull();
  });

  it.each([
    ["unreachable", "can't reach Acme SSO", "Try again"],
    ["denied", "Acme SSO didn't sign you in", "Try again"],
    ["invalid", "couldn't be checked", "Start again"],
    ["disabled", "account is turned off", null],
    ["expired", "took too long", "Start again"],
    ["busy", "Too many people", "Try again"],
  ])("%s: the alert says what happened and the button is %s", async (code, text, retry) => {
    const state = pageState({ "mightyconsole-idp": "Acme SSO" }, `https://mc.test/?login_error=${code}`);
    render(<SignInPage state={state} at={new Date("2026-11-25T10:42:07")} />);
    await settle();
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain(text);
    expect(alert.textContent).toContain("10:42 · recorded in the audit log");
    expect(byRole("link", retry ?? "Continue with Acme SSO")).not.toBeNull();
  });

  it("has no way to sign in on a server with neither accounts nor an IdP", async () => {
    render(<SignInPage state={pageState({}, "https://mc.test/")} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("no way to sign in");
  });
});

describe("the page, with built-in accounts", () => {
  it("offers the form, the IdP below it, sign-up and the first-start hint", async () => {
    const state = pageState({ "mightyconsole-pre": PRE, "mightyconsole-signup": "open", "mightyconsole-idp": "Acme SSO" }, "https://mc.test/nats?x=1");
    render(<SignInPage state={state} post={async () => ({ status: 500, body: {} })} go={() => {}} />);
    await settle();
    expect(input("username")).not.toBeNull();
    expect(input("password").getAttribute("type")).toBe("password");
    expect(document.activeElement).toBe(input("username"));
    expect(byRole("link", /Continue with Acme SSO/)).not.toBeNull();
    expect(byRole("button", "Create an account")).not.toBeNull();
    expect(document.querySelector("details")?.textContent).toContain("admin-password");
    // The secret itself is never on the page.
    expect(document.body.textContent).not.toMatch(/[A-Z0-9]{24}/);
  });

  it("hides sign-up when it is off", async () => {
    render(<SignInPage state={pageState({ "mightyconsole-pre": PRE, "mightyconsole-signup": "off" }, "https://mc.test/")} />);
    expect(byRole("button", "Create an account")).toBeNull();
  });

  it("an unreachable IdP says administrators can still sign in with a password", async () => {
    const state = pageState({ "mightyconsole-pre": PRE, "mightyconsole-idp": "Acme SSO" }, "https://mc.test/?login_error=unreachable");
    render(<SignInPage state={state} />);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Administrators can still sign in with a user name and password");
  });

  it("signs in through the code step and goes where the server says", async () => {
    const sent: [string, Record<string, unknown>][] = [];
    const answers: AuthAnswer[] = [
      { status: 401, body: { error: "invalid" } },
      { status: 200, body: { totp: true } },
      { status: 200, body: { ok: true, next: "/nats" } },
    ];
    let went = "";
    render(
      <SignInPage
        state={pageState({ "mightyconsole-pre": PRE }, "https://mc.test/nats")}
        post={async (path, body) => {
          sent.push([path, body]);
          return answers.shift()!;
        }}
        go={(to) => (went = to)}
      />,
    );
    await type(input("username"), "alice");
    await type(input("password"), "not it at all");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("Wrong user name or password.");
    await type(input("password"), "correct horse battery");
    await submit();
    expect(document.querySelector("h1")?.textContent).toBe("Two-step sign-in");
    await type(input("code"), "123456");
    await submit();
    expect(went).toBe("/nats");
    expect(sent.map(([path]) => path)).toEqual(["/auth/password", "/auth/password", "/auth/totp"]);
    expect(sent[1]![1]).toEqual({ username: "alice", password: "correct horse battery", next: "/nats" });
    expect(sent[2]![1]).toEqual({ code: "123456" });
  });

  it("a setup link asks for a password, and a weak one is explained", async () => {
    const token = "0a".repeat(32);
    const sent: Record<string, unknown>[] = [];
    render(
      <SignInPage
        state={pageState({ "mightyconsole-pre": PRE, "mightyconsole-base": "/mc" }, `https://mc.test/mc#setup=${token}`)}
        post={async (path, body) => {
          expect(path).toBe("/mc/auth/setup");
          sent.push(body);
          return { status: 422, body: { error: "weak_password", reason: "common" } };
        }}
        go={() => {}}
      />,
    );
    expect(document.querySelector("h1")?.textContent).toBe("Choose your password");
    await type(input("password"), "Unbelievable");
    await submit();
    expect(sent[0]).toEqual({ token, password: "Unbelievable", next: "/mc" });
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("most common");
  });

  it("creates an account from the sign-up step", async () => {
    const sent: [string, Record<string, unknown>][] = [];
    let went = "";
    render(
      <SignInPage
        state={pageState({ "mightyconsole-pre": PRE, "mightyconsole-signup": "open" }, "https://mc.test/")}
        post={async (path, body) => {
          sent.push([path, body]);
          return { status: 200, body: { ok: true, next: "/" } };
        }}
        go={(to) => (went = to)}
      />,
    );
    await click(byRole("button", "Create an account"));
    expect(document.querySelector("h1")?.textContent).toBe("Create an account");
    await type(input("username"), "lan.pham");
    await type(input("displayName"), "Lan Pham");
    await type(input("password"), "a long enough passphrase");
    await submit();
    expect(sent[0]).toEqual(["/auth/signup", { username: "lan.pham", password: "a long enough passphrase", next: "/", displayName: "Lan Pham" }]);
    expect(went).toBe("/");
  });

  it("says the server cannot be reached when the POST fails", async () => {
    render(<SignInPage state={pageState({ "mightyconsole-pre": PRE }, "https://mc.test/")} post={async () => Promise.reject(new Error("offline"))} />);
    await type(input("username"), "a");
    await type(input("password"), "b");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("cannot be reached");
  });
});

describe("refusal", () => {
  it("explains every refusal", () => {
    expect(refusal({ status: 429, body: {} })).toContain("Too many attempts");
    expect(refusal({ status: 422, body: { error: "weak_password", reason: "too_short" } })).toContain("12 characters");
    expect(refusal({ status: 409, body: { error: "username_taken" } })).toBe("This user name is taken.");
    expect(refusal({ status: 418, body: {} })).toContain("418");
  });
});

describe("the sign-in tab of a running app", () => {
  it("says it is signed in and tells the app's tab", async () => {
    let told = 0;
    render(<SignedInTab onClose={() => told++} />);
    await settle();
    expect(told).toBe(1);
    expect(document.querySelector("h1")?.textContent).toBe("You are signed in");
  });
});

describe("axe", () => {
  it.each(["light", "dark"] as const)("the page is clean in %s, with every state", async (theme) => {
    const state = pageState({ "mightyconsole-pre": PRE, "mightyconsole-signup": "open", "mightyconsole-idp": "Acme SSO" }, "https://mc.test/?login_error=unreachable");
    const view = render(<SignInPage state={state} />, { theme });
    await settle();
    expect(await axeViolations(view.container)).toEqual([]);
  });
});
