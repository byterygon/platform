// The person's session in the shell (DOC-25 §3.2.4, TSK-135 "Who you are"): the account menu with
// the roles app.me returns, the status bar, the person's sessions, the warning five minutes
// before a limit, sign out, and a session that ends while the app is open: the dialog, and that
// nothing typed is lost.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { accessRequest, endCause, expiryOf, initialsOf, mainRole, methodText, nameOf, refreshCsrf, scopeText, signInAgainUrl, signOut, viaText } from "@/app/session";
import { StoreProvider, loadPersisted } from "@/app/store";
import type { Me } from "@/gen/api";
import { createFakeServices } from "./support/fake-services";
import { act, axeViolations, byRole, byText, cleanup, click, dialogWith, render, settle, waitFor } from "./support/render";

type Fake = ReturnType<typeof createFakeServices>;

async function mount(fake: Fake, options: { theme?: "light" | "dark"; density?: "compact" | "comfortable" } = {}) {
  const persisted = await loadPersisted(fake.storage, ["echo"]);
  const view = render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App />
      </StoreProvider>
    </ServicesContext.Provider>,
    { theme: options.theme ?? "light", density: options.density ?? "comfortable" },
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "the events subscription");
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.me"), "app.me");
  await settle(3);
  return view;
}

const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure);
const accountButton = () => document.querySelector<HTMLElement>('[data-testid="account-button"]');

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the words", () => {
  const me = { displayName: "Uy Son", username: "uy.son", user: "human:account:01A" };
  test("names, initials and roles", () => {
    expect(nameOf(me)).toBe("Uy Son");
    expect(nameOf({ displayName: null, username: "uy.son", user: "x" })).toBe("uy.son");
    expect(nameOf({ displayName: " ", username: null, user: "human:oidc:abc" })).toBe("human:oidc:abc");
    expect(initialsOf("Uy Son")).toBe("US");
    expect(initialsOf("minh.le@corp.example")).toBe("ML");
    expect(initialsOf("admin")).toBe("AD");
    expect(scopeText(null)).toBe("everywhere");
    expect(scopeText(["profile:01P", "personal"])).toBe("profile 01P, personal");
    expect(viaText("group:idp:platform-admins")).toBe("from group platform-admins");
    expect(viaText("pinned")).toBe("pinned in the configuration");
    expect(viaText("direct")).toBe("assigned to you");
    expect(mainRole([{ role: "member", scope: null, via: "default" }, { role: "operator", scope: ["profile:a"], via: "direct" }])).toBe("operator");
    expect(mainRole([{ role: "viewer", scope: null, via: "default" }, { role: "admin", scope: null, via: "pinned" }])).toBe("admin");
    expect(mainRole([])).toBeNull();
    expect(methodText("oidc", "Keycloak")).toBe("Keycloak");
    expect(methodText("totp", null)).toBe("a password and a code");
  });

  test("the warning comes five minutes before the first limit, and the end cause is a limit that has passed", () => {
    const now = 1_000_000_000;
    const limits = (idle: number, absolute: number) => ({ idleExpiresMs: now + idle, absoluteExpiresMs: now + absolute });
    expect(expiryOf(limits(10 * 60_000, 3_600_000), now)).toBeNull();
    expect(expiryOf(limits(4 * 60_000, 3_600_000), now)).toMatchObject({ kind: "idle", inMs: 4 * 60_000 });
    expect(expiryOf(limits(30 * 60_000, 3 * 60_000), now)).toMatchObject({ kind: "absolute", inMs: 3 * 60_000 });
    expect(expiryOf({ idleExpiresMs: 0, absoluteExpiresMs: 0 }, now)).toBeNull();
    expect(endCause(limits(-1, 60_000), now)).toBe("idle");
    expect(endCause(limits(60_000, -1), now)).toBe("absolute");
    expect(endCause(limits(60_000, 60_000), now)).toBe("unknown");
    expect(endCause(null, now)).toBe("unknown");
  });

  test("an access request has the person and the time, never a secret", () => {
    const text = accessRequest({ displayName: "Lan Pham", username: "lan", user: "human:account:01L", email: "lan@corp.example", tenant: "default" }, { permission: "nats.destroy", target: "nats-prod" }, new Date("2026-11-25T10:00:00Z"));
    expect(text).toBe(["Access request for Mightyconsole (default)", "Name: Lan Pham", "Email: lan@corp.example", "User: human:account:01L", "Needs: nats.destroy on nats-prod", "When: 2026-11-25T10:00:00.000Z"].join("\n"));
  });
});

