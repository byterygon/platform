import { useEffect, useSyncExternalStore, type RefObject } from "react";

// Looping animations (Spinner, an indeterminate Progress, Skeleton's pulse) without CSS keyframes:
// the token theme defines no @keyframes and arbitrary animation values are not token values, so
// these run through the Web Animations API. They never start when the user prefers reduced
// motion, and they do nothing where element.animate is missing (jsdom, very old webviews).

const REDUCED = "(prefers-reduced-motion: reduce)";

/**
 * Fluent 2's durations (`motion.duration.*`, TSK-57) in ms: the fallbacks `tokenMs` callers pass
 * and what a script needs when no element is at hand. `base` is the alias kept from before.
 * A test keeps these equal to the tokens of the default theme.
 */
export const MOTION_DURATION_MS = {
  instant: 0,
  "ultra-fast": 50,
  faster: 100,
  fast: 150,
  normal: 200,
  gentle: 250,
  slow: 300,
  slower: 400,
  "ultra-slow": 500,
  base: 200,
} as const;
export type MotionDuration = keyof typeof MOTION_DURATION_MS;

/**
 * Fluent 2's curves (`motion.easing.*`) as CSS easing strings, for the Web Animations API, which
 * takes a `cubic-bezier()` but not a `var()`. The first names (`standard`, `enter`, `exit`,
 * `emphasized`) alias the Fluent curve with the same job. A test keeps these equal to the tokens.
 */
export const MOTION_EASING = {
  "accelerate-max": "cubic-bezier(0.9, 0.1, 1, 0.2)",
  "accelerate-mid": "cubic-bezier(1, 0, 1, 1)",
  "accelerate-min": "cubic-bezier(0.8, 0, 0.78, 1)",
  "decelerate-max": "cubic-bezier(0.1, 0.9, 0.2, 1)",
  "decelerate-mid": "cubic-bezier(0, 0, 0, 1)",
  "decelerate-min": "cubic-bezier(0.33, 0, 0.1, 1)",
  "easy-ease-max": "cubic-bezier(0.8, 0, 0.2, 1)",
  "easy-ease": "cubic-bezier(0.33, 0, 0.67, 1)",
  linear: "cubic-bezier(0, 0, 1, 1)",
  standard: "cubic-bezier(0.33, 0, 0.67, 1)",
  enter: "cubic-bezier(0, 0, 0, 1)",
  exit: "cubic-bezier(1, 0, 1, 1)",
  emphasized: "cubic-bezier(0.8, 0, 0.2, 1)",
} as const;
export type MotionEasing = keyof typeof MOTION_EASING;

/** The CSS variable of a duration token: `durationVar("normal")` is `--by-motion-duration-normal`. */
export const durationVar = (name: MotionDuration) => `--by-motion-duration-${name}` as const;

/** The CSS variable of a curve token: `easingVar("easy-ease")` is `--by-motion-easing-easy-ease`. */
export const easingVar = (name: MotionEasing) => `--by-motion-easing-${name}` as const;

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

/**
 * The curve `name` as the theme at `element` sets it (a `cubic-bezier()` string the Web Animations
 * API accepts), or Fluent's value when the variable is unset or there is no element.
 */
export function tokenEasing(element: Element | null, name: MotionEasing): string {
  if (!element) return MOTION_EASING[name];
  const raw = getComputedStyle(element).getPropertyValue(easingVar(name)).trim();
  return raw.startsWith("cubic-bezier(") ? raw : MOTION_EASING[name];
}

export interface LoopOptions {
  /** Period of one loop, in ms; computed when the element mounts. */
  duration: (element: Element) => number;
  /** Easing of each loop: a CSS easing string (`MOTION_EASING.linear`, `tokenEasing(...)`). */
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
