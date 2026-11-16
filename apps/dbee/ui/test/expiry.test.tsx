// Grant expiry in the UI (DBee spec §3.11 flow 4, Decision 9, TSK-23): the badge appears 15
// minutes before, counts down by itself (to the second in the last minute) without anything
// else re-rendering, and turns to "expired"; the messages of an expired grant and of a cut
// statement. Time is faked; nothing sleeps.
import { RpcError } from "@byterygon/ambidex";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ExpiryBadge, expiryPhase } from "@/app/connections/ExpiryBadge";
import { describeError } from "@/app/messages";
import { cleanup, render } from "./support/render";

const NOW = Date.UTC(2026, 10, 16, 12, 0, 0);
const MIN = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const badge = () => document.querySelector<HTMLElement>("[data-expiry-phase]");
const visibleText = () => document.querySelector("[data-expiry-phase] time")?.firstChild?.textContent ?? "";

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("expiryPhase", () => {
  test("is later beyond 15 minutes, soon within, expired at the time", () => {
    expect(expiryPhase(NOW + 15 * MIN + 1, NOW)).toBe("later");
    expect(expiryPhase(NOW + 15 * MIN, NOW)).toBe("soon");
    expect(expiryPhase(NOW + 1, NOW)).toBe("soon");
    expect(expiryPhase(NOW, NOW)).toBe("expired");
  });
});

describe("ExpiryBadge", () => {
  test("shows nothing for a grant that does not expire or expires later than 15 minutes", () => {
    render(<ExpiryBadge expiresAt={null} />);
    expect(badge()).toBeNull();
    cleanup();
    render(<ExpiryBadge expiresAt={NOW + 40 * MIN} />);
    expect(badge()).toBeNull();
  });

  test("appears 15 minutes before expiry without any re-render from outside", async () => {
    render(<ExpiryBadge expiresAt={NOW + 40 * MIN} />);
    await advance(25 * MIN - 1000);
    expect(badge()).toBeNull();
    await advance(1100);
    expect(badge()?.getAttribute("data-expiry-phase")).toBe("soon");
    expect(badge()?.textContent).toMatch(/^expires /);
  });

  test("counts down every second in the last minute, then says expired", async () => {
    render(<ExpiryBadge expiresAt={NOW + 62_000} />);
    expect(badge()?.getAttribute("data-expiry-phase")).toBe("soon");
    await advance(3_000);
    const at59 = visibleText();
    await advance(1_000);
    const at58 = visibleText();
    expect(at59).not.toBe(at58);
    expect(at58).toMatch(/58/);
    await advance(58_000);
    expect(badge()?.getAttribute("data-expiry-phase")).toBe("expired");
    expect(badge()?.textContent).toMatch(/^expired /);
  });

  test("gives the absolute time as hidden text and in a focusable <time>", () => {
    const expiresAt = NOW + 5 * MIN;
    render(<ExpiryBadge expiresAt={expiresAt} />);
    const time = document.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe(new Date(expiresAt).toISOString());
    expect(time.tabIndex).toBe(0);
    expect(time.querySelector(".sr-only")?.textContent).toMatch(/\d/);
  });

  test("an expired grant shows expired, or nothing when the node already says so", () => {
    render(<ExpiryBadge expiresAt={NOW - 2 * MIN} />);
    expect(badge()?.getAttribute("data-expiry-phase")).toBe("expired");
    cleanup();
    render(<ExpiryBadge expiresAt={NOW - 2 * MIN} hideExpired />);
    expect(badge()).toBeNull();
  });

  test("reads the wall clock: after the machine slept past the expiry the next timer shows expired", async () => {
    render(<ExpiryBadge expiresAt={NOW + 10 * MIN} />);
    expect(badge()?.getAttribute("data-expiry-phase")).toBe("soon");
    // The wall clock jumps an hour (sleep); the pending timer fires late and the phase follows
    // the clock, not the count of timer ticks.
    await act(async () => {
      vi.setSystemTime(NOW + 60 * MIN);
      vi.advanceTimersByTime(10 * MIN + 10);
    });
    expect(badge()?.getAttribute("data-expiry-phase")).toBe("expired");
  });
});

const rpc = (code: RpcError["code"], details: unknown) => new RpcError(code, "backend text", { details, correlation_id: "corr-1", local: false });

describe("messages of an expired grant", () => {
  test("a permission error after expiry names the connection's access and the time, with Renew access", () => {
    const d = describeError(rpc("PermissionDenied", { kind: "PermissionDenied", reason: { kind: "Expired", expiredAt: NOW } }), "connect");
    expect(d.title).toMatch(/^Access to this connection expired at /);
    expect(d.remedy).toBe("renewAccess");
    expect(d.remedyLabel).toBe("Renew access");
  });

  test("a statement cut by expiry says it was stopped and its outcome on the database is unknown", () => {
    const d = describeError(rpc("PermissionDenied", { kind: "AccessEnded" }), "run");
    expect(d.title).toMatch(/stopped/);
    expect(d.title).toMatch(/outcome on the database is unknown/);
  });
});
