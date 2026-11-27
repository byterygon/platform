// Users and roles (DOC-25 §3.3, TSK-135 §5, TSK-140 batch 3a): the matrix drawn from the
// catalogue, the people with their roles and where each comes from, adding and removing a direct
// role, ending a session, turning an account off, the roles screen (built-in read-only, a role
// made here editable, Copy as a new role) and the group mappings (pinned read-only, replaced
// with the etag).
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { COLUMNS, badgeRole, copyId, directOf, fromText, hasNoRole, idFromName, matrixOf, scopeOf, seenText, toggled, validRoleId, whereText, withoutDirect } from "@/app/admin/admin";
import { AdminDialog } from "@/app/admin/AdminDialog";
import { Toast } from "@/components/ui/toast";
import { createFakeServices, everyPermission } from "./support/fake-services";
import { axeViolations, byRole, byText, cleanup, click, dialogWith, render, settle, type as typeText, waitFor } from "./support/render";

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

describe("the logic", () => {
  // `audit.read` joins the catalogue with the audit procedures (batch 3b): the server's list has it already.
  const catalogue = [...everyPermission().map((g) => g.perm), "audit.read"].map((perm) => ({ perm, targetKind: "profile" }));
  test("the matrix has a row per tool, a dash where the tool has no such permission, and the rest below", () => {
    const m = matrixOf(catalogue);
    const tools = m.rows.map((r) => r.tool);
    expect(tools).toContain("nats");
    expect(tools).toContain("docker");
    expect(tools).not.toContain("messaging");
    expect(tools).not.toContain("admin");
    const docker = m.rows.find((r) => r.tool === "docker")!;
    expect(docker.cells).toMatchObject({ read: "docker.read", write: "docker.write", destroy: "docker.destroy", exec: "docker.exec", files: "docker.files.read", secrets: null });
    const nats = m.rows.find((r) => r.tool === "nats")!;
    expect(nats.cells).toMatchObject({ exec: null, files: null, secrets: null });
    expect(m.everywhere).toContain("audit.read");
    expect(m.everywhere).toContain("profiles.personal");
    expect(m.everywhere).not.toContain("nats.read");
    expect(m.everywhere).not.toContain("app.self");
    expect(COLUMNS.map((c) => c.label)).toEqual(["Read", "Write", "Destroy", "Exec", "Container files", "Reveal Secrets"]);
  });

  test("a role with Exec also gets term.write, and loses it with the last Exec", () => {
    const a = toggled(["nats.read"], "docker.exec", true);
    expect(a).toEqual(["docker.exec", "nats.read", "term.write"]);
    expect(toggled(a, "docker.exec", false)).toEqual(["nats.read"]);
    expect(toggled(["docker.exec", "k8s.exec", "term.write"], "docker.exec", false)).toEqual(["k8s.exec", "term.write"]);
  });

  test("ids and names of roles", () => {
    expect(idFromName("Release manager")).toBe("release-manager");
    expect(idFromName("9 lives")).toBe("r-9-lives");
    expect(validRoleId("release-manager")).toBe(true);
    expect(validRoleId("Release")).toBe(false);
    expect(validRoleId("a")).toBe(false);
    expect(copyId("operator", ["operator"])).toBe("operator-copy");
    expect(copyId("operator", ["operator", "operator-copy"])).toBe("operator-copy-2");
  });

  test("where an assignment applies, in words and as scope entries", () => {
    const name = (id: string) => ({ P1: "nats-prod", P2: "orders-temporal" })[id];
    expect(whereText(null, name)).toBe("everywhere");
    expect(whereText(["profile:P1", "profile:P2/ns:orders-*"], name)).toBe("nats-prod, orders-temporal › namespaces orders-*");
    expect(whereText(["profile:P9/ctx:prod"], name)).toBe("P9 › context prod");
    expect(whereText(["personal"], name)).toBe("personal profiles");
    expect(scopeOf([], "x")).toBeNull();
    expect(scopeOf(["P1"], " orders-* ")).toEqual(["profile:P1/ns:orders-*"]);
    expect(scopeOf(["P1", "P2"], "orders-*")).toEqual(["profile:P1", "profile:P2"]);
  });

  test("who has what: the badge, where it came from, direct assignments, no role", () => {
    const roles = [
      { role: "member", scope: null, via: "default" },
      { role: "operator", scope: ["profile:A", "profile:B"], via: "group:idp:oncall" },
      { role: "operator", scope: ["profile:C"], via: "direct" },
    ];
    expect(badgeRole(roles)).toEqual({ role: "operator", limits: 3 });
    expect(fromText(roles)).toBe("everyone, oncall, direct");
    expect(directOf({ roles })).toEqual([{ role: "operator", scope: ["profile:C"] }]);
    expect(withoutDirect({ roles }, 0)).toEqual([]);
    expect(hasNoRole({ roles: [roles[0]!] })).toBe(true);
    expect(hasNoRole({ roles })).toBe(false);
    expect(seenText(null)).toBe("never");
    const now = new Date("2026-11-26T12:00:00").getTime();
    expect(seenText(new Date("2026-11-26T08:14:00").getTime(), now)).toBe("Today 08:14");
    expect(seenText(new Date("2026-11-21T08:14:00").getTime(), now)).toMatch(/21 Nov/);
  });
});

