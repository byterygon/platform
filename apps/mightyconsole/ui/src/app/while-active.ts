// The rule for tabs in the background (DOC-21 §3.2, TSK-107). Every tab stays mounted
// (`keepMounted`), so a live tail, a followed history, a clock or a refresh loop would keep working
// for a tab nobody sees: decoding, React state per batch, rows drawn, a timer every second. A tab
// that is not the active one does none of that, and never loses its stream:
//
//   - a stream is not cancelled; its reader waits (`idle()`) before it takes the next chunk, so no
//     credit goes back to the server and the bounded buffers fill (the credits, the server's push
//     buffer, the live window), exactly as for Pause;
//   - a timer or a refresh loop is off while hidden and runs once at once when the tab is shown;
//   - what the tab shows is brought up to date when it is shown again.
//
// `TabProps.active` is the one input; these are the shared pieces so no tab keeps its own copy.
import { useCallback, useEffect, useRef, useState } from "react";

/** A gate that is open while `active`: readers `await idle()` where they would otherwise work. */
export interface ActiveGate {
  /** Whether the tab is shown now. */
  readonly active: boolean;
  /** Resolves at once while active, otherwise when the tab is shown again. */
  idle(): Promise<void>;
}

/** A gate outside React (the hook below drives one); `set(true)` releases every reader waiting. */
export function createGate(initial = true): ActiveGate & { set(active: boolean): void } {
  let active = initial;
  let waiting: (() => void)[] = [];
  return {
    get active() {
      return active;
    },
    idle: () => (active ? Promise.resolve() : new Promise<void>((resolve) => waiting.push(resolve))),
    set(next) {
      active = next;
      if (!next) return;
      const release = waiting;
      waiting = [];
      for (const resolve of release) resolve();
    },
  };
}

/**
 * The tab's gate. It is one stable object, so effects and stream readers keep it without
 * restarting when the tab is shown or hidden.
 */
export function useActiveGate(active: boolean): ActiveGate {
  const gate = useRef<ReturnType<typeof createGate> | null>(null);
  gate.current ??= createGate(active);
  // Set during render so a reader that wakes in the same commit already sees the new value.
  gate.current.set(active);
  return gate.current;
}

/**
 * Runs `callback` every `ms` while `enabled` and the tab is active. It runs once at once when the
 * tab is shown after it was hidden (or mounted hidden), so what it refreshes has caught up; a tab
 * that was never hidden gets no extra call.
 */
export function useActiveInterval(callback: () => void, ms: number, active: boolean, enabled = true): void {
  const latest = useRef(callback);
  latest.current = callback;
  const hidden = useRef(false);
  const on = enabled && active;
  useEffect(() => {
    if (!enabled) {
      hidden.current = false;
      return undefined;
    }
    if (!active) {
      hidden.current = true;
      return undefined;
    }
    if (hidden.current) {
      hidden.current = false;
      latest.current();
    }
    const timer = setInterval(() => latest.current(), ms);
    return () => clearInterval(timer);
    // `on` is the whole condition; `enabled` and `active` are read for what changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, ms]);
}

/**
 * The wall clock for a view that ticks while open (a followed workflow): `Date.now()` once a
 * second while `running` and active, and fresh as soon as the tab is shown again.
 */
export function useActiveClock(active: boolean, running: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  const tick = useCallback(() => setNow(Date.now()), []);
  useActiveInterval(tick, ms, active, running);
  return now;
}
