// Secrets, written and never read back (DOC-25 §3.4.7, §3.4.8; TSK-135 §7; TSK-140 batch 4a): the
// one control every tool's profile form uses (Set with who and when, Replace…, Remove with its
// confirmation, Escape cancelling a replacement), and the warning that a changed target takes the
// stored secrets with it.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProfileSheet } from "@/app/dialogs/ProfileDialogs";
import { Toast } from "@/components/ui/toast";
import type { ProfileRecord } from "@/profiles/record";
import { natsTool } from "@/tools/nats";
import { SecretControl, SecretsProvider, useSecretsState, useShownSecrets, whenText, whoText } from "@/app/secret-control";
import { TARGET_GROUPS, secretsLostByTarget } from "@/profiles/targets";
import { browserKey } from "@/profiles/server";
import { axeViolations, byRole, cleanup, click, key, render, settle, type as typeText, waitFor } from "./support/render";

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

describe("what a changed target takes", () => {
  const stored = new Set(["password", "token", "clientKeyPem", "apiKey"]);
  test("a changed target field removes the secrets of its group, less those typed again", () => {
    expect(secretsLostByTarget("nats", { servers: ["a"] }, { servers: ["b"] }, stored, new Set())).toEqual(["password", "token", "clientKeyPem"]);
    expect(secretsLostByTarget("nats", { servers: ["a"] }, { servers: ["b"] }, stored, new Set(["password"]))).toEqual(["token", "clientKeyPem"]);
    expect(secretsLostByTarget("nats", { servers: ["a"], tls: { caPem: "x" } }, { servers: ["a"], tls: { caPem: "y" } }, stored, new Set())).toContain("password");
  });
  test("a field that is not a target, or an unchanged one, takes nothing", () => {
    expect(secretsLostByTarget("nats", { servers: ["a"], requestTimeoutMs: 1 }, { servers: ["a"], requestTimeoutMs: 2 }, stored, new Set())).toEqual([]);
    expect(secretsLostByTarget("echo", { greeting: "a" }, { greeting: "b" }, new Set(["token"]), new Set())).toEqual([]);
  });
  test("the groups of a tool are separate: the codec's secret survives a changed address", () => {
    const lost = secretsLostByTarget("temporal", { address: "a" }, { address: "b" }, new Set(["apiKey", "codecAuthorization"]), new Set());
    expect(lost).toEqual(["apiKey"]);
  });
  test("a changed route takes every stored secret of the tool", () => {
    expect(secretsLostByTarget("langgraph", { url: "u", routeId: "r1" }, { url: "u", routeId: "r2" }, new Set(["apiKey", "headerLines"]), new Set())).toEqual(["apiKey", "headerLines"]);
  });
  test("the groups match the server's spec (server/src/profiles/spec.rs)", () => {
    const rust = readFileSync(resolve(process.cwd(), "../server/src/profiles/spec.rs"), "utf8");
    // Each tool's `groups:` block, in the order the file lists the tools.
    const tools = [...rust.matchAll(/tool: "(\w+)",[\s\S]*?(?=\n    ToolSpec \{|\n\];)/g)];
    expect(tools.length).toBe(5);
    for (const [block, tool] of tools.map((m) => [m[0], m[1]!] as const)) {
      const groups = [...block.matchAll(/TargetGroup \{\s*targets: &\[([\s\S]*?)\],\s*secrets: &\[([\s\S]*?)\],\s*\}/g)].map((g) => ({
        targets: [...g[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!),
        secrets: [...g[2]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!),
      }));
      expect(TARGET_GROUPS[tool], tool).toEqual(groups);
    }
  });
  test("a secret's key in the form is the browser's key", () => {
    expect(browserKey("nats", "tls.clientKeyPem")).toBe("clientKeyPem");
  });
});

describe("the words", () => {
  test("who and when", () => {
    expect(whoText("human:oidc:bao", "human:account:01ADMIN")).toBe("oidc:bao");
    expect(whoText("human:account:01ADMIN", "human:account:01ADMIN")).toBe("you");
    expect(whenText(new Date(2026, 10, 12, 14, 2).getTime())).toBe("12 Nov, 14:02");
  });
});

function Harness({ stored = ["password"], info = { password: { setBy: "human:account:01ADMIN", setAt: new Date(2026, 10, 12, 14, 2).getTime() } }, lost = [], multiline = false }: { stored?: string[]; info?: Record<string, { setBy: string; setAt: number }>; lost?: string[]; multiline?: boolean }) {
  const [value, setValue] = useState("");
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const { shown } = useShownSecrets();
  const state = useSecretsState({
    stored: new Set(stored.filter((k) => !removed.has(k))),
    info,
    removed,
    self: "human:account:01ADMIN",
    lost: new Set(lost),
    shown,
    remove: (k) => setRemoved((r) => new Set([...r, k])),
    keep: (k) => setRemoved((r) => new Set([...r].filter((x) => x !== k))),
  });
  return (
    <SecretsProvider value={state}>
      <SecretControl secretKey="password" noun="password" value={value} onValueChange={setValue} multiline={multiline} />
      <output data-testid="typed">{value}</output>
    </SecretsProvider>
  );
}

const control = () => document.querySelector<HTMLElement>('[data-secret="password"]')!;

describe("the control", () => {
  test("a stored secret reads Set, who set it and when; no field, no value", async () => {
    render(<Harness />);
    expect(control().dataset["state"]).toBe("set");
    expect(control().textContent).toContain("Set by you on 12 Nov, 14:02");
    expect(control().querySelector("input, textarea")).toBeNull();
    expect(byRole("button", "Replace the password")).not.toBeNull();
    expect(byRole("button", "Remove the password")).not.toBeNull();
  });

  test("Replace… opens an empty field with focus in it, Escape cancels it and keeps the old secret", async () => {
    render(<Harness />);
    await click(byRole("button", "Replace the password"));
    expect(control().dataset["state"]).toBe("replacing");
    const field = control().querySelector<HTMLInputElement>("input")!;
    expect(field.value).toBe("");
    expect(document.activeElement).toBe(field);
    await typeText(field, "n3w");
    expect(document.querySelector('[data-testid="typed"]')?.textContent).toBe("n3w");
    await key("Escape", {}, field);
    await settle(2);
    expect(control().dataset["state"]).toBe("set");
    expect(document.querySelector('[data-testid="typed"]')?.textContent).toBe("");
  });

  test("a typed replacement stays replacing while it has text; Cancel clears it", async () => {
    render(<Harness />);
    await click(byRole("button", "Replace the password"));
    await typeText(control().querySelector<HTMLInputElement>("input")!, "x");
    expect(control().dataset["state"]).toBe("replacing");
    await click([...control().querySelectorAll("button")].find((b) => b.textContent === "Cancel") ?? null);
    expect(control().dataset["state"]).toBe("set");
  });

  test("Remove asks first; confirming marks the secret removed on save, Keep it undoes that", async () => {
    render(<Harness />);
    await click(byRole("button", "Remove the password"));
    await waitFor(() => document.body.textContent?.includes("Remove the password?") === true, "the question");
    expect(document.body.textContent).toContain("Connections stop working until it is set again");
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Remove" && !b.hasAttribute("aria-label")) ?? null);
    await waitFor(() => control().dataset["state"] === "removed", "the removal");
    expect(control().textContent).toContain("Removed when you save");
    expect(control().textContent).toContain("it was set by you on 12 Nov, 14:02");
    await click(byRole("button", "Keep it"));
    expect(control().dataset["state"]).toBe("set");
  });

  test("Cancel in the question leaves the secret as it is", async () => {
    render(<Harness />);
    await click(byRole("button", "Remove the password"));
    await waitFor(() => document.body.textContent?.includes("Remove the password?") === true, "the question");
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel") ?? null);
    await settle(2);
    expect(control().dataset["state"]).toBe("set");
  });

  test("a secret the server does not hold is the field itself, with Not set beside it", async () => {
    render(<Harness stored={[]} />);
    expect(control().dataset["state"]).toBe("unset");
    expect(control().querySelector("input")).not.toBeNull();
    expect(control().textContent).toContain("Not set");
  });

  test("a secret lost to a changed target says to enter it again", async () => {
    render(<Harness stored={[]} lost={["password"]} />);
    expect(control().textContent).toContain("the target changed, enter it again");
  });

  test("a multi-line secret is a text area", async () => {
    render(<Harness stored={[]} multiline />);
    expect(control().querySelector("textarea")).not.toBeNull();
  });

  test("outside a sheet it is the plain field", async () => {
    render(<SecretControl secretKey="x" value="" onValueChange={() => undefined} />);
    expect(document.querySelector("input")).not.toBeNull();
    expect(document.querySelector("[data-secret]")).toBeNull();
  });
});

describe("the profile sheet", () => {
  const base = (): ProfileRecord => ({
    id: "P1",
    tool: "nats",
    version: 1,
    name: "nats-prod",
    createdAt: "",
    updatedAt: "",
    fields: { servers: ["nats://a:4222"], auth: "userPassword", user: "orders-svc" },
    secrets: {},
    extras: {},
    storedSecrets: ["password"],
    secretInfo: { password: { setBy: "human:account:01ADMIN", setAt: new Date(2026, 10, 12, 14, 2).getTime() } },
  });
  const open = async (onSave = vi.fn(async () => undefined)) => {
    render(
      <Toast>
        <ProfileSheet open onOpenChange={() => undefined} tool={natsTool} base={base()} mode="edit" takenNames={new Set()} self="human:account:01ADMIN" onSave={onSave} />
      </Toast>,
    );
    await waitFor(() => document.querySelector('[data-secret="password"]') !== null, "the sheet");
    return onSave;
  };

  test("the password reads Set, by you; changing the servers warns that it goes, and entering it again clears the warning", async () => {
    await open();
    expect(document.querySelector('[data-secret="password"]')?.textContent).toContain("Set by you on 12 Nov, 14:02");
    expect(document.querySelector('[data-testid="secrets-lost"]')).toBeNull();
    expect(await axeViolations()).toEqual([]);
    const servers = document.querySelector<HTMLTextAreaElement>("textarea")!;
    await typeText(servers, "nats://b:4222");
    await waitFor(() => document.querySelector('[data-testid="secrets-lost"]') !== null, "the warning");
    expect(document.querySelector('[data-testid="secrets-lost"]')?.textContent).toContain("Saving removes the stored password");
    expect(document.querySelector('[data-secret="password"]')?.textContent).toContain("Set");
    await click(byRole("button", "Replace the password"));
    await typeText(document.querySelector<HTMLInputElement>('[data-secret="password"] input')!, "again");
    await waitFor(() => document.querySelector('[data-testid="secrets-lost"]') === null, "the warning to go");
  });

  test("Save sends what was typed and the secrets removed, never a stored value", async () => {
    const onSave = await open();
    await click(byRole("button", "Remove the password"));
    await waitFor(() => document.body.textContent?.includes("Remove the password?") === true, "the question");
    await click([...document.querySelectorAll("button")].find((b) => b.textContent === "Remove" && !b.hasAttribute("aria-label")) ?? null);
    await click(byRole("button", "Save"));
    await waitFor(() => onSave.mock.calls.length === 1, "the save");
    const [record, options] = onSave.mock.calls[0] as unknown as [ProfileRecord, { remove: string[] }];
    expect(options.remove).toEqual(["password"]);
    expect(record.secrets).toEqual({});
    expect(record.storedSecrets).toEqual([]);
  });
});