describe("sign out and the token of a new session", () => {
  test("sign out posts with the page's token and goes where the server says", async () => {
    document.head.insertAdjacentHTML("beforeend", '<meta name="mightyconsole-csrf" content="tok-1">');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ location: "https://idp.test/logout?x=1" }), { status: 200 }));
    const went: string[] = [];
    await signOut("/mc", fetchImpl as unknown as typeof fetch, (to) => went.push(to));
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/mc/auth/logout");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "X-Mightyconsole-Csrf": "tok-1", Accept: "application/json" });
    expect(went).toEqual(["https://idp.test/logout?x=1"]);
    const failing = vi.fn(async () => Promise.reject(new Error("offline")));
    await signOut("/mc", failing as unknown as typeof fetch, (to) => went.push(to));
    expect(went[1]).toBe("/mc/");
    document.head.querySelector('meta[name="mightyconsole-csrf"]')?.remove();
  });

  test("a new session's token is put in the page's meta; a signed-out page is reported", async () => {
    document.head.insertAdjacentHTML("beforeend", '<meta name="mightyconsole-csrf" content="old">');
    const page = (head: string) => vi.fn(async () => new Response(`<html><head>${head}</head></html>`, { status: 200 })) as unknown as typeof fetch;
    expect(await refreshCsrf("", document, page('<meta name="mightyconsole-auth" content="signed-in"><meta name="mightyconsole-csrf" content="new">'))).toBe("signed-in");
    expect(document.querySelector<HTMLMetaElement>('meta[name="mightyconsole-csrf"]')?.content).toBe("new");
    expect(await refreshCsrf("", document, page('<meta name="mightyconsole-auth" content="signed-out">'))).toBe("signed-out");
    expect(document.querySelector<HTMLMetaElement>('meta[name="mightyconsole-csrf"]')?.content).toBe("new");
    expect(await refreshCsrf("", document, page(""))).toBe("error");
    expect(await refreshCsrf("", document, vi.fn(async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).toBe("error");
    document.head.querySelector('meta[name="mightyconsole-csrf"]')?.remove();
    expect(signInAgainUrl("/mc")).toBe("/mc/?mc_return=1");
  });
});

describe("the account menu and the status bar", () => {
  test("the button has the initials; the menu says who, which roles, where and how they came", async () => {
    const fake = createFakeServices();
    fake.server.me = { ...fake.server.me, roles: [{ role: "admin", scope: null, via: "group:idp:platform-admins" }, { role: "operator", scope: ["profile:01PROD"], via: "direct" }] };
    await mount(fake);
    const button = accountButton()!;
    expect(button.getAttribute("aria-label")).toBe("Account: Uy Son");
    expect(button.textContent).toBe("US");
    expect(document.querySelector('[data-testid="status-person"]')?.textContent).toBe("Uy Son · admin");
    await click(button);
    await waitFor(() => document.querySelector('[data-testid="account-summary"]') !== null, "the menu");
    const summary = document.querySelector('[data-testid="account-summary"]')!.textContent!;
    expect(summary).toContain("Uy Son");
    expect(summary).toContain("uy.son@corp.example");
    expect(summary).toContain("admin");
    expect(summary).toContain("everywhere · from group platform-admins");
    expect(summary).toContain("operator");
    expect(summary).toContain("profile 01PROD · assigned to you");
    expect(summary).toContain("Signed in with a password");
    expect(byRole("menuitem", /Sessions/)).not.toBeNull();
    expect(byRole("menuitem", /Settings/)).not.toBeNull();
    expect(byRole("menuitem", "Sign out")).not.toBeNull();
  });

  test("a server without app.me shows no account button and the app still works", async () => {
    const fake = createFakeServices();
    (fake.services.client.app as unknown as { me: undefined }).me = undefined;
    const persisted = await loadPersisted(fake.storage, ["echo"]);
    render(
      <ServicesContext.Provider value={fake.services}>
        <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
          <App />
        </StoreProvider>
      </ServicesContext.Provider>,
    );
    await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "events");
    await settle(3);
    expect(accountButton()).toBeNull();
    expect(byRole("button", "Settings")).not.toBeNull();
  });

  test("the palette offers Sessions and Sign out", async () => {
    const fake = createFakeServices();
    await mount(fake);
    await click(byRole("button", /Search commands/));
    await waitFor(() => document.querySelector("[role=listbox]") !== null, "the palette");
    const text = document.querySelector("[role=listbox]")!.textContent!;
    expect(text).toContain("Sessions");
    expect(text).toContain("Sign out");
  });

  test("axe: the menu is clean in both themes", async () => {
    for (const theme of ["light", "dark"] as const) {
      const fake = createFakeServices();
      const view = await mount(fake, { theme });
      await click(accountButton());
      await waitFor(() => document.querySelector('[data-testid="account-summary"]') !== null, "the menu");
      expect(await axeViolations(document.body)).toEqual([]);
      view.unmount();
    }
  });
});

