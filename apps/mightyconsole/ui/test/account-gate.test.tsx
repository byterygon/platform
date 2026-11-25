// What a signed-in session must do before the app (DOC-25 §3.2.6, §3.2.3): change a generated
// password, set up two-step sign-in, or ask for a role. The pages are Byterygon UI; axe in both themes.
import { afterEach, describe, expect, it } from "vitest";
import { Gate, type GateApi, gateDecision } from "@/app/account-gate";
import type { Me } from "@/gen/api";
import { act, axeViolations, byRole, cleanup, click, render, settle, type } from "./support/render";

afterEach(() => cleanup());

const ME: Me = {
  user: "human:account:01A",
  session: "ls_x",
  method: "password",
  account: true,
  username: "admin",
  displayName: "Administrator",
  totp: false,
  mustChangePassword: false,
  mustEnrolTotp: false,
  idleExpiresMs: 0,
  absoluteExpiresMs: 0,
  email: null,
  tenant: "default",
  roles: [{ role: "admin", scope: null, via: "pinned" }],
  permissions: [],
};

function api(me: Partial<Me>, calls: string[]): GateApi {
  return {
    me: async () => ({ ...ME, ...me }),
    changePassword: async (current, next) => {
      calls.push(`change ${current} ${next}`);
      if (current === "wrong") throw new Error("the current password is wrong");
    },
    totpBegin: async () => ({ uri: "otpauth://totp/Mightyconsole:admin?secret=AAAA", qrSvg: "<svg></svg>" }),
    totpConfirm: async (code) => {
      calls.push(`confirm ${code}`);
      return { codes: ["AAAAA-BBBBB", "CCCCC-DDDDD"] };
    },
  };
}

const input = (name: string) => document.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const submit = async () => {
  await act(async () => {
    document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await settle(2);
};

describe("gateDecision", () => {
  it("lets the app start when nothing is due", () => {
    expect(gateDecision(ME)).toBe("ready");
  });
  it("asks for the password first, then the second factor, then a role", () => {
    expect(gateDecision({ ...ME, mustChangePassword: true, mustEnrolTotp: true })).toBe("changePassword");
    expect(gateDecision({ ...ME, mustEnrolTotp: true })).toBe("enrolTotp");
    expect(gateDecision({ ...ME, roles: [], permissions: [] })).toBe("noRole");
    expect(gateDecision({ ...ME, roles: [], permissions: [{ perm: "nats.read", everywhere: true, scope: [] }] })).toBe("ready");
  });
});

describe("the gate's pages", () => {
  it("asks for a new password first, and checks the two match", async () => {
    const calls: string[] = [];
    let done = 0;
    render(<Gate api={api({ mustChangePassword: true }, calls)} me={{ ...ME, mustChangePassword: true }} done={() => done++} signOut={() => {}} />);
    expect(document.querySelector("h1")?.textContent).toBe("Choose a new password");
    expect(document.activeElement).toBe(input("current"));
    await type(input("current"), "generated");
    await type(input("new"), "new passphrase one");
    await type(input("again"), "new passphrase two");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe("The two new passwords differ.");
    await type(input("current"), "wrong");
    await type(input("again"), "new passphrase one");
    await submit();
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("wrong");
    await type(input("current"), "generated");
    await submit();
    expect(calls).toEqual(["change wrong new passphrase one", "change generated new passphrase one"]);
    expect(done).toBe(1);
  });

  it("sets up TOTP and shows the recovery codes once", async () => {
    const calls: string[] = [];
    let done = 0;
    render(<Gate api={api({}, calls)} me={{ ...ME, mustEnrolTotp: true }} done={() => done++} signOut={() => {}} />);
    await click(byRole("button", "Show the code to scan"));
    const image = document.querySelector("img")!;
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(document.body.textContent).toContain("otpauth://totp/");
    await type(input("code"), " 123456 ");
    await submit();
    expect(calls).toEqual(["confirm 123456"]);
    expect(document.querySelector("ul")?.textContent).toContain("AAAAA-BBBBB");
    await click(byRole("button", /I have kept them/));
    expect(done).toBe(1);
  });

  it("a person with no role sees who to ask, can copy the request, check again and sign out", async () => {
    let done = 0;
    let out = 0;
    let granted = false;
    const copied: string[] = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t: string) => void copied.push(t) } });
    const noRole: Me = { ...ME, roles: [], permissions: [], displayName: "Lan Pham", email: "lan.pham@corp.example" };
    const gate: GateApi = { ...api({}, []), me: async () => (granted ? ME : noRole) };
    render(<Gate api={gate} me={noRole} done={() => done++} signOut={() => out++} />);
    expect(document.querySelector("h1")?.textContent).toContain("no role here yet");
    expect(document.body.textContent).toContain("lan.pham@corp.example");
    await click(byRole("button", /Copy access request/));
    await settle();
    expect(copied[0]).toContain("Name: Lan Pham");
    expect(copied[0]).toContain("User: human:account:01A");
    await click(byRole("button", "Check again"));
    await settle();
    expect(done).toBe(0);
    granted = true;
    await click(byRole("button", "Check again"));
    await settle();
    expect(done).toBe(1);
    await click(byRole("button", "Sign out"));
    expect(out).toBe(1);
  });

  it.each(["light", "dark"] as const)("each page is clean in %s", async (theme) => {
    for (const me of [{ ...ME, mustChangePassword: true }, { ...ME, mustEnrolTotp: true }, { ...ME, roles: [], permissions: [] }]) {
      const view = render(<Gate api={api({}, [])} me={me} done={() => {}} signOut={() => {}} />, { theme });
      await settle();
      expect(await axeViolations(view.container)).toEqual([]);
      view.unmount();
    }
  });
});