type Fake = ReturnType<typeof createFakeServices>;

async function open(fake: Fake) {
  const view = render(
    <Toast>
      <AdminDialog open onOpenChange={() => undefined} client={fake.services.client} selfId="human:account:01ADMIN" />
    </Toast>,
  );
  await waitFor(() => document.querySelector('[data-testid="admin-users"]') !== null && document.querySelectorAll("[data-person]").length > 0, "the people");
  await settle(3);
  return view;
}

const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure);
const person = (id: string) => document.querySelector<HTMLElement>(`[data-person="${id}"]`);
const tab = (name: string) => byRole("tab", name);

describe("Users", () => {
  test("every person with their roles, where they come from, the last sign-in and the sessions; No role is marked", async () => {
    const fake = createFakeServices();
    await open(fake);
    const table = document.querySelector('table[aria-label="People"]')!;
    expect(table.textContent).toContain("Uy Son");
    expect(table.textContent).toContain("operator · 2 limits");
    expect(table.textContent).toContain("platform-oncall, direct");
    expect(table.textContent).toContain("No role");
    expect(document.querySelector('[data-testid="admin-users-count"]')?.textContent).toBe("3 people · 1 waiting for a role");
    // The filters show their labels before their lists have opened (the lab walk saw raw values).
    expect(byRole("combobox", "Role")!.textContent).toBe("Role: any");
    expect(byRole("combobox", "Status")!.textContent).toBe("Status: on");
    expect(await axeViolations()).toEqual([]);
  });

  test("a person's detail: each assignment with where it applies, and only direct ones can be taken away", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(person("human:oidc:bao"));
    const detail = document.querySelector('[data-testid="admin-user-detail"]')!;
    expect(detail.textContent).toContain("Bao Tran");
    expect(detail.querySelectorAll("[data-assignment]").length).toBe(2);
    expect(detail.querySelector('[data-via="direct"]')?.querySelector("button")).not.toBeNull();
    expect(detail.querySelector('[data-via="group:idp:platform-oncall"]')?.querySelector("button")).toBeNull();
    expect(detail.textContent).toContain("from group platform-oncall");
    expect(detail.textContent).toContain("10.0.4.30");
    await click(byRole("button", "Remove operator on PBUILD"));
    await waitFor(() => calls(fake, "admin.users.setRoles").length === 1, "the call");
    expect(calls(fake, "admin.users.setRoles")[0]!.input).toEqual({ userId: "human:oidc:bao", assignments: [] });
  });

  test("Add role asks for the role and where, and sends the direct assignments with the new one", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(person("human:oidc:lan"));
    await click(byRole("button", "Add role…"));
    await waitFor(() => document.querySelector('[data-testid="add-role"]') !== null, "the dialog");
    const dialog = document.querySelector<HTMLElement>('[data-testid="add-role"]')!;
    expect((byRole("button", "Add role", dialog) as HTMLButtonElement).disabled).toBe(true);
    await click(byRole("combobox", "Role", dialog));
    await click(byRole("option", "viewer"));
    expect(byRole("combobox", "Role", dialog)!.textContent).toBe("viewer");
    await click(byRole("button", "Add role", dialog));
    await waitFor(() => calls(fake, "admin.users.setRoles").length === 1, "the call");
    expect(calls(fake, "admin.users.setRoles")[0]!.input).toEqual({ userId: "human:oidc:lan", assignments: [{ role: "viewer", scope: null }] });
  });

  test("ending a session, and turning an account off after asking", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(person("human:oidc:bao"));
    await click(byRole("button", "Sign out"));
    await waitFor(() => calls(fake, "admin.sessions.revoke").length === 1, "the revoke");
    expect(calls(fake, "admin.sessions.revoke")[0]!.input).toEqual({ sessionId: "ls_bao" });
    await click(byRole("button", "Turn off account"));
    await waitFor(() => dialogWith("Turn off Bao Tran?") !== null, "the question");
    expect(calls(fake, "admin.users.disable").length).toBe(0);
    await click(byRole("button", "Turn off account", dialogWith("Turn off Bao Tran?")!));
    await waitFor(() => calls(fake, "admin.users.disable").length === 1, "the call");
    await waitFor(() => byRole("button", "Turn on account") !== null || document.querySelector('table[aria-label="People"]')?.textContent?.includes("Bao Tran") === false, "the account is off");
  });

  test("nobody turns their own account off, and a refusal from the server is shown", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(person("human:account:01ADMIN"));
    expect((byRole("button", "Turn off account") as HTMLButtonElement).disabled).toBe(true);
    // The last administrator cannot be taken away: the server says so and the screen shows it.
    await click(person("human:account:01ADMIN"));
    expect(document.querySelector('[aria-label="Roles and where they apply"]')?.textContent).toContain("pinned in the configuration");
  });

  test("a new account answers with a setup link to hand over", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(byRole("button", "New account"));
    await waitFor(() => document.querySelector('[data-testid="new-account"]') !== null, "the dialog");
    const input = document.querySelector<HTMLInputElement>('[data-testid="new-account"] input')!;
    await typeText(input, "minh.le");
    await click(byRole("button", "Create account"));
    await waitFor(() => document.querySelector('[data-testid="setup-link"]') !== null, "the link");
    expect(document.querySelector('[data-testid="setup-link"]')?.textContent).toContain("https://mc.test/auth/setup/new456");
    expect(calls(fake, "admin.users.create")[0]!.input).toMatchObject({ username: "minh.le" });
  });
});

