import { useCallback, useRef, useState, type Ref } from "react";

/**
 * The theme and density attributes a popup needs to look like the control that opened it.
 *
 * Popups (Select, Combobox, menus) render in a portal at the end of `<body>`, outside the element
 * that sets `data-theme` or `data-density`. When those attributes sit on `<html>` nothing is lost;
 * when a page scopes them to a region (a dark panel, a compact grid, the gallery's four modes),
 * the popup would fall back to the page defaults. Spreading this on the popup's positioner sets
 * the same attributes there, so the token variables resolve as they do at the trigger.
 */
export interface ThemeScope {
  "data-theme"?: string;
  "data-density"?: string;
}

/** The theme (`data-theme`, or a `.dark` / `.light` class) and density in force at `element`. */
export function themeScopeOf(element: Element | null): ThemeScope {
  const scope: ThemeScope = {};
  if (!element) return scope;
  const theme = element.closest("[data-theme], .dark, .light");
  if (theme) scope["data-theme"] = theme.getAttribute("data-theme") ?? (theme.classList.contains("dark") ? "dark" : "light");
  const density = element.closest("[data-density]")?.getAttribute("data-density");
  if (density) scope["data-density"] = density;
  return scope;
}

/**
 * A length token's value in px at `element` (`--by-space-inline-xs` is 2 px compact, 4 px
 * comfortable), for Base UI props that take numbers such as a positioner's `sideOffset`.
 * Returns `fallback` when the variable is unset or not in px.
 */
export function tokenPx(element: Element | null, cssVar: `--by-${string}`, fallback: number): number {
  if (!element) return fallback;
  const value = Number.parseFloat(getComputedStyle(element).getPropertyValue(cssVar));
  return Number.isFinite(value) ? value : fallback;
}

const same = (a: ThemeScope, b: ThemeScope) => a["data-theme"] === b["data-theme"] && a["data-density"] === b["data-density"];

/**
 * Tracks the theme scope of an anchor element. Put `ref` on the trigger (it also sets
 * `forwardedRef`), spread `scope` on the popup's positioner, and call `refresh` when the popup
 * opens so a theme switched since mount is picked up. `anchor` holds the trigger element.
 */
export function useThemeScope<T extends Element>(forwardedRef?: Ref<T>) {
  const anchor = useRef<T | null>(null);
  const [scope, setScope] = useState<ThemeScope>({});
  const refresh = useCallback(() => {
    setScope((previous) => {
      const next = themeScopeOf(anchor.current);
      return same(previous, next) ? previous : next;
    });
  }, []);
  const ref = useCallback(
    (element: T | null) => {
      anchor.current = element;
      if (typeof forwardedRef === "function") forwardedRef(element);
      else if (forwardedRef) forwardedRef.current = element;
      if (element) refresh();
    },
    [forwardedRef, refresh],
  );
  return { ref, anchor, scope, refresh };
}

/**
 * One ref callback that sets both refs: a trigger needs a popup root's theme-scope ref (from
 * context) and the caller's own `ref`.
 */
export function useMergedRef<T>(own: (element: T | null) => void, other: Ref<T> | undefined) {
  return useCallback(
    (element: T | null) => {
      own(element);
      if (typeof other === "function") other(element);
      else if (other) other.current = element;
    },
    [own, other],
  );
}
