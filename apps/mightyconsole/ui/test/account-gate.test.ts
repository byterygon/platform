// A session that must change its password or set up TOTP does that before the app (DOC-25 §3.2.6).
import { describe, expect, it } from "vitest";
import { type GateApi, accountGate } from "@/app/account-gate";
import type { Me } from "@/gen/api";

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function fill(root: HTMLElement, values: string[]): void {
  root.querySelectorAll("input").forEach((input, i) => (input.value = values[i] ?? ""));
  root.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
}

describe("accountGate", () => {
  it("lets the app start when nothing is due", async () => {
    expect(await accountGate(document.createElement("div"), api({}, []))).toBe(true);
  });

  it("asks for a new password first, and checks the two match", async () => {
    const root = document.createElement("div");
    const calls: string[] = [];
    let done = 0;
    expect(await accountGate(root, api({ mustChangePassword: true }, calls), () => done++)).toBe(false);
    expect(root.textContent).toContain("Choose a new password");
    fill(root, ["generated", "new passphrase one", "new passphrase two"]);
    expect(root.querySelector('[role="alert"]')?.textContent).toBe("The two new passwords differ.");
    fill(root, ["wrong", "new passphrase one", "new passphrase one"]);
    await flush();
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("wrong");
    fill(root, ["generated", "new passphrase one", "new passphrase one"]);
    await flush();
    expect(calls).toEqual(["change wrong new passphrase one", "change generated new passphrase one"]);
    expect(done).toBe(1);
  });

  it("sets up TOTP and shows the recovery codes once", async () => {
    const root = document.createElement("div");
    const calls: string[] = [];
    let done = 0;
    expect(await accountGate(root, api({ mustEnrolTotp: true }, calls), () => done++)).toBe(false);
    root.querySelector("button")!.click();
    await flush();
    const image = root.querySelector("img")!;
    expect(image.getAttribute("src")).toMatch(/^data:image\/svg\+xml;charset=utf-8,/);
    expect(root.textContent).toContain("otpauth://totp/");
    fill(root, [" 123456 "]);
    await flush();
    expect(calls).toEqual(["confirm 123456"]);
    expect(root.textContent).toContain("AAAAA-BBBBB");
    root.querySelector("button")!.click();
    expect(done).toBe(1);
  });
});
