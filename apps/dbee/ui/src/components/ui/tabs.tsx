import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { cn } from "@/lib/cn";

// Tabs on Base UI's Tabs: `Tabs` is the root, TabsList the tab strip, TabsTrigger a tab, TabsContent
// its panel. For DBee's query tabs a tab can also be closed (onClose: a close button outside the
// tab order, and Delete on the focused tab) and reordered (TabsList onReorder: drag a tab, or
// Alt+Shift+Arrow on the focused one), and it takes a leading status icon (a spinner, a dot).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const tabsVariants = {
  /** The look of the strip: an underline under the active tab, or editor-style enclosed tabs. */
  variant: {
    line: [
      "-mb-px border-b-2 border-transparent text-fg-muted hover:text-fg data-active:border-accent-solid data-active:text-fg",
      "data-[orientation=vertical]:mb-0 data-[orientation=vertical]:-me-px data-[orientation=vertical]:border-b-0 data-[orientation=vertical]:border-e-2",
    ],
    enclosed: "border-e border-border bg-inset text-fg-muted hover:bg-hover hover:text-fg data-active:bg-surface data-active:text-fg",
  },
  /** Tab height, from the density-aware `size.control.*` roles. */
  size: {
    sm: "h-control-sm px-inset-sm",
    md: "h-control-md px-control-x",
  },
} as const;

export type TabsVariant = keyof typeof tabsVariants.variant;
export type TabsSize = keyof typeof tabsVariants.size;
type TabValue = string | number;

const listVariants = {
  line: "border-b border-border data-[orientation=vertical]:border-b-0 data-[orientation=vertical]:border-e",
  enclosed: "border-b border-border bg-inset",
} as const;

const classes = {
  root: "flex flex-col gap-stack-sm data-[orientation=vertical]:flex-row",
  list: "flex min-w-0 items-stretch overflow-x-auto data-[orientation=vertical]:flex-col data-[orientation=vertical]:overflow-x-visible",
  item: [
    "relative flex shrink-0",
    "before:absolute before:inset-y-0 before:left-0 before:z-[var(--by-z-sticky)] before:hidden before:w-px before:bg-accent-solid data-[drop=before]:before:block",
    "after:absolute after:inset-y-0 after:right-0 after:z-[var(--by-z-sticky)] after:hidden after:w-px after:bg-accent-solid data-[drop=after]:after:block",
    "data-dragging:opacity-[var(--by-opacity-disabled)]",
  ],
  trigger: [
    "flex min-w-0 max-w-panel-xs cursor-default select-none items-center gap-inline-sm whitespace-nowrap font-sans text-label outline-none",
    "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:-outline-offset-[var(--by-ring-width)] focus-visible:outline-ring",
    "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
    "data-closable:pe-control-sm [&_svg]:size-icon-sm [&_svg]:shrink-0",
  ],
  label: "min-w-0 truncate",
  close: [
    "absolute top-1/2 right-inset-xs flex size-control-xs -translate-y-1/2 items-center justify-center rounded-sm text-fg-muted",
    "hover:bg-hover hover:text-fg [&_svg]:size-icon-xs",
  ],
  panel: "min-h-0 flex-1 outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
} as const;

const XIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m4.5 4.5 7 7m0-7-7 7" />
  </svg>
);

interface Drop {
  value: TabValue;
  side: "before" | "after";
}

interface TabsContextValue {
  variant: TabsVariant;
  size: TabsSize;
  orientation: "horizontal" | "vertical";
  /** Set by TabsList: moves `value` to `index` among the tabs. */
  reorder?: ((value: TabValue, index: number) => void) | undefined;
  /** The tab values in strip order, read from the DOM. */
  order: () => TabValue[];
  dragging: TabValue | null;
  setDragging: (value: TabValue | null) => void;
  drop: Drop | null;
  setDrop: (drop: Drop | null) => void;
}

const TabsContext = createContext<TabsContextValue>({
  variant: "line",
  size: "md",
  orientation: "horizontal",
  order: () => [],
  dragging: null,
  setDragging: () => {},
  drop: null,
  setDrop: () => {},
});

