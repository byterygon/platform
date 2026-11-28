// What the person may do, as the shell shows it (DOC-25 §3.3, TSK-135 §3, TSK-140 batch 2): the
// scope rules the server uses, the words of a refusal, a control that is shown but off with its
// reason, a tool the roles do not cover, a tab the person cannot open, and My access.
import { RpcError } from "@byterygon/ambidex";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Refusal, becauseText, covers, denialOf, grantersText, headline, holds, holdsAnywhere, listRoles, mayCall, permOf, placeOf, placeOfProfile, refusalAfter, refusalBefore, requestOf, rolesAt, toolOpen, targetId } from "@/app/access";
import { AccessNotice, AccessPage, AccessProvider, type AccessValue, Gated } from "@/app/access-ui";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { describeError } from "@/app/messages";
import { StoreProvider, loadPersisted } from "@/app/store";
import { Button } from "@/components/ui/button";
import { Toast } from "@/components/ui/toast";
import type { Me, PermissionGrant, RoleGrant } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { createFakeServices, everyPermission } from "./support/fake-services";
import { act, axeViolations, byRole, byText, cleanup, click, dialogWith, key, render, settle, waitFor } from "./support/render";

const grant = (perm: string, scope: string[] | "everywhere"): PermissionGrant => ({ perm, everywhere: scope === "everywhere", scope: scope === "everywhere" ? [] : scope });
const role = (name: string, scope: string[] | null = null, via = "direct"): RoleGrant => ({ role: name, scope, via });

