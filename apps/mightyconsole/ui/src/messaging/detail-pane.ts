import { useCallback, useEffect, useState, type RefObject } from "react";
import { DEFAULT_DETAIL_PANE, DETAIL_PANE_LIMITS, type DetailPane, useStoreIfAny } from "@/app/store";

// The message detail pane's layout (DOC-21 §5.6, TSK-112): where it sits (below the list or to its
// right), how much of the view it has, and whether it fills the view. The three are kept per kind
// of tab in the workspace settings (`detailPanes`), so a Subscribe tab, a stream's messages and a
// KV bucket each keep theirs across a reload. Without a store (a view rendered on its own) they
// are local state. With no side chosen the detail goes to the right when the view is wide enough
// for a list and a detail side by side, below otherwise.

/** The view's width from which the detail goes to the right by default. */
export const SIDE_BY_SIDE_FROM = 960;

/** The default share of the view for the detail: more below the list, which is the narrow case. */
const DEFAULT_SIZE = { right: 45, bottom: 60 } as const;

export interface DetailPaneState {
  side: "bottom" | "right";
  /** The detail's percent of the view while it is not maximized. */
  size: number;
  maximized: boolean;
  setSize(percent: number): void;
  toggleSide(): void;
  toggleMaximized(): void;
}

const clamp = (n: number) => Math.min(DETAIL_PANE_LIMITS.max, Math.max(DETAIL_PANE_LIMITS.min, n));

export function useDetailPane(paneKey: string | undefined, view: RefObject<HTMLElement | null>): DetailPaneState {
  const app = useStoreIfAny();
  const [local, setLocal] = useState<DetailPane>(DEFAULT_DETAIL_PANE);
  const stored = paneKey ? app?.state.settings.detailPanes[paneKey] : undefined;
  const pane = stored ?? (app ? DEFAULT_DETAIL_PANE : local);
  const sizeChosen = stored !== undefined;

  const [wide, setWide] = useState(true);
  useEffect(() => {
    const element = view.current;
    if (!element) return undefined;
    const measure = () => setWide(element.clientWidth === 0 || element.clientWidth >= SIDE_BY_SIDE_FROM);
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [view]);

  const side = pane.side ?? (wide ? "right" : "bottom");
  const size = sizeChosen ? pane.size : DEFAULT_SIZE[side];

  const dispatch = app?.dispatch;
  const detailPanes = app?.state.settings.detailPanes;
  const write = useCallback(
    (change: Partial<DetailPane>) => {
      if (paneKey && dispatch && detailPanes) dispatch({ type: "settings", settings: { detailPanes: { ...detailPanes, [paneKey]: { ...(detailPanes[paneKey] ?? DEFAULT_DETAIL_PANE), ...change } } } });
      else setLocal((previous) => ({ ...previous, ...change }));
    },
    [paneKey, dispatch, detailPanes],
  );

  return {
    side,
    size,
    maximized: pane.maximized,
    // A chosen size is kept as the user left it, whichever side: it is a share of the view.
    setSize: (percent) => write({ size: clamp(percent), side }),
    toggleSide: () => write({ side: side === "right" ? "bottom" : "right", size: sizeChosen ? pane.size : DEFAULT_SIZE[side === "right" ? "bottom" : "right"] }),
    toggleMaximized: () => write({ maximized: !pane.maximized, side, size }),
  };
}