export interface TabsProps extends Omit<TabsPrimitive.Root.Props, "className"> {
  /** The look of the strip. */
  variant?: TabsVariant;
  /** Tab height. */
  size?: TabsSize;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** Tabs on Base UI's Tabs: a TabsList of TabsTriggers and a TabsContent per tab. Closable tabs are controlled (`value`, `onValueChange`). */
export function Tabs({ variant = "line", size = "md", orientation = "horizontal", className, ...props }: TabsProps) {
  const values = useRef(new Map<string, TabValue>());
  const listRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<TabValue | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [reorder, setReorder] = useState<TabsContextValue["reorder"]>(undefined);
  const order = useCallback(() => {
    const list = listRef.current;
    if (!list) return [];
    return [...list.querySelectorAll<HTMLElement>('[data-slot="tabs-item"]')].map((item) => values.current.get(item.dataset.value!) ?? item.dataset.value!);
  }, []);
  return (
    <TabsListRegistry value={{ listRef, values: values.current, setReorder }}>
      <TabsContext value={{ variant, size, orientation, reorder, order, dragging, setDragging, drop, setDrop }}>
        <TabsPrimitive.Root data-slot="tabs" data-variant={variant} data-size={size} orientation={orientation} className={cn(classes.root, className)} {...props} />
      </TabsContext>
    </TabsListRegistry>
  );
}

interface Registry {
  listRef: { current: HTMLDivElement | null };
  values: Map<string, TabValue>;
  setReorder: (reorder: TabsContextValue["reorder"]) => void;
}

const RegistryContext = createContext<Registry | null>(null);
const TabsListRegistry = RegistryContext.Provider;

export interface TabsListProps extends Omit<TabsPrimitive.List.Props, "className"> {
  /**
   * Makes the tabs reorderable: called with a tab's value and its new index when the user drops it
   * elsewhere or presses Alt+Shift+Arrow on it. Apply the move to your list of tabs.
   */
  onReorder?: (value: TabValue, index: number) => void;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
  /** Reaches the strip element. */
  ref?: Ref<HTMLDivElement>;
}

/** The tab strip (role="tablist"); it scrolls when the tabs do not fit. */
export function TabsList({ onReorder, className, ref, ...props }: TabsListProps) {
  const registry = useContext(RegistryContext);
  const { variant } = useContext(TabsContext);
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (registry) registry.listRef.current = element;
      if (typeof ref === "function") ref(element);
      else if (ref) ref.current = element;
    },
    [registry, ref],
  );
  const latest = useRef(onReorder);
  latest.current = onReorder;
  const stable = useCallback((value: TabValue, index: number) => latest.current?.(value, index), []);
  const reorderable = onReorder !== undefined;
  const setReorder = registry?.setReorder;
  useEffect(() => {
    setReorder?.(reorderable ? () => stable : undefined);
  }, [setReorder, reorderable, stable]);
  return <TabsPrimitive.List data-slot="tabs-list" ref={setRef} className={cn(classes.list, listVariants[variant], className)} {...props} />;
}