describe("your sessions", () => {
  test("lists the person's sessions, marks this browser, signs one out and then the others", async () => {
    const fake = createFakeServices();
    fake.server.sessions.push({ id: "ls_third", user: fake.server.me.user, method: "oidc", createdMs: Date.now() - 9000_000, lastActivityMs: Date.now() - 900_000, idleExpiresMs: 0, absoluteExpiresMs: 0, client: "10.20.1.8", current: false });
    await mount(fake);
    await click(accountButton());
    await click(await waitForItem(/Sessions/));
    await waitFor(() => dialogWith("Your sessions") !== null && document.querySelectorAll("[data-session]").length === 3, "the list");
    const rows = [...document.querySelectorAll<HTMLElement>("[data-session]")];
    expect(rows.map((r) => r.dataset["session"])).toEqual(["ls_current", "ls_other", "ls_third"]);
    expect(rows[0]!.textContent).toContain("This browser");
    expect(rows[0]!.querySelector("button")).toBeNull();
    expect(rows[1]!.textContent).toContain("10.0.7.3");
    await click(rows[1]!.querySelector("button"));
    await waitFor(() => document.querySelectorAll("[data-session]").length === 2, "one signed out");
    expect(calls(fake, "app.sessions.revoke").map((c) => c.input)).toEqual([{ sessionId: "ls_other" }]);
    await click(byRole("button", "Sign out of other sessions"));
    await waitFor(() => document.querySelectorAll("[data-session]").length === 1, "the others signed out");
    expect(calls(fake, "app.sessions.revoke").map((c) => c.input)).toEqual([{ sessionId: "ls_other" }, { sessionId: "ls_third" }]);
    expect((byRole("button", "Sign out of other sessions") as HTMLButtonElement).disabled).toBe(true);
    expect(await axeViolations(dialogWith("Your sessions")!)).toEqual([]);
  });
});

async function waitForItem(name: RegExp): Promise<HTMLElement> {
  await waitFor(() => byRole("menuitem", name) !== null, `the ${name} item`);
  return byRole("menuitem", name)!;
}

describe("before a session ends", () => {
  test("the idle warning names the time and Stay signed in asks the server, which resets it", async () => {
    const fake = createFakeServices();
    fake.server.me = { ...fake.server.me, idleExpiresMs: Date.now() + 4 * 60_000 };
    await mount(fake);
    const bar = document.querySelector('[data-testid="expiry-bar"]')!;
    expect(bar.getAttribute("role")).toBe("alert");
    expect(bar.textContent).toMatch(/You'll be signed out at \d\d:\d\d \(in 4 minutes\)/);
    expect(byRole("button", "Sign in again")).toBeNull();
    const before = calls(fake, "app.me").length;
    fake.server.me = { ...fake.server.me, idleExpiresMs: Date.now() + 60 * 60_000 };
    await click(byRole("button", "Stay signed in"));
    await waitFor(() => document.querySelector('[data-testid="expiry-bar"]') === null, "the warning to go");
    expect(calls(fake, "app.me").length).toBe(before + 1);
  });

  test("the time limit cannot be extended: Sign in again ends the session here and opens the other tab; Later hides it", async () => {
    const fake = createFakeServices();
    fake.server.me = { ...fake.server.me, absoluteExpiresMs: Date.now() + 3 * 60_000 };
    await mount(fake);
    const bar = document.querySelector('[data-testid="expiry-bar"]')!;
    expect(bar.getAttribute("data-limit")).toBe("absolute");
    expect(bar.textContent).toContain("Your session ends at");
    await click(byRole("button", "Later"));
    expect(document.querySelector('[data-testid="expiry-bar"]')).toBeNull();
  });

  test("Sign in again posts the sign-out without leaving the page, then opens the sign-in tab", async () => {
    const fake = createFakeServices();
    fake.server.me = { ...fake.server.me, absoluteExpiresMs: Date.now() + 3 * 60_000 };
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);
    const open = vi.fn();
    vi.stubGlobal("open", open);
    await mount(fake);
    await click(byRole("button", "Sign in again"));
    await waitFor(() => open.mock.calls.length === 1, "the sign-in tab");
    expect((fetchImpl.mock.calls[0] as unknown as [string])[0]).toBe("/auth/logout");
    expect(open.mock.calls[0]![0]).toBe("/?mc_return=1");
  });
});