const ME: Me = {
  user: "human:oidc:bao",
  session: "ls_1",
  method: "oidc",
  account: false,
  username: null,
  displayName: "Bao Tran",
  totp: false,
  mustChangePassword: false,
  mustEnrolTotp: false,
  idleExpiresMs: Date.now() + 3_600_000,
  absoluteExpiresMs: Date.now() + 12 * 3_600_000,
  email: "bao.tran@corp.example",
  tenant: "default",
  roles: [role("member", null, "default"), role("operator", ["profile:PNATS", "profile:PTEMP/ns:orders-*"], "group:idp:platform-ops")],
  permissions: [
    grant("app.read", "everywhere"),
    grant("nats.read", ["profile:PNATS"]),
    grant("nats.write", ["profile:PNATS"]),
    grant("temporal.read", ["profile:PTEMP/ns:orders-*"]),
    grant("temporal.write", ["profile:PTEMP/ns:orders-*"]),
    grant("echo.read", "everywhere"),
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("scopes, as the server reads them", () => {
  test("a profile entry covers the profile and everything under it; a namespace entry only its namespaces", () => {
    expect(covers("profile:P", { profileId: "P" })).toBe(true);
    expect(covers("profile:P", { profileId: "P", namespace: "any" })).toBe(true);
    expect(covers("profile:P", { profileId: "Q" })).toBe(false);
    expect(covers("profile:P/ns:orders-*", { profileId: "P", namespace: "orders-eu" })).toBe(true);
    expect(covers("profile:P/ns:orders-*", { profileId: "P", namespace: "payments" })).toBe(false);
    expect(covers("profile:P/ns:orders-*", { profileId: "P" })).toBe(false);
    expect(covers("profile:P/ns:default", { profileId: "P", namespace: "default" })).toBe(true);
    expect(covers("profile:P/ns:*", { profileId: "P" })).toBe(false);
  });

  test("a Kubernetes context is a prefix; a namespace entry without a context does not reach into one", () => {
    expect(covers("profile:P/ctx:prod", { profileId: "P", context: "prod", namespace: "web" })).toBe(true);
    expect(covers("profile:P/ctx:prod", { profileId: "P", context: "dev" })).toBe(false);
    expect(covers("profile:P/ctx:prod", { profileId: "P" })).toBe(false);
    expect(covers("profile:P/ctx:prod/ns:team-a-*", { profileId: "P", context: "prod", namespace: "team-a-web" })).toBe(true);
    expect(covers("profile:P/ctx:prod/ns:team-a-*", { profileId: "P", context: "prod" })).toBe(false);
    expect(covers("profile:P/ns:web", { profileId: "P", context: "prod", namespace: "web" })).toBe(false);
  });

  test("`personal` covers only the person's own profiles, and on those they hold every permission of the tool", () => {
    expect(covers("personal", { profileId: "P", personal: true })).toBe(true);
    expect(covers("personal", { profileId: "P" })).toBe(false);
    const withPersonal = { permissions: [grant("profiles.personal", "everywhere")] };
    expect(holds(withPersonal, "nats.destroy", { profileId: "P", personal: true })).toBe(true);
    expect(holds(withPersonal, "nats.destroy", { profileId: "P" })).toBe(false);
    expect(holds({ permissions: [] }, "nats.destroy", { profileId: "P", personal: true })).toBe(false);
  });

  test("holds answers where, and anywhere without a place", () => {
    expect(holds(ME, "nats.read", { profileId: "PNATS" })).toBe(true);
    expect(holds(ME, "nats.read", { profileId: "POTHER" })).toBe(false);
    expect(holds(ME, "nats.destroy", { profileId: "PNATS" })).toBe(false);
    expect(holds(ME, "temporal.write", { profileId: "PTEMP", namespace: "orders-eu" })).toBe(true);
    expect(holds(ME, "temporal.write", { profileId: "PTEMP", namespace: "payments" })).toBe(false);
    expect(holdsAnywhere(ME, "nats.read")).toBe(true);
    expect(holdsAnywhere(ME, "k8s.read")).toBe(false);
    expect(holds(ME, "app.self", { profileId: "X" })).toBe(true);
    expect(holds(ME, "echo.read")).toBe(true);
  });

  test("a tool is open when a role holds its read permission somewhere, or the person keeps personal profiles", () => {
    expect(toolOpen(ME, "nats")).toBe(true);
    expect(toolOpen(ME, "docker")).toBe(false);
    expect(toolOpen({ permissions: [grant("profiles.personal", "everywhere")] }, "docker")).toBe(true);
  });

  test("the roles that apply at a place, and the words for them", () => {
    expect(rolesAt(ME, { profileId: "PNATS" }).map((r) => r.role)).toEqual(["member", "operator"]);
    expect(rolesAt(ME, { profileId: "POTHER" }).map((r) => r.role)).toEqual(["member"]);
    expect(rolesAt(ME).length).toBe(2);
    expect(listRoles([role("operator"), role("member")])).toBe("operator and member");
    expect(listRoles([role("a"), role("b"), role("c")])).toBe("a, b and c");
    expect(listRoles([role("a"), role("a", ["profile:x"])])).toBe("a");
    expect(placeOf("P/ctx:prod/ns:web")).toEqual({ profileId: "P", context: "prod", namespace: "web" });
    expect(placeOf("P")).toEqual({ profileId: "P" });
    expect(targetId({ profileId: "P", context: "c", namespace: "n" })).toBe("P/ctx:c/ns:n");
    expect(targetId({})).toBeNull();
    expect(placeOfProfile({ id: "P", owner: { kind: "shared" } })).toEqual({ profileId: "P", personal: false });
    expect(placeOfProfile({ id: "P" }, { namespace: "n" })).toEqual({ profileId: "P", personal: true, namespace: "n" });
  });

  test("a procedure's permission comes from the generated table", () => {
    expect(permOf("nats.js.streams.delete")).toBe("nats.destroy");
    expect(permOf("nats.js.streams.purge")).toBe("nats.destroy");
    expect(permOf("temporal.workflows.terminate")).toBe("temporal.destroy");
    expect(permOf("no.such.thing")).toBeNull();
    expect(mayCall(ME, "nats.js.streams.delete", { profileId: "PNATS" })).toBe(false);
    expect(mayCall(ME, "nats.kv.get", { profileId: "PNATS" })).toBe(true);
    expect(mayCall(ME, "no.such.thing")).toBe(true);
  });
});

describe("the words of a refusal", () => {
  const at = new Date("2026-11-26T10:44:02Z");
  test("a destroy on nats-prod: what is missing, which role applies, who can grant it", () => {
    const r = refusalBefore(ME, "nats.destroy", "Deleting a stream", { place: { profileId: "PNATS" }, profile: "nats-prod" }, at);
    expect(r.reason).toBe("missing");
    expect(headline(r)).toBe("Deleting a stream needs nats.destroy on nats-prod");
    expect(becauseText(r)).toBe("Your roles there, member and operator, do not include nats.destroy.");
    expect(grantersText(null)).toBe("An administrator can grant it.");
    expect(grantersText(["Uy Son", "Minh Le"])).toBe("Who can grant it: Uy Son and Minh Le (administrators).");
    expect(grantersText(["A", "B", "C", "D", "E"])).toBe("Who can grant it: A, B and C and 2 more (administrators).");
  });

  test("a permission held elsewhere says where it is not, and one nothing covers says that", () => {
    const scoped = refusalBefore(ME, "temporal.write", "Starting a workflow", { place: { profileId: "PTEMP", namespace: "payments" }, profile: "orders-temporal", below: "namespace payments" }, at);
    expect(scoped.reason).toBe("scope");
    expect(headline(scoped)).toBe("Starting a workflow needs temporal.write on namespace payments of orders-temporal");
    const none = refusalBefore({ roles: [role("member", null, "default")], permissions: [] }, "k8s.read", "Using Kubernetes", { profile: "a Kubernetes profile" }, at);
    expect(becauseText({ ...none, roles: [] })).toBe("None of your roles covers a Kubernetes profile.");
    expect(becauseText({ ...none, reason: "unknown" })).toContain("not a permission this server knows");
    expect(becauseText({ ...none, reason: "policy" })).toContain("policy refuses this for your session");
  });

  test("PermissionDenied carries perm, target and reason; any other error carries none", () => {
    const denied = new RpcError("PermissionDenied", "permission denied", { details: { perm: "langgraph.read", target: { kind: "profile", id: "PAGENTS" }, reason: "missing" } });
    expect(denialOf(denied)).toEqual({ perm: "langgraph.read", target: { kind: "profile", id: "PAGENTS" }, reason: "missing" });
    expect(denialOf(new RpcError("PermissionDenied", "permission denied"))).toBeNull();
    expect(denialOf(new RpcError("NotFound", "no"))).toBeNull();
    expect(describeError(denied).denied).toMatchObject({ perm: "langgraph.read" });
    const r = refusalAfter(ME, denialOf(denied)!, "Opening a thread", { place: placeOf("PAGENTS"), profile: "agents-dev" }, at);
    expect(r.target).toBe("PAGENTS");
    expect(headline(r)).toBe("Opening a thread needs langgraph.read on agents-dev");
  });

  test("the request to paste names the person, the permission, the place, the roles and the time", () => {
    const r = refusalBefore(ME, "nats.destroy", "Deleting a stream", { place: { profileId: "PNATS" }, profile: "nats-prod" }, at);
    const text = requestOf(ME, r);
    expect(text).toContain("Access request for Mightyconsole (default)");
    expect(text).toContain("Name: Bao Tran");
    expect(text).toContain("Email: bao.tran@corp.example");
    expect(text).toContain("Groups: idp:platform-ops");
    expect(text).toContain("Needs: nats.destroy on nats-prod");
    expect(text).toContain("Target: PNATS");
    expect(text).toContain("operator (profile PNATS, profile PTEMP/ns:orders-*)");
    expect(text).toContain("When: 2026-11-26T10:44:02.000Z");
  });
});

function provide(value: Partial<AccessValue>, children: React.ReactNode) {
  return (
    <Toast>
      <AccessProvider value={{ me: ME, admins: null, openMyAccess: () => undefined, ...value }}>{children}</AccessProvider>
    </Toast>
  );
}

const refusal = (): Refusal => refusalBefore(ME, "nats.destroy", "Deleting a stream", { place: { profileId: "PNATS" }, profile: "nats-prod" }, new Date("2026-11-26T10:44:02Z"));

describe("a control the roles do not cover", () => {
  test("it is shown, off, focusable and described by the reason; pressing it shows the refusal with Copy access request", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(
      provide(
        { admins: ["Uy Son", "Minh Le"] },
        <Gated refusal={refusal()}>
          <Button onClick={() => void clicked.push("delete")}>Delete…</Button>
        </Gated>,
      ),
    );
    const clicked: string[] = [];
    const button = byRole("button", "Delete…") as HTMLButtonElement;
    expect(button.getAttribute("data-denied")).toBe("nats.destroy");
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.disabled).toBe(false);
    const described = document.getElementById(button.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toContain("Deleting a stream needs nats.destroy on nats-prod");
    expect(document.querySelectorAll("[role=button]").length).toBe(0);
    button.focus();
    expect(document.activeElement).toBe(button);
    await waitFor(() => byText(/Who can grant it: Uy Son and Minh Le/) !== null, "the tooltip on focus");
    await key("Enter", {}, button);
    await waitFor(() => byText("Refused: Deleting a stream needs nats.destroy on nats-prod") !== null, "the toast");
    expect(clicked).toEqual([]);
    await click(byRole("button", "Copy access request"));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String((writeText.mock.calls as unknown as string[][])[0]![0])).toContain("Needs: nats.destroy on nats-prod");
  });

  test("without a refusal the control is the child as it is", () => {
    render(
      provide(
        {},
        <Gated refusal={null}>
          <Button>Delete…</Button>
        </Gated>,
      ),
    );
    const button = byRole("button", "Delete…") as HTMLButtonElement;
    expect(button.getAttribute("data-denied")).toBeNull();
    expect(button.getAttribute("aria-disabled")).toBeNull();
  });

  test("a refusal in place and a page for a tab, both axe clean, the page starting on Copy access request", async () => {
    render(provide({}, <AccessNotice refusal={refusal()} onClose={() => undefined} />));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("Nothing was done.");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("recorded in the audit log as refused");
    expect(await axeViolations()).toEqual([]);
    cleanup();
    render(provide({ admins: ["Uy Son"] }, <AccessPage refusal={refusal()} title="You don't have access to NATS on nats-prod" onBack={() => undefined} onRefresh={() => undefined} />));
    expect(document.querySelector("h2")?.textContent).toBe("You don't have access to NATS on nats-prod");
    expect(document.activeElement).toBe(byRole("button", "Copy access request"));
    expect(document.body.textContent).toContain("Uy Son (administrators)");
    expect(await axeViolations()).toEqual([]);
  });
});