export interface TabsTriggerProps extends Omit<TabsPrimitive.Tab.Props, "className" | "value" | "children"> {
  /** The tab's value, matching its TabsContent. */
  value: TabValue;
  /** The tab's title; long titles are truncated. */
  children?: ReactNode;
  /** A leading status: a Spinner while running, a dot when modified. */
  icon?: ReactNode;
  /** Makes the tab closable: a close button at its end, and Delete on the focused tab. */
  onClose?: () => void;
  /** The close button's tooltip text. */
  closeLabel?: string;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A tab (role="tab"): its icon, its title and, when closable, a close button. */
export function TabsTrigger({ value, icon, children, onClose, closeLabel = "Close tab", className, onKeyDown, ...props }: TabsTriggerProps) {
  const { variant, size, orientation, reorder, order, dragging, setDragging, drop, setDrop } = useContext(TabsContext);
  const registry = useContext(RegistryContext);
  registry?.values.set(String(value), value);
  const itemRef = useRef<HTMLDivElement | null>(null);

  const tabs = () => [...(itemRef.current?.parentElement?.querySelectorAll<HTMLElement>('[data-slot="tabs-trigger"]') ?? [])];

  const close = () => {
    if (!onClose) return;
    const all = tabs();
    const own = itemRef.current?.querySelector<HTMLElement>('[data-slot="tabs-trigger"]');
    const index = own ? all.indexOf(own) : -1;
    const neighbour = all[index + 1] ?? all[index - 1];
    onClose();
    // The tab is gone after the caller's update: keep focus in the strip, on its neighbour.
    if (own && own === document.activeElement && neighbour) setTimeout(() => neighbour.focus(), 0);
  };

  const keyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    onKeyDown?.(event as never);
    if (event.defaultPrevented) return;
    if (onClose && event.key === "Delete") {
      event.preventDefault();
      close();
      return;
    }
    const back = orientation === "horizontal" ? "ArrowLeft" : "ArrowUp";
    const forward = orientation === "horizontal" ? "ArrowRight" : "ArrowDown";
    if (reorder && event.altKey && event.shiftKey && (event.key === back || event.key === forward)) {
      event.preventDefault();
      event.stopPropagation();
      const values = order();
      const from = values.indexOf(value);
      const to = from + (event.key === forward ? 1 : -1);
      if (from >= 0 && to >= 0 && to < values.length) reorder(value, to);
    }
  };

  const dragProps = reorder
    ? {
        draggable: true,
        onDragStart: (event: DragEvent<HTMLDivElement>) => {
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", String(value));
          setDragging(value);
        },
        onDragOver: (event: DragEvent<HTMLDivElement>) => {
          if (dragging === null || dragging === value) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          const before = orientation === "horizontal" ? event.clientX < rect.left + rect.width / 2 : event.clientY < rect.top + rect.height / 2;
          const side = before ? "before" : "after";
          if (drop?.value !== value || drop.side !== side) setDrop({ value, side });
        },
        onDragLeave: () => {
          if (drop?.value === value) setDrop(null);
        },
        onDrop: (event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (dragging !== null && drop) {
            const values = order().filter((v) => v !== dragging);
            const target = values.indexOf(drop.value);
            if (target >= 0) reorder(dragging, target + (drop.side === "after" ? 1 : 0));
          }
          setDragging(null);
          setDrop(null);
        },
        onDragEnd: () => {
          setDragging(null);
          setDrop(null);
        },
      }
    : {};

  return (
    <div
      ref={itemRef}
      data-slot="tabs-item"
      data-value={String(value)}
      data-dragging={dragging === value ? "" : undefined}
      data-drop={drop?.value === value ? drop.side : undefined}
      className={cn(classes.item)}
      {...dragProps}
    >
      <TabsPrimitive.Tab
        data-slot="tabs-trigger"
        data-closable={onClose ? "" : undefined}
        value={value}
        aria-keyshortcuts={[onClose ? "Delete" : "", reorder ? (orientation === "horizontal" ? "Alt+Shift+ArrowLeft Alt+Shift+ArrowRight" : "Alt+Shift+ArrowUp Alt+Shift+ArrowDown") : ""].filter(Boolean).join(" ") || undefined}
        onKeyDown={keyDown}
        className={cn(classes.trigger, tabsVariants.variant[variant], tabsVariants.size[size], className)}
        {...props}
      >
        {icon}
        <span className={classes.label}>{children}</span>
      </TabsPrimitive.Tab>
      {onClose ? (
        // Out of the tab order and hidden from assistive technology: keyboard and screen-reader
        // users close the focused tab with Delete (aria-keyshortcuts), so the tablist holds only tabs.
        <button type="button" data-slot="tabs-close" tabIndex={-1} aria-hidden="true" title={closeLabel} onClick={close} className={cn(classes.close)}>
          <XIcon />
        </button>
      ) : null}
    </div>
  );
}

export interface TabsContentProps extends Omit<TabsPrimitive.Panel.Props, "className" | "value"> {
  /** The value of the tab this panel belongs to. */
  value: TabValue;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A tab's panel (role="tabpanel"), labelled by its tab; only the active one is shown unless keepMounted. */
export function TabsContent({ className, ...props }: TabsContentProps) {
  return <TabsPrimitive.Panel data-slot="tabs-content" className={cn(classes.panel, className)} {...props} />;
}
