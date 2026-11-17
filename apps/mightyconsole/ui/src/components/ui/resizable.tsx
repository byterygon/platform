import { Children, cloneElement, createContext, isValidElement, useCallback, useContext, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactElement, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";

// Panes the user resizes by dragging or by keyboard (DBee's sidebar | editor / results layout),
// following the ARIA window splitter pattern; Base UI has no splitter, so it is built here.
// ResizablePanelGroup > ResizablePanel, ResizableHandle, ResizablePanel ...: panels and handles are
// direct children, a handle resizes the panels on either side of it. Sizes are percentages of the
// group (controlled through `sizes`/`onSizesChange` to persist them). Each handle is a focusable
// role="separator" whose value is the size of the panel before it; arrows move it by
// `keyboardStep`, Home/End take that panel to its minimum/maximum, Enter collapses and restores it.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const resizableVariants = {} as const;

const classes = {
  group: "flex size-full min-h-0 min-w-0 overflow-hidden data-[orientation=vertical]:flex-col",
  panel: "relative min-h-0 min-w-0 overflow-hidden",
  handle: [
    "relative flex shrink-0 touch-none select-none items-center justify-center bg-border-subtle",
    "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
    "hover:bg-border-focus data-dragging:bg-border-focus",
    "focus-visible:bg-border-focus",
    focusRing,
    // The rule is border.width.1; the hit area (after:) is size.track wide on either side.
    "data-[orientation=horizontal]:w-[var(--by-border-width-1)] data-[orientation=horizontal]:cursor-col-resize",
    "data-[orientation=vertical]:h-[var(--by-border-width-1)] data-[orientation=vertical]:cursor-row-resize",
    "after:absolute",
    "data-[orientation=horizontal]:after:inset-y-0 data-[orientation=horizontal]:after:-inset-x-[var(--by-size-track)]",
    "data-[orientation=vertical]:after:inset-x-0 data-[orientation=vertical]:after:-inset-y-[var(--by-size-track)]",
    "data-disabled:pointer-events-none data-disabled:cursor-default",
  ],
  grip: "z-[var(--by-z-base)] shrink-0 rounded-full bg-border-strong data-[orientation=horizontal]:h-control-xs data-[orientation=horizontal]:w-track data-[orientation=vertical]:h-track data-[orientation=vertical]:w-control-xs",
} as const;

type Orientation = "horizontal" | "vertical";

interface GroupContext {
  orientation: Orientation;
  sizes: number[];
  ids: string[];
  limits: PanelLimits[];
  dragging: number | null;
  startDrag: (handle: number, event: PointerEvent<HTMLDivElement>) => void;
  keyDown: (handle: number, event: KeyboardEvent<HTMLDivElement>) => void;
}

interface PanelLimits {
  min: number;
  max: number;
  collapsible: boolean;
  collapsedSize: number;
}

const Context = createContext<GroupContext | null>(null);

function useGroup(part: string) {
  const context = useContext(Context);
  if (!context) throw new Error(`${part} must be a direct child of Resizable`);
  return context;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Moves the boundary between panel `index - 1` and panel `index` by `delta` percent, within both
 * panels' limits; the two sizes keep their sum. Exported for tests.
 */
export function moveBoundary(sizes: readonly number[], limits: readonly PanelLimits[], index: number, delta: number): number[] {
  const a = index - 1;
  const b = index;
  const total = sizes[a]! + sizes[b]!;
  const minA = Math.max(limits[a]!.min, total - limits[b]!.max);
  const maxA = Math.min(limits[a]!.max, total - limits[b]!.min);
  const nextA = clamp(sizes[a]! + delta, minA, maxA);
  const next = [...sizes];
  next[a] = round(nextA);
  next[b] = round(total - nextA);
  return next;
}

export interface ResizableProps {
  /** ResizablePanel and ResizableHandle elements, alternating. */
  children?: ReactNode;
  /** `horizontal` puts panels side by side (handles are vertical rules); `vertical` stacks them. */
  orientation?: Orientation;
  /** Panel sizes in percent (controlled); otherwise each panel's `defaultSize`. */
  sizes?: readonly number[];
  /** Called with the new sizes while the user drags or presses keys. */
  onSizesChange?: (sizes: number[]) => void;
  /** Percent a handle moves per arrow key press. */
  keyboardStep?: number;
  /** Extra classes (the group fills its parent: size-full), merged after the component's own. */
  className?: string;
  /** Inline style for the group. */
  style?: CSSProperties;
  /** Reaches the group element. */
  ref?: Ref<HTMLDivElement>;
  /** Names the group for assistive technology. */
  "aria-label"?: string;
}

/** The group of resizable panels and the handles between them (ResizablePanelGroup in shadcn). */
export function Resizable({ children, orientation = "horizontal", sizes: sizesProp, onSizesChange, keyboardStep = 5, className, style, ref, "aria-label": ariaLabel }: ResizableProps) {
  const baseId = useId();
  const element = useRef<HTMLDivElement | null>(null);

  // Panels and handles in order; each panel's props give its limits and default size.
  const items = Children.toArray(children).filter(isValidElement) as ReactElement<ResizablePanelProps & ResizableHandleProps>[];
  const panels = items.filter((item) => item.type === ResizablePanel);
  const limits = panels.map<PanelLimits>((panel) => ({
    min: panel.props.minSize ?? 0,
    max: panel.props.maxSize ?? 100,
    collapsible: panel.props.collapsible ?? false,
    collapsedSize: panel.props.collapsedSize ?? 0,
  }));
  const ids = panels.map((panel, i) => panel.props.id ?? `${baseId}-panel-${i}`);

  const initial = useMemo(() => {
    const given = panels.map((panel) => panel.props.defaultSize);
    const fixed = given.reduce<number>((sum, size) => sum + (size ?? 0), 0);
    const free = given.filter((size) => size === undefined).length;
    return given.map((size) => size ?? (free ? Math.max(0, 100 - fixed) / free : 0));
    // Default sizes are read once, as an uncontrolled value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [sizesState, setSizesState] = useState<number[]>(initial);
  const sizes = sizesProp ? [...sizesProp] : sizesState.length === panels.length ? sizesState : initial;
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const restore = useRef<Record<number, number>>({});

  const commit = useCallback(
    (next: number[]) => {
      if (next.every((size, i) => size === sizesRef.current[i])) return;
      sizesRef.current = next;
      if (!sizesProp) setSizesState(next);
      onSizesChange?.(next);
    },
    [sizesProp, onSizesChange],
  );

  const [dragging, setDragging] = useState<number | null>(null);

  const startDrag = (handle: number, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !element.current) return;
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture?.(event.pointerId);
    target.focus();
    const rect = element.current.getBoundingClientRect();
    const length = orientation === "horizontal" ? rect.width : rect.height;
    const start = orientation === "horizontal" ? event.clientX : event.clientY;
    const startSizes = sizesRef.current;
    setDragging(handle);
    const move = (e: globalThis.PointerEvent) => {
      if (!length) return;
      const position = orientation === "horizontal" ? e.clientX : e.clientY;
      const rtl = orientation === "horizontal" && getComputedStyle(target).direction === "rtl";
      const delta = ((position - start) / length) * 100 * (rtl ? -1 : 1);
      commit(moveBoundary(startSizes, limits, handle, delta));
    };
    const end = () => {
      setDragging(null);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", end);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", end);
  };

  const keyDown = (handle: number, event: KeyboardEvent<HTMLDivElement>) => {
    const current = sizesRef.current;
    const before = handle - 1;
    const rtl = orientation === "horizontal" && getComputedStyle(event.currentTarget).direction === "rtl";
    const grow = orientation === "horizontal" ? (rtl ? "ArrowLeft" : "ArrowRight") : "ArrowDown";
    const shrink = orientation === "horizontal" ? (rtl ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
    let next: number[] | undefined;
    if (event.key === grow) next = moveBoundary(current, limits, handle, keyboardStep);
    else if (event.key === shrink) next = moveBoundary(current, limits, handle, -keyboardStep);
    else if (event.key === "Home") next = moveBoundary(current, limits, handle, -100);
    else if (event.key === "End") next = moveBoundary(current, limits, handle, 100);
    else if (event.key === "Enter" && limits[before]?.collapsible) {
      const size = current[before]!;
      const collapsed = limits[before]!.collapsedSize;
      if (size > collapsed) {
        restore.current[before] = size;
        next = moveBoundary(current, limits.map((l, i) => (i === before ? { ...l, min: collapsed } : l)), handle, collapsed - size);
      } else next = moveBoundary(current, limits, handle, (restore.current[before] ?? limits[before]!.min) - size);
    }
    if (!next) return;
    event.preventDefault();
    commit(next);
  };

  let panelIndex = 0;
  const content = items.map((item) => {
    if (item.type === ResizablePanel) {
      const index = panelIndex++;
      return cloneElement(item, { key: item.key ?? `panel-${index}`, __index: index } as Partial<ResizablePanelProps>);
    }
    if (item.type === ResizableHandle) return cloneElement(item, { key: item.key ?? `handle-${panelIndex}`, __index: panelIndex } as Partial<ResizableHandleProps>);
    return item;
  });

  const setRef = (node: HTMLDivElement | null) => {
    element.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };

  return (
    <Context.Provider value={{ orientation, sizes, ids, limits, dragging, startDrag, keyDown }}>
      <div ref={setRef} data-slot="resizable" data-orientation={orientation} aria-label={ariaLabel} style={style} className={cn(classes.group, className)}>
        {content}
      </div>
    </Context.Provider>
  );
}

export interface ResizablePanelProps {
  /** The panel's content. */
  children?: ReactNode;
  /** Initial size in percent; panels without one share what is left. */
  defaultSize?: number;
  /** Smallest size in percent. */
  minSize?: number;
  /** Largest size in percent. */
  maxSize?: number;
  /** Enter on the handle after it collapses the panel to `collapsedSize` and restores it. */
  collapsible?: boolean;
  /** Size in percent when collapsed. */
  collapsedSize?: number;
  /** The panel's element id (aria-controls on the handle names it). */
  id?: string;
  /** Extra classes, merged after the component's own. */
  className?: string;
  /** Reaches the panel element. */
  ref?: Ref<HTMLDivElement>;
  /** Set by the group. */
  __index?: number;
}

/** One pane; its size is a flex basis in percent of the group. */
export function ResizablePanel({ children, id, className, ref, __index = 0 }: ResizablePanelProps) {
  const { sizes, ids, limits } = useGroup("ResizablePanel");
  const size = sizes[__index] ?? 0;
  const collapsed = limits[__index]?.collapsible === true && size <= (limits[__index]?.collapsedSize ?? 0);
  return (
    <div ref={ref} id={id ?? ids[__index]} data-slot="resizable-panel" data-collapsed={collapsed ? "" : undefined} style={{ flex: `${size} 1 0px` }} className={cn(classes.panel, className)}>
      {children}
    </div>
  );
}

export interface ResizableHandleProps {
  /** Draws a grip in the middle of the rule. */
  withGrip?: boolean;
  /** The handle cannot be moved. */
  disabled?: boolean;
  /** Names the handle ("Resize sidebar"). */
  "aria-label"?: string;
  /** Extra classes, merged after the component's own. */
  className?: string;
  /** Reaches the handle element. */
  ref?: Ref<HTMLDivElement>;
  /** Set by the group. */
  __index?: number;
}

/** The boundary between two panels: a focusable role="separator" the user drags or moves with the keys. */
export function ResizableHandle({ withGrip = false, disabled = false, "aria-label": ariaLabel = "Resize", className, ref, __index = 1 }: ResizableHandleProps) {
  const { orientation, sizes, ids, limits, dragging, startDrag, keyDown } = useGroup("ResizableHandle");
  const before = __index - 1;
  return (
    <div
      ref={ref}
      role="separator"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      // A horizontal group's handles are vertical rules.
      aria-orientation={orientation === "horizontal" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(sizes[before] ?? 0)}
      aria-valuemin={Math.round(limits[before]?.min ?? 0)}
      aria-valuemax={Math.round(limits[before]?.max ?? 100)}
      aria-controls={ids[before]}
      aria-disabled={disabled || undefined}
      data-slot="resizable-handle"
      data-orientation={orientation}
      data-dragging={dragging === __index ? "" : undefined}
      data-disabled={disabled ? "" : undefined}
      onPointerDown={disabled ? undefined : (event) => startDrag(__index, event)}
      onKeyDown={disabled ? undefined : (event) => keyDown(__index, event)}
      className={cn(classes.handle, className)}
    >
      {withGrip ? <span data-slot="resizable-grip" data-orientation={orientation} aria-hidden="true" className={cn(classes.grip)} /> : null}
    </div>
  );
}

/** shadcn's name for the group, kept so code written against shadcn's Resizable reads the same. */
export const ResizablePanelGroup = Resizable;