describe("a session that ends while the app is open", () => {
  test("the dialog lists the possible causes, the shell stays, and nothing typed is lost", async () => {
    const fake = createFakeServices();
    await mount(fake);
    await key("n", { ctrlKey: true, altKey: true });
    await waitFor(() => dialogWith("New") !== null || document.querySelector("[role=dialog] input") !== null, "the Add sheet");
    const field = document.querySelector<HTMLInputElement>("[role=dialog] input")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")!.set!;
      setter.call(field, "orders-draft");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => fake.endSession());
    await waitFor(() => dialogWith("Your session ended") !== null, "the session dialog");
    const dialog = dialogWith("Your session ended")!;
    expect(dialog.getAttribute("role")).toBe("alertdialog");
    expect(dialog.textContent).toContain("Your session was ended on the server");
    expect(dialog.textContent).toContain("administrator ended it");
    expect(dialog.textContent).toContain("stay on this page as they are");
    // The same input, in the same page, with its text.
    expect(document.body.contains(field)).toBe(true);
    expect(field.value).toBe("orders-draft");
    expect(byText("Lost the connection to mightyconsole-server, retrying…")).toBeNull();
    expect(await axeViolations(dialog)).toEqual([]);
  });

  test("a passed idle limit says so", async () => {
    const fake = createFakeServices();
    fake.server.me = { ...fake.server.me, idleExpiresMs: Date.now() + 1000 };
    await mount(fake);
    await act(async () => new Promise((r) => setTimeout(r, 1100)));
    await act(async () => fake.endSession());
    await waitFor(() => dialogWith("Your session ended") !== null, "the session dialog");
    expect(dialogWith("Your session ended")!.getAttribute("data-session-dialog")).toBe("idle");
    expect(dialogWith("Your session ended")!.textContent).toContain("nothing happened here for a while");
  });

  test("Sign in again opens the tab; when it is done the page takes the new token and goes on", async () => {
    const fake = createFakeServices();
    document.head.insertAdjacentHTML("beforeend", '<meta name="mightyconsole-csrf" content="old-token">');
    const open = vi.fn();
    vi.stubGlobal("open", open);
    const signedIn = { current: false };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(signedIn.current ? '<html><head><meta name="mightyconsole-auth" content="signed-in"><meta name="mightyconsole-csrf" content="new-token"></head></html>' : '<html><head><meta name="mightyconsole-auth" content="signed-out"></head></html>', { status: 200 })),
    );
    await mount(fake);
    await act(async () => fake.endSession());
    await waitFor(() => dialogWith("Your session ended") !== null, "the session dialog");
    const eventsBefore = calls(fake, "app.events").length;
    await click(byRole("button", "Sign in again"));
    expect(open).toHaveBeenCalledWith("/?mc_return=1", "mightyconsole-signin");
    expect(dialogWith("Your session ended")!.textContent).toContain("Waiting for you to sign in");
    // Back at this tab, still signed out: nothing changes.
    await act(async () => window.dispatchEvent(new Event("focus")));
    await settle(3);
    expect(dialogWith("Your session ended")).not.toBeNull();
    // The other tab signed in.
    signedIn.current = true;
    fake.signInAgain();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => dialogWith("Your session ended") === null, "the dialog to go");
    expect(document.querySelector<HTMLMetaElement>('meta[name="mightyconsole-csrf"]')?.content).toBe("new-token");
    await waitFor(() => calls(fake, "app.events").length > eventsBefore, "the events again");
    document.head.querySelector('meta[name="mightyconsole-csrf"]')?.remove();
  });

  test("another person signing in at the other tab asks for a reload and carries nothing over", async () => {
    const fake = createFakeServices();
    document.head.insertAdjacentHTML("beforeend", '<meta name="mightyconsole-csrf" content="old-token">');
    vi.stubGlobal("open", vi.fn());
    vi.stubGlobal("fetch", vi.fn(async () => new Response('<html><head><meta name="mightyconsole-auth" content="signed-in"><meta name="mightyconsole-csrf" content="other-token"></head></html>', { status: 200 })));
    await mount(fake);
    await act(async () => fake.endSession());
    await waitFor(() => dialogWith("Your session ended") !== null, "the session dialog");
    await click(byRole("button", "Sign in again"));
    fake.signInAgain({ user: "human:account:01BAO", displayName: "Bao Tran", session: "ls_bao" });
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => dialogWith("Someone else signed in") !== null, "the other person dialog");
    const dialog = dialogWith("Someone else signed in")!;
    expect(dialog.textContent).toContain("Uy Son");
    expect(dialog.textContent).toContain("Bao Tran");
    expect(byRole("button", "Reload")).not.toBeNull();
    document.head.querySelector('meta[name="mightyconsole-csrf"]')?.remove();
  });
});

function key(name: string, init: KeyboardEventInit): Promise<void> {
  return act(async () => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: name, code: `Key${name.toUpperCase()}`, bubbles: true, cancelable: true, ...init }));
  });
}

export type { Me };
