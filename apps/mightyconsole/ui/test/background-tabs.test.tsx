// Tabs in the background (DOC-21 §3.2, TSK-107): a tab that is not the active one does no work for
// display (no pull and so no credit for a live tail, no chunk read for a followed history, no clock,
// no refresh), keeps its stream, and catches up with the same rows when it is shown again.
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { type ReactNode, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MightyClient } from "@/app/client";
import { ProgressBus } from "@/app/progress";
import { createGate, useActiveClock, useActiveInterval } from "@/app/while-active";
import type { LastPosition, TailSummary } from "@/gen/api";
import { MessageViewer } from "@/messaging/MessageViewer";
import { useLiveTail } from "@/messaging/useLiveTail";
import { useDockerEvents } from "@/tools/docker/live";
import { messageCall, messageTable, type TestMessage } from "./support/messages";
import { fake as monaco } from "../../../../packages/ui/test/fakes/monaco.ts";
import { act, byRole, byText, cleanup, click, render, waitFor } from "./support/render";

void monaco;
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const wait = (ms: number) => act(async () => new Promise<void>((r) => setTimeout(r, ms)));

describe("createGate", () => {
  test("a reader waits while hidden and every waiting reader goes on when shown", async () => {
    const gate = createGate(false);
    const order: string[] = [];
    const a = gate.idle().then(() => order.push("a"));
    const b = gate.idle().then(() => order.push("b"));
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.set(true);
    await Promise.all([a, b]);
    expect(order).toEqual(["a", "b"]);
    // Open: no wait at all.
    await gate.idle();
    expect(gate.active).toBe(true);
  });
});

function Probe({ active, on, ms = 1000, enabled = true }: { active: boolean; on(): void; ms?: number; enabled?: boolean }) {
  useActiveInterval(on, ms, active, enabled);
  return null;
}

function Clock({ active, running }: { active: boolean; running: boolean }) {
  const now = useActiveClock(active, running);
  return <output data-testid="clock">{now}</output>;
}

/** A host whose tab is shown or hidden from the test (no clicks: the timers here are fake). */
function Host({ children }: { children(active: boolean): ReactNode }) {
  const [active, setActive] = useState(false);
  show = (on) => act(() => setActive(on));
  return <>{children(active)}</>;
}
let show: (on: boolean) => void = () => {};

describe("useActiveInterval and useActiveClock", () => {
  test("no tick while hidden; one at once when shown, then every period", async () => {
    vi.useFakeTimers();
    const on = vi.fn();
    render(<Host>{(active) => <Probe active={active} on={on} />}</Host>);
    // A tab that starts hidden does not tick.
    await act(async () => vi.advanceTimersByTime(10_000));
    expect(on).not.toHaveBeenCalled();
    show(true);
    // Shown: what loaded while hidden may be old, so one call at once; then every period.
    expect(on).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTime(3100));
    expect(on).toHaveBeenCalledTimes(4);
    // Hidden for a long time: nothing in between, one call at once when shown.
    show(false);
    on.mockClear();
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(on).not.toHaveBeenCalled();
    show(true);
    expect(on).toHaveBeenCalledTimes(1);
  });

  test("disabled: no tick shown or hidden", async () => {
    vi.useFakeTimers();
    const on = vi.fn();
    render(<Host>{(active) => <Probe active={active} on={on} enabled={false} />}</Host>);
    show(true);
    await act(async () => vi.advanceTimersByTime(5000));
    show(false);
    show(true);
    expect(on).not.toHaveBeenCalled();
  });

  test("the clock stands still in the background and is fresh when shown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-22T10:00:00Z"));
    render(<Host>{(active) => <Clock active={active} running />}</Host>);
    const shown = () => Number(document.querySelector("[data-testid=clock]")!.textContent);
    show(true);
    await act(async () => vi.advanceTimersByTime(2000));
    const at = shown();
    expect(at).toBe(Date.parse("2026-11-22T10:00:02Z"));
    show(false);
    await act(async () => vi.advanceTimersByTime(30_000));
    expect(shown()).toBe(at);
    show(true);
    expect(shown()).toBe(Date.parse("2026-11-22T10:00:32Z"));
  });
});

// ---- A live tail ------------------------------------------------------------------------------

const summary = (patch: Partial<TailSummary> = {}): TailSummary => ({ scanned: 0, matched: 0, dropped: 0, decodeErrors: 0, endReason: "end", lastPositions: [], ...patch });
const services = { decoder: inThreadArrowDecoder(), progress: new ProgressBus() };
const note = (e: unknown) => ({ title: e instanceof Error ? e.message : String(e) });

