// Personal and shared profiles (DOC-25 §3.4.2; TSK-135 §8; TSK-140 batch 4b): the choice made when
// a profile is created (only for people who may share, with who it reaches today), and the
// connections pane listing shared profiles first with the two kinds marked.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProfileSheet } from "@/app/dialogs/ProfileDialogs";
import { ConnectionList } from "@/app/sidebar/ConnectionList";
import { audienceOf, audienceText, pane } from "@/app/sharing";
import { Toast } from "@/components/ui/toast";
import type { ProfileRecord } from "@/profiles/record";
import { echoTool } from "@/tools/echo";
import { axeViolations, byRole, byText, cleanup, click, render, type as typeText, waitFor } from "./support/render";

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

const record = (over: Partial<ProfileRecord> & Pick<ProfileRecord, "id" | "name">): ProfileRecord => ({ tool: "echo", version: 1, createdAt: "", updatedAt: "", fields: {}, secrets: {}, extras: {}, ...over });

describe("who a shared profile reaches", () => {
  const roles = [
    { id: "viewer", permissions: ["nats.read", "docker.read"] },
    { id: "operator", permissions: ["nats.read", "nats.write"] },
    { id: "member", permissions: ["app.read"] },
  ];
  const user = (rolesOf: { role: string; scope: string[] | null }[], disabled = false) => ({ disabled, roles: rolesOf.map((r) => ({ ...r, via: "direct" })) });
  test("people whose role holds the tool's read everywhere, not those turned off or limited to some profiles", () => {
    const users = [
      user([{ role: "viewer", scope: null }]),
      user([{ role: "operator", scope: null }]),
      user([{ role: "operator", scope: ["profile:P1"] }]),
      user([{ role: "viewer", scope: null }], true),
      user([{ role: "member", scope: null }]),
    ];
    expect(audienceOf(users, roles, "nats")).toBe(2);
    expect(audienceOf(users, roles, "docker")).toBe(1);
    expect(audienceOf(users, roles, "temporal")).toBe(0);
  });
  test("the words say it in the singular and the plural, and when it is not known", () => {
    expect(audienceText(1, "x")).toContain("Today that is 1 person whose role applies everywhere");
    expect(audienceText(3, "nats-loadtest")).toContain("3 people whose roles apply everywhere; others once an administrator adds nats-loadtest to where their role applies");
    expect(audienceText(0, "")).toContain("adds it to where");
    expect(audienceText(null, "x")).toBe("Everyone whose role covers it connects with it. Administrators edit it and set its secrets; the others connect with it and never see them.");
  });
  test("the pane lists shared profiles first, then personal ones, each by name", () => {
    const list = [record({ id: "1", name: "b" }), record({ id: "2", name: "z", owner: { kind: "shared" } }), record({ id: "3", name: "a" }), record({ id: "4", name: "m", owner: { kind: "shared" } })];
    expect(pane(list).map((p) => p.name)).toEqual(["m", "z", "a", "b"]);
  });
});

describe("the sheet's choice", () => {
  const open = async (props: { canShare?: boolean; audience?: number | null }) => {
    const onSave = vi.fn(async () => undefined);
    render(
      <Toast>
        <ProfileSheet open onOpenChange={() => undefined} tool={echoTool} mode="add" takenNames={new Set()} onSave={onSave} {...props} />
      </Toast>,
    );
    await waitFor(() => document.querySelector("#profile-form") !== null, "the sheet");
    return onSave;
  };

  test("a person who may not share is not asked: every profile they make is personal", async () => {
    const onSave = await open({ canShare: false });
    expect(document.querySelector('[data-testid="who-can-use"]')).toBeNull();
    await typeText(document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!, "mine");
    await click(byRole("button", "Save"));
    await waitFor(() => onSave.mock.calls.length === 1, "the save");
    expect((onSave.mock.calls[0] as unknown as [ProfileRecord, { shared: boolean }])[1].shared).toBe(false);
  });

  test("an administrator chooses Only me or Everyone, told who that reaches today, and that it is chosen once", async () => {
    const onSave = await open({ canShare: true, audience: 3 });
    const group = document.querySelector<HTMLElement>('[data-testid="who-can-use"]')!;
    expect(group.textContent).toContain("Only me (personal)");
    expect(group.textContent).toContain("Personal or shared is chosen once");
    expect(document.querySelector('[data-testid="audience"]')?.textContent).toContain("Today that is 3 people whose roles apply everywhere");
    const radios = [...group.querySelectorAll<HTMLElement>('[role="radio"]')];
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(await axeViolations()).toEqual([]);
    await click(radios[1]!);
    await typeText(document.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')!, "shared-one");
    await click(byRole("button", "Save"));
    await waitFor(() => onSave.mock.calls.length === 1, "the save");
    expect((onSave.mock.calls[0] as unknown as [ProfileRecord, { shared: boolean }])[1].shared).toBe(true);
  });

  test("editing a shared profile says so in the title and offers no choice", async () => {
    render(
      <Toast>
        <ProfileSheet open onOpenChange={() => undefined} tool={echoTool} mode="edit" base={record({ id: "S", name: "team-echo", owner: { kind: "shared" } })} takenNames={new Set()} canShare onSave={vi.fn(async () => undefined)} />
      </Toast>,
    );
    await waitFor(() => document.querySelector("#profile-form") !== null, "the sheet");
    expect(document.querySelector('[data-testid="who-can-use"]')).toBeNull();
    expect(byText("shared")).not.toBeNull();
  });
});

describe("the pane", () => {
  const list = (profiles: ProfileRecord[]) =>
    render(
      <ConnectionList
        tool={echoTool}
        profiles={profiles}
        recordStates={{}}
        conns={{}}
        selected={null}
        onSelect={() => undefined}
        onConnect={async () => true}
        onDisconnect={() => undefined}
        onOpenResource={() => undefined}
        onAdd={() => undefined}
        onImport={() => undefined}
        onEdit={() => undefined}
        onDuplicate={() => undefined}
        onExport={() => undefined}
        onDelete={() => undefined}
        onUpdateProfile={async () => undefined}
      />,
    );

  test("shared profiles come first and are marked; a personal one has the person icon; another person's is named as theirs", async () => {
    list([
      record({ id: "1", name: "my-echo", access: "owner", owner: { kind: "personal" } }),
      record({ id: "2", name: "team-echo", access: "use", owner: { kind: "shared" } }),
      record({ id: "3", name: "bao-echo", access: "metadata", owner: { kind: "personal", user: "human:oidc:bao" } }),
    ]);
    await waitFor(() => document.querySelectorAll("[data-profile-id]").length === 3, "the rows");
    const ids = [...document.querySelectorAll<HTMLElement>("[data-profile-id]")].map((n) => n.dataset["profileId"]);
    expect(ids).toEqual(["2", "3", "1"]);
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-profile-id="${id}"]`)!;
    expect(row("2").textContent).toContain("Shared");
    expect(row("1").querySelector('[data-owner="personal"]')).not.toBeNull();
    expect(row("3").textContent).toContain("Personal");
    expect(row("3").querySelector('[data-owner="personal"]')).toBeNull();
  });

  test("the empty state no longer says the browser keeps profiles", async () => {
    list([]);
    expect(byText(/Connections are kept on the server/)).not.toBeNull();
  });
});
