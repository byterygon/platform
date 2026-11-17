// Small units: the supervisor's states, key matching of spec §3.4, the CSRF meta, live texts.
import { RpcError } from "@byterygon/ambidex";
import { describe, expect, test } from "vitest";
import { readCsrf } from "@/app/client";
import { describeError, remedyOf } from "@/app/messages";
import { ACTIONS, actionFor, matchesBinding } from "@/app/shortcuts";
import { liveText } from "@/app/states";
import { Supervisor, defaultBackoff, type ServerStatus } from "@/app/supervisor";

const keydown = (key: string, init: KeyboardEventInit = {}) => new KeyboardEvent("keydown", { key, ...init });

describe("keys (spec §3.4)", () => {
  test("bindings match by key or by code, modifiers exactly", () => {
    expect(matchesBinding(keydown("k", { ctrlKey: true }), "Mod+K", false)).toBe(true);
    expect(matchesBinding(keydown("k", { metaKey: true }), "Mod+K", true)).toBe(true);
    expect(matchesBinding(keydown("k", { ctrlKey: true, shiftKey: true }), "Mod+K", false)).toBe(false);
    // Alt+Shift+1 types "!" (or "¡" with Alt on macOS): the code decides.
    expect(matchesBinding(keydown("!", { altKey: true, shiftKey: true, code: "Digit1" }), "Alt+Shift+1", false)).toBe(true);
    expect(matchesBinding(keydown("}", { altKey: true, shiftKey: true, code: "BracketRight" }), "Alt+Shift+]", false)).toBe(true);
    expect(matchesBinding(keydown("Escape", { shiftKey: true }), "Shift+Escape", false)).toBe(true);
    expect(matchesBinding(keydown("F6"), "F6", false)).toBe(true);
    expect(actionFor(keydown("W", { altKey: true, shiftKey: true, code: "KeyW" }), false)?.id).toBe("closeTab");
    // The palette and the sidebar toggle belong to their components.
    expect(actionFor(keydown("k", { ctrlKey: true }), false)).toBeUndefined();
    expect(actionFor(keydown("b", { ctrlKey: true }), false)).toBeUndefined();
  });

  test("no two actions share a binding", () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      for (const k of a.keys) {
        expect(seen.get(k), `${a.id} and ${seen.get(k)} share ${k}`).toBeUndefined();
        seen.set(k, a.id);
      }
    }
  });
});

describe("supervisor (spec §2.2, §3.5)", () => {
  function client(script: { info: () => Promise<unknown>; events: () => AsyncIterable<unknown> & { unsubscribe(): void } }) {
    return { app: { info: script.info, events: script.events } } as never;
  }

  test("a lost subscription retries with backoff and reports the reconnect; VersionMismatch stops", async () => {
    const statuses: ServerStatus[] = [];
    let reconnected = 0;
    let infos = 0;
    let subscriptions = 0;
    const sup = new Supervisor(
      client({
        info: async () => {
          infos++;
          if (infos === 2) throw new RpcError("Unavailable", "down", { local: true });
          if (infos === 4) throw new RpcError("VersionMismatch", "new server");
          return { version: "0.1.0" };
        },
        events: () => {
          subscriptions++;
          return {
            unsubscribe() {},
            async *[Symbol.asyncIterator]() {
              yield { kind: "TerminalExit", terminalId: "t", reason: "x" };
              throw new RpcError("Unavailable", "closed", { local: true });
            },
          };
        },
      }),
      { status: (s) => statuses.push(s), info: () => {}, event: () => {}, reconnected: () => reconnected++ },
      { backoffMs: () => 1 },
    );
    await sup.run();
    expect(statuses).toEqual(["connecting", "online", "lost", "lost", "online", "lost", "versionMismatch"]);
    expect(reconnected).toBe(1);
    expect(subscriptions).toBe(2);
    expect(defaultBackoff(0)).toBe(500);
    expect(defaultBackoff(10)).toBe(10_000);
  });
});

describe("messages and states", () => {
  test("errors carry the ToolError kind, the remote code and the remedy", () => {
    const d = describeError(new RpcError("Unauthenticated", "the token was rejected", { correlation_id: "c-1", details: { kind: "Auth", system: "echo", message: "x", retryable: false, remote: { code: "401" } } }));
    expect(d).toMatchObject({ title: "the token was rejected", code: "Unauthenticated", correlationId: "c-1", kind: "Auth", remoteCode: "401" });
    expect(remedyOf(d)).toBe("editProfile");
    expect(remedyOf({ title: "x", kind: "Connect" })).toBe("retry");
    expect(remedyOf({ title: "x", kind: "NotFound" })).toBe("refresh");
    expect(describeError(new Error("boom"))).toEqual({ title: "boom" });
  });

  test("live texts read as the spec's status bar", () => {
    expect(liveText({ status: "live", ratePerSec: 1240, dropped: 3 })).toMatch(/^Live · 1.240 msg\/s · 3 dropped$/);
    expect(liveText({ status: "paused", buffered: 10_000 })).toMatch(/^Paused · 10.000 buffered$/);
    expect(liveText({ status: "ended", reason: "lost the connection to the server" })).toBe("Ended: lost the connection to the server");
  });

  test("the CSRF token comes from the server's meta", () => {
    expect(readCsrf()).toBeNull();
    const meta = document.createElement("meta");
    meta.name = "mightyconsole-csrf";
    meta.content = "ab12";
    document.head.append(meta);
    expect(readCsrf()).toBe("ab12");
    meta.remove();
  });
});