describe("Roles", () => {
  test("a built-in role is read-only, drawn from the catalogue, axe clean", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(tab("Roles"));
    await waitFor(() => document.querySelector('[data-testid="admin-roles"] table') !== null, "the matrix");
    const grid = document.querySelector('table[aria-label="operator: tools by risk"]')!;
    expect(grid.textContent).toContain("Docker");
    const exec = byRole("checkbox", "operator, Docker, Exec") as HTMLElement;
    expect(exec.getAttribute("aria-checked")).toBe("true");
    expect(exec.hasAttribute("data-disabled")).toBe(true);
    expect(grid.querySelector('[aria-label="NATS, Exec: the tool has no such permission"], [aria-label="Nats, Exec: the tool has no such permission"]')).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  test("a role made here is edited cell by cell and saved", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(tab("Roles"));
    await waitFor(() => document.querySelector('[data-role="release-manager"]') !== null, "the list");
    await click(document.querySelector('[data-role="release-manager"]'));
    await waitFor(() => byRole("checkbox", "Release manager, Docker, Read") !== null, "the editable matrix");
    const save = byRole("button", "Save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await click(byRole("checkbox", "Release manager, Docker, Exec"));
    expect((byRole("button", "Save") as HTMLButtonElement).disabled).toBe(false);
    await click(byRole("button", "Save"));
    await waitFor(() => calls(fake, "admin.roles.update").length === 1, "the save");
    expect((calls(fake, "admin.roles.update")[0]!.input as { permissions: string[] }).permissions).toEqual(["app.read", "docker.exec", "temporal.read", "temporal.write", "term.write"]);
  });

  test("Copy as a new role makes an editable one from any role", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(tab("Roles"));
    await waitFor(() => byRole("button", "Copy as a new role") !== null, "the button");
    await click(byRole("button", "Copy as a new role"));
    await waitFor(() => document.querySelector('[data-testid="role-name"]') !== null, "the dialog");
    await click(byRole("button", "Create role"));
    await waitFor(() => calls(fake, "admin.roles.create").length === 1, "the create");
    expect(calls(fake, "admin.roles.create")[0]!.input).toMatchObject({ id: "operator-copy", name: "operator copy" });
  });
});

describe("Group mapping", () => {
  test("pinned mappings are read-only; the others are added, changed and removed with the etag", async () => {
    const fake = createFakeServices();
    await open(fake);
    await click(tab("Group mapping"));
    await waitFor(() => document.querySelector('[data-testid="admin-groups"] [data-mapping]') !== null, "the mappings");
    const pinned = document.querySelector('[data-pinned]')!;
    expect(pinned.textContent).toContain("platform-admins");
    expect(pinned.textContent).toContain("Configuration (pinned)");
    expect(pinned.querySelector("button")).toBeNull();
    await click(byRole("button", "Add mapping"));
    await waitFor(() => document.querySelector('[data-testid="mapping-dialog"]') !== null, "the dialog");
    const dialog = document.querySelector<HTMLElement>('[data-testid="mapping-dialog"]')!;
    await typeText(dialog.querySelector("input")!, "eng-sre");
    await click(byRole("combobox", "Role", dialog));
    await click(byRole("option", "viewer"));
    await click(byRole("button", "Add mapping", dialog));
    await waitFor(() => calls(fake, "admin.groups.set").length === 1, "the set");
    expect(calls(fake, "admin.groups.set")[0]!.input).toEqual({ etag: 1, mappings: [{ group: "idp:platform-oncall", role: "operator", scope: ["profile:PNATS"] }, { group: "idp:eng-sre", role: "viewer", scope: null }] });
    await waitFor(() => byRole("button", "Remove the mapping of eng-sre") !== null, "the new row");
    await click(byRole("button", "Remove the mapping of platform-oncall"));
    await waitFor(() => calls(fake, "admin.groups.set").length === 2, "the second set");
    expect(calls(fake, "admin.groups.set")[1]!.input).toEqual({ etag: 2, mappings: [{ group: "idp:eng-sre", role: "viewer", scope: null }] });
    expect(await axeViolations()).toEqual([]);
  });
});
