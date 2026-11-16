import { useEffect, useSyncExternalStore, type RefObject } from "react";

// Looping animations (Spinner, an indeterminate Progress, Skeleton's pulse) without CSS keyframes:
// the token theme defines no @keyframes and arbitrary animation values are not token values, so
// these run through the Web Animations API. They never start when the user prefers reduced
// motion, and they do nothing where element.animate is missing (jsdom, very old webviews).

const REDUCED = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCED);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

const reduced = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCED).matches;

/** True while the user prefers reduced motion; follows changes to the setting. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, reduced, () => false);
}

/**
 * The value of a time token (`--by-motion-duration-slow`) in ms at `element`, times `factor`;
 * `fallback` when it is unset. A loop's period is a multiple of a motion token, so a theme that
 * slows motion down slows the loops too.
 */
export function tokenMs(element: Element | null, cssVar: `--by-${string}`, factor: number, fallback: number): number {
  if (!element) return fallback;
  const raw = getComputedStyle(element).getPropertyValue(cssVar).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return fallback;
  return (raw.endsWith("ms") ? value : raw.endsWith("s") ? value * 1000 : value) * factor;
}

export interface LoopOptions {
  /** Period of one loop, in ms; computed when the element mounts. */
  duration: (element: Element) => number;
  /** Easing of each loop. */
  easing?: string;
  /** Run the loop (false stops it). */
  enabled?: boolean;
}

/**
 * Runs `keyframes` on `ref`'s element in an endless loop while enabled and motion is allowed,
 * and cancels it on unmount. Returns whether the loop may run (false under reduced motion).
 */
export function useLoopAnimation(ref: RefObject<Element | null>, keyframes: Keyframe[], { duration, easing = "linear", enabled = true }: LoopOptions): boolean {
  const reduce = usePrefersReducedMotion();
  const run = enabled && !reduce;
  // Keyframes are compared by value so an inline array does not restart the loop each render.
  const frames = JSON.stringify(keyframes);
  useEffect(() => {
    const element = ref.current;
    if (!run || !element || typeof element.animate !== "function") return undefined;
    const animation = element.animate(JSON.parse(frames) as Keyframe[], { duration: duration(element), iterations: Infinity, easing });
    return () => animation.cancel();
    // `duration` is read once per start; a new function each render must not restart the loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref, run, frames, easing]);
  return run;
}
