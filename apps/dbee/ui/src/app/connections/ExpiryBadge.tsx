import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { RelativeTime } from "@/components/ui/relative-time";
import { Clock } from "@/lib/icons";

// A grant's expiry as a badge (DBee spec §3.11 flow 4): nothing until 15 minutes before
// (Decision 9), then "expires in 14 min" that counts down by itself (to the second within the
// last minute, driven by this badge's own timer: RelativeTime's tick is 60 s above a minute), then "expired 2 min ago" once the time has passed.
// Only this badge re-renders; the tree and the status bar around it do not. The absolute time
// is in RelativeTime's Tooltip. The phase changes are timers set to the 15-minute mark and to
// the expiry, and the phase is always read against the wall clock, never from the timer.

export const EXPIRY_WARNING_MS = 15 * 60_000;
const MAX_TIMEOUT = 2 ** 31 - 1;

export type ExpiryPhase = "later" | "soon" | "expired";

export function expiryPhase(expiresAt: number, now: number): ExpiryPhase {
  const left = expiresAt - now;
  return left <= 0 ? "expired" : left <= EXPIRY_WARNING_MS ? "soon" : "later";
}

export interface ExpiryBadgeProps {
  /** Unix milliseconds; `null` means the grant does not expire, so nothing is shown. */
  expiresAt: number | null;
  /** Show nothing once expired (the node's own "expired" status already says it). */
  hideExpired?: boolean;
  /** A clock and the time only ("in 13 min."), for a narrow place such as a tree row; the words stay for screen readers. */
  compact?: boolean;
}

export function ExpiryBadge({ expiresAt, hideExpired = false, compact = false }: ExpiryBadgeProps) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (expiresAt === null) return undefined;
    const left = expiresAt - Date.now();
    if (left <= 0) return undefined;
    // Wake at the 15-minute mark; then every 15 s until the last minute (the minute shown is
    // never stale by more than that); then every second; then at the expiry itself.
    const delay = left > EXPIRY_WARNING_MS ? left - EXPIRY_WARNING_MS : left > 60_000 ? Math.min(15_000, left - 60_000) : Math.min(1000, left);
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(delay, MAX_TIMEOUT));
    return () => clearTimeout(timer);
  }, [expiresAt, tick]);

  if (expiresAt === null) return null;
  const now = Date.now();
  const phase = expiryPhase(expiresAt, now);
  if (phase === "later" || (phase === "expired" && hideExpired)) return null;
  return (
    <Badge variant={phase === "expired" ? "danger" : "warning"} data-expiry-phase={phase}>
      {compact ? <Icon icon={Clock} size="xs" /> : null}
      <span className={compact ? "sr-only" : undefined}>{phase === "expired" ? "expired " : "expires "}</span>
      <RelativeTime date={expiresAt} now={now} />
    </Badge>
  );
}