type Fake = ReturnType<typeof createFakeServices>;

function profile(tool: string, id: string, name: string, owner?: ProfileRecord["owner"]): ProfileRecord {
  return { id, tool, version: 1, name, createdAt: "2026-11-23T10:00:00.000Z", updatedAt: "2026-11-23T10:00:00.000Z", fields: { greeting: "" }, secrets: {}, extras: {}, ...(owner ? { owner } : {}) };
}

async function mount(fake: Fake) {
  const persisted = await loadPersisted(fake.storage, ["echo"]);
  const view = render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App />
      </StoreProvider>
    </ServicesContext.Provider>,
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.me"), "app.me");
  await settle(3);
  return view;
}

const navItem = (tool: string) => document.querySelector<HTMLElement>(`[data-nav-item][data-tool="${tool}"]`);

beforeEach(() => {
  vi.useRealTimers();
});

describe("the shell for a person with narrow roles", () => {
  test("a tool no role covers stays in the navigation, locked, with its reason; picking it shows the access page", async () => {
    const fake = createFakeServices();
    fake.server.me = { ...ME, permissions: ME.permissions };
    await mount(fake);
    const docker = navItem("docker")!;
    expect(docker.getAttribute("data-locked")).toBe("docker.read");
    expect(docker.getAttribute("aria-description")).toContain("Using Docker needs docker.read on a Docker profile");
    expect(docker.querySelector('[aria-label="Locked"]')).not.toBeNull();
    expect(navItem("echo")!.getAttribute("data-locked")).toBeNull();
    expect(navItem("nats")!.getAttribute("data-locked")).toBeNull();
    await click(docker);
    await waitFor(() => document.querySelector('[data-testid="access-page"]') !== null, "the access page");
    const page = document.querySelector('[data-testid="access-page"]')!;
    expect(page.textContent).toContain("docker.read");
    expect(page.querySelector("h2")?.textContent).toBe("You can't use Docker");
    // The workspace shows why (TSK-172), not "Add a Docker connection" and its button; the
    // sidebar's Add connection stays, off, with the reason.
    expect(page.closest('[data-pane="tab"]')).not.toBeNull();
    expect(document.querySelectorAll('[data-testid="access-page"]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Add a Docker connection");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Add connection")).toBe(false);
    const add = document.querySelector<HTMLButtonElement>('[data-pane="sidebar"] button[aria-label="Add connection"]')!;
    expect(add.getAttribute("data-denied")).toBe("docker.read");
    expect(document.querySelector('[data-testid="tool-locked"]')?.textContent).toContain("docker.read");
    expect(await axeViolations()).toEqual([]);
    // A tool the roles cover shows its connections as before.
    await click(navItem("echo"));
    await waitFor(() => document.querySelector('[data-testid="access-page"]') === null, "the connections");
    expect(document.querySelector('[data-pane="sidebar"] button[aria-label="Add connection"]')?.getAttribute("data-denied")).toBeNull();
  });

  test("a person who keeps personal profiles has no locked tool", async () => {
    const fake = createFakeServices();
    fake.server.me = { ...ME, permissions: [...ME.permissions, grant("profiles.personal", "everywhere")] };
    await mount(fake);
    expect(document.querySelectorAll("[data-locked]").length).toBe(0);
  });

  test("My access lists the roles and where they hold, and the permissions with where", async () => {
    const fake = createFakeServices();
    fake.server.me = ME;
    await mount(fake);
    await click(document.querySelector('[data-testid="account-button"]'));
    await click(byRole("menuitem", "My access"));
    const dialog = dialogWith("My access")!;
    expect(dialog.textContent).toContain("operator");
    expect(dialog.textContent).toContain("from group platform-ops");
    expect(dialog.textContent).toContain("profile PTEMP/ns:orders-*");
    expect(dialog.textContent).toContain("nats.write");
    expect(dialog.textContent).toContain("everywhere");
    expect(await axeViolations()).toEqual([]);
  });

  test("a connect the server refuses shows the access page in the tab, with what is missing and the request to copy", async () => {
    const fake = createFakeServices();
    fake.server.me = { ...ME, permissions: [grant("echo.read", ["profile:POTHER"]), grant("profiles.personal", "everywhere")] };
    const p = profile("echo", "PECHO", "lab");
    await fake.storage.putProfile(p);
    await fake.storage.putWorkspace("tabs", { version: 1, tabs: [{ id: "t1", tool: "echo", profileId: p.id, kind: "echo.ping", params: {}, title: "Ping · lab", pinned: false }], activeTab: "t1" });
    fake.server.connectDenied = { perm: "echo.read", target: { kind: "profile", id: "PECHO" }, reason: "scope" };
    await mount(fake);
    // A restored tab connects by itself; the refusal is what it finds.
    await waitFor(() => byText("Connect to lab") !== null || document.querySelector('[data-testid="access-page"]') !== null, "the tab");
    if (document.querySelector('[data-testid="access-page"]') === null) await click(byRole("button", "Connect"));
    await waitFor(() => document.querySelector('[data-testid="access-page"]') !== null, "the access page of the tab");
    const page = document.querySelector('[data-testid="access-page"]')!;
    expect(page.textContent).toContain("You don't have access to Echo on lab");
    expect(page.textContent).toContain("echo.read");
    expect(page.textContent).toContain("recorded in the audit log as refused");
    expect(page.getAttribute("data-perm")).toBe("echo.read");
    expect(byRole("button", "Refresh")).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});
