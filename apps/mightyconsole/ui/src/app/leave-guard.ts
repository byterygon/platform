// Unsaved changes in a tab (DOC-21 §3.7, TSK-105): a sheet with a changed draft guards its tab,
// so leaving the tab's place (a link, a segment, Back, Forward, the browser's buttons, closing it)
// asks "Discard changes?" first, and leaving the page asks the browser's own question. The shell
// gives each tab a LeaveGuardContext; a screen outside the shell (a test) has none and nothing
// is guarded.
import { createContext, useContext, useEffect, useRef, useState } from "react";

/** Registers (or clears) one guard of the tab: `key` is the guarding component's own object. */
export type LeaveGuardSetter = (key: object, dirty: boolean) => void;

export const LeaveGuardContext = createContext<LeaveGuardSetter | null>(null);

/**
 * Guards the tab while `dirty` holds; released when it stops or the component goes. The returned
 * `release` drops the guard at once: a sheet that saved calls it before it reports, since the
 * report may move the tab before the sheet has closed.
 */
export function useLeaveGuard(dirty: boolean): () => void {
  const set = useContext(LeaveGuardContext);
  const key = useRef({});
  useEffect(() => {
    if (!set) return;
    set(key.current, dirty);
    return () => set(key.current, false);
  }, [set, dirty]);
  return () => set?.(key.current, false);
}

/**
 * Whether a sheet's draft changed since it opened: its value once the opening settled (the sheet's
 * own reset has run) is the base; any other value is a change. Closed, nothing is changed.
 */
export function useDraftChanged(open: boolean, value: unknown): boolean {
  const json = JSON.stringify(value) ?? "";
  const latest = useRef(json);
  latest.current = json;
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    if (!open) {
      setBase(null);
      return;
    }
    const timer = setTimeout(() => setBase(latest.current), 0);
    return () => clearTimeout(timer);
  }, [open]);
  return open && base !== null && base !== json;
}

/** A sheet's guard in one line: `const release = useSheetGuard(open, draft)`; call `release()` once saved. */
export function useSheetGuard(open: boolean, draft: unknown): () => void {
  return useLeaveGuard(useDraftChanged(open, draft));
}