describe("a live tail in the background", () => {
  function Tab({ open, onLive }: { open: (id: string, resume: readonly LastPosition[] | null) => ReturnType<typeof messageCall>["call"]; onLive?: (l: unknown) => void }) {
    const [active, setActive] = useState(true);
    const tail = useLiveTail(services, open as never, note, onLive as never, active);
    return (
      <>
        <button onClick={() => setActive((a) => !a)}>{active ? "Hide" : "Show"}</button>
        <MessageViewer system="kafka" tail={tail} onLoadFull={null} loadSchema={async () => ""} />
      </>
    );
  }

  const many = Array.from({ length: 2000 }, (_, i): TestMessage => ({ partition: 0, offset: BigInt(i), value: `{"n":${i}}` }));

  test("pulls nothing while hidden, stays live, and shows every row after it is shown", async () => {
    const built = messageCall(messageTable(many, 100), summary(), { endless: true, delayMs: 20 });
    const lives: unknown[] = [];
    render(<Tab open={() => built.call} onLive={(l) => lives.push(l)} />);
    await click(byRole("button", /^(Start|Restart)$/));
    await waitFor(() => built.state.pulled > 2, "the first chunks");
    await click(byRole("button", "Hide"));
    // A pull already in flight may land; after that, no credit goes back to the server.
    await wait(120);
    const hidden = built.state.pulled;
    await wait(300);
    expect(built.state.pulled).toBe(hidden);
    expect(hidden).toBeLessThan(built.chunks);
    // Not stopped, not cancelled and still live: the dot stays.
    expect(built.state.cancelled).toBe(false);
    expect(lives[lives.length - 1]).toMatchObject({ status: "live" });
    await click(byRole("button", "Show"));
    await waitFor(() => built.state.pulled === built.chunks, "every chunk after it is shown");
    await waitFor(() => byText("2,000 records shown") !== null, "all the rows, as if it had never been hidden");
    await click(byRole("button", "Stop"));
  });

  test("the server's counters wait while hidden and are shown when the tab is", async () => {
    const built = messageCall(messageTable(many, 100), summary(), { endless: true, delayMs: 5 });
    let streamId = "";
    render(
      <Tab
        open={(id) => {
          streamId = id;
          return built.call;
        }}
      />,
    );
    await click(byRole("button", /^(Start|Restart)$/));
    await waitFor(() => streamId !== "", "the stream");
    await click(byRole("button", "Hide"));
    await act(async () => services.progress.publish({ kind: "StreamProgress", streamId, scanned: 7, matched: 7, dropped: 0, decodeErrors: 0, ratePerSec: 500, bytesPerSec: 1 } as never));
    expect(byText(/scanned 7/)).toBeNull();
    await click(byRole("button", "Show"));
    await waitFor(() => byText(/scanned 7/) !== null, "the counters after it is shown");
    await click(byRole("button", "Stop"));
  });
});

// ---- The Docker events a screen listens to ---------------------------------------------------

describe("Docker events in the background", () => {
  function Events({ client, active, seen }: { client: MightyClient; active: boolean; seen: string[] }) {
    useDockerEvents({ client, connId: "c1", active, onEvent: (e) => seen.push(e.action) });
    return null;
  }
  function eventStream() {
    const queue: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    let cancelled = false;
    const state = { pulled: 0 };
    const call = {
      result: new Promise<never>(() => {}),
      cancel: () => {
        cancelled = true;
        wake?.();
      },
      async *chunks() {
        for (;;) {
          const next = queue.shift();
          if (next) {
            state.pulled += 1;
            yield next;
            continue;
          }
          if (cancelled) return;
          await new Promise<void>((r) => (wake = r));
        }
      },
    };
    const push = (action: string) => {
      queue.push(new TextEncoder().encode(`${JSON.stringify({ kind: "container", action, id: action, attributes: {}, timeMs: queue.length + state.pulled + 1 })}\n`));
      wake?.();
    };
    return { call, push, state };
  }

  test("events wait unread while hidden, and every one is handled when it is shown", async () => {
    const stream = eventStream();
    const events = vi.fn(() => stream.call);
    const client = { docker: { events } } as unknown as MightyClient;
    const seen: string[] = [];
    function Host() {
      const [active, setActive] = useState(true);
      show = (on) => act(() => setActive(on));
      return <Events client={client} active={active} seen={seen} />;
    }
    render(<Host />);
    show(true);
    stream.push("start");
    await waitFor(() => seen.length === 1, "the first event");
    show(false);
    stream.push("die");
    stream.push("start-2");
    stream.push("die-2");
    await wait(150);
    // One chunk may be in hand, waiting at the gate; no event is handled, none is lost, the stream stays.
    expect(seen).toEqual(["start"]);
    expect(events).toHaveBeenCalledTimes(1);
    show(true);
    await waitFor(() => seen.length === 4, "the events after it is shown");
    expect(seen).toEqual(["start", "die", "start-2", "die-2"]);
    expect(events).toHaveBeenCalledTimes(1);
  });
});
