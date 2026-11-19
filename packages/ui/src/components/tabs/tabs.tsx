import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/dropdown-menu/dropdown-menu";
import { Icon } from "@/components/icon/icon";
import { IconButton } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";
import { controlAppearance, controlSize, focusRing, focusRingInset, type ControlSizeProp } from "@/lib/control";
import { Dismiss, MoreHorizontal } from "@/lib/icons";

// Tabs on Base UI's Tabs: `Tabs` is the root, TabsList the tab strip, TabsTrigger a tab, TabsContent
// its panel. For DBee's query tabs a tab can also be closed (onClose: a close button outside the
// tab order, and Delete on the focused tab) and reordered (TabsList onReorder: drag a tab, or
// Alt+Shift+Arrow on the focused one), and it takes a leading status icon (a spinner, a dot).
// A horizontal strip never scrolls: tabs that do not fit are hidden behind a "More tabs" menu at
// its end, as Fluent's TabList overflow, and the selected tab always stays in view.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const tabsVariants = {
  /** Fluent's tab appearance: `transparent` (an accent underline under the selected tab), `subtle` (a wash behind it), or Byterygon's `enclosed` editor tabs. */
  appearance: {
    transparent: [
      "border-b-2 border-transparent text-fg-muted hover:text-fg data-active:border-accent-compound data-active:text-fg",
      "data-[orientation=vertical]:mb-0 data-[orientation=vertical]:-me-px data-[orientation=vertical]:border-b-0 data-[orientation=vertical]:border-e-2",
    ],
    subtle: "rounded-md text-fg-muted hover:bg-hover hover:text-fg active:bg-pressed data-active:bg-selected data-active:text-fg",
    enclosed: "border-e border-border-subtle bg-layer-alt text-fg-muted hover:bg-hover hover:text-fg data-active:bg-layer data-active:text-fg",
  },
  /** Tab height, from the density-aware `size.control.*` roles: Fluent's small 24, medium 32 and large 40 px. */
  size: {
    small: "h-control-sm px-inset-sm",
    medium: "h-control-md px-control-x",
    large: "h-control-lg px-inset-md",
  },
} as const;

export type TabsAppearance = keyof typeof tabsVariants.appearance;
export type TabsSize = keyof typeof tabsVariants.size;
/** The old `variant` names and the appearance each stands for. */
const VARIANT_ALIASES = { line: "transparent", enclosed: "enclosed" } as const;
export type TabsVariant = keyof typeof VARIANT_ALIASES;
type TabValue = string | number;

const listVariants = {
  transparent: "border-b border-border-subtle data-[orientation=vertical]:border-b-0 data-[orientation=vertical]:border-e",
  subtle: "gap-inline-xs",
  enclosed: "border-b border-border-subtle bg-layer-alt",
} as const;

const classes = {
  root: "flex flex-col gap-stack-sm data-[orientation=vertical]:flex-row",
  // The strip holds the tablist and the "More tabs" button; the appearance's border is on it.
  strip: "flex min-w-0 items-stretch data-[orientation=vertical]:flex-col",
  // Horizontal: clipped on both axes, never scrolled (overflow-x alone makes overflow-y scroll too).
  list: "flex min-w-0 flex-1 items-stretch overflow-hidden data-[orientation=vertical]:flex-col data-[orientation=vertical]:overflow-visible",
  more: "shrink-0 self-center",
  item: [
    "relative flex shrink-0 data-overflow:hidden",
    "before:absolute before:inset-y-0 before:left-0 before:z-[var(--by-z-sticky)] before:hidden before:w-px before:bg-accent-compound data-[drop=before]:before:block",
    "after:absolute after:inset-y-0 after:right-0 after:z-[var(--by-z-sticky)] after:hidden after:w-px after:bg-accent-compound data-[drop=after]:after:block",
    "data-dragging:opacity-[var(--by-opacity-disabled)]",
  ],
  trigger: [
    "flex min-w-0 max-w-panel-xs cursor-default select-none items-center gap-inline-sm whitespace-nowrap font-sans text-body-1 data-active:text-body-1-strong",
    "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
    focusRingInset,
    "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
    "data-closable:pe-control-sm [&_svg]:size-icon-sm [&_svg]:shrink-0",
  ],
  label: "min-w-0 truncate",
  close: [
    "absolute top-1/2 right-inset-xs flex size-control-xs -translate-y-1/2 items-center justify-center rounded-sm text-fg-muted",
    "hover:bg-hover hover:text-fg active:bg-pressed [&_svg]:size-icon-xs",
  ],
  panel: ["min-h-0 flex-1", focusRing],
} as const;

interface Drop {
  value: TabValue;
  side: "before" | "after";
}

interface TabsContextValue {
  appearance: TabsAppearance;
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
  appearance: "transparent",
  size: "medium",
  orientation: "horizontal",
  order: () => [],
  dragging: null,
  setDragging: () => {},
  drop: null,
  setDrop: () => {},
});

export interface TabsProps extends Omit<TabsPrimitive.Root.Props, "className"> {
  /** Fluent's appearance: `transparent` (default), `subtle`, or Byterygon's `enclosed` for editor tabs. */
  appearance?: TabsAppearance;
  /** Tab height: `small`, `medium` (default) or `large`; `sm`, `md` and `lg` still work for one release. */
  size?: TabsSize | ControlSizeProp;
  /**
   * The old name of `appearance`: `line` is transparent.
   * @deprecated Use `appearance`. Kept for one release.
   */
  variant?: TabsVariant;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** Tabs on Base UI's Tabs: a TabsList of TabsTriggers and a TabsContent per tab. Closable tabs are controlled (`value`, `onValueChange`). */
export function Tabs({ appearance: appearanceProp, variant, size: sizeProp, orientation = "horizontal", className, ...props }: TabsProps) {
  const appearance = controlAppearance(appearanceProp, variant, VARIANT_ALIASES, "transparent");
  const size = controlSize(sizeProp);
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
      <TabsContext value={{ appearance, size, orientation, reorder, order, dragging, setDragging, drop, setDrop }}>
        <TabsPrimitive.Root data-slot="tabs" data-appearance={appearance} data-size={size} orientation={orientation} className={cn(classes.root, className)} {...props} />
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
  /** The tooltip and accessible name of the button that lists the tabs that do not fit. */
  moreLabel?: string;
  /** Extra classes on the strip (the tablist and its "More tabs" button), merged after the component's own. */
  className?: string;
  /** Reaches the tablist element. */
  ref?: Ref<HTMLDivElement>;
}

interface HiddenTab {
  value: string;
  label: string;
}

const itemsOf = (list: HTMLElement) => [...list.children].filter((child): child is HTMLElement => child instanceof HTMLElement && child.dataset["slot"] === "tabs-item");
const triggerOf = (item: HTMLElement) => item.querySelector<HTMLElement>('[data-slot="tabs-trigger"]');
const px = (value: string) => Number.parseFloat(value) || 0;

/**
 * Fits the tabs into the strip: every tab is shown to measure it, then the ones that do not fit
 * get `data-overflow` (hidden), keeping the selected one. Writes the attributes directly, so no
 * render is needed to measure. Returns the hidden tabs, in strip order.
 */
function fitTabs(strip: HTMLElement, list: HTMLElement, more: HTMLElement | null): HiddenTab[] {
  const items = itemsOf(list);
  for (const item of items) item.removeAttribute("data-overflow");
  const stripStyle = getComputedStyle(strip);
  const room = strip.clientWidth - px(stripStyle.paddingLeft) - px(stripStyle.paddingRight);
  const gap = px(getComputedStyle(list).columnGap);
  const widths = items.map((item) => item.getBoundingClientRect().width);
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, items.length - 1);
  if (total <= room + 0.5 || items.length === 0) {
    if (more) more.hidden = true;
    return [];
  }
  if (more) more.hidden = false;
  const left = room - (more ? more.getBoundingClientRect().width + px(stripStyle.columnGap) : 0);
  const selected = items.findIndex((item) => triggerOf(item)?.getAttribute("aria-selected") === "true");
  const shown = new Set<number>();
  let used = 0;
  if (selected >= 0) {
    shown.add(selected);
    used = widths[selected]!;
  }
  for (let index = 0; index < items.length; index += 1) {
    if (index === selected) continue;
    const next = used + (shown.size > 0 ? gap : 0) + widths[index]!;
    if (next > left + 0.5) break;
    shown.add(index);
    used = next;
  }
  const hidden: HiddenTab[] = [];
  items.forEach((item, index) => {
    if (shown.has(index)) return;
    item.setAttribute("data-overflow", "");
    hidden.push({ value: item.dataset["value"]!, label: triggerOf(item)?.textContent?.trim() ?? item.dataset["value"]! });
  });
  return hidden;
}

const sameTabs = (a: readonly HiddenTab[], b: readonly HiddenTab[]) => a.length === b.length && a.every((tab, index) => tab.value === b[index]!.value && tab.label === b[index]!.label);

/**
 * The tab strip (role="tablist"). Horizontal tabs that do not fit are listed in a "More tabs" menu
 * at the end of the strip; the selected tab always stays visible. The ref reaches the tablist.
 */
export function TabsList({ onReorder, moreLabel = "More tabs", className, ref, ...props }: TabsListProps) {
  const registry = useContext(RegistryContext);
  const { appearance, orientation } = useContext(TabsContext);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const focusAfterFit = useRef<string | null>(null);
  const [hidden, setHidden] = useState<readonly HiddenTab[]>([]);
  const setRef = useCallback(
    (element: HTMLDivElement | null) => {
      listRef.current = element;
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

  const horizontal = orientation === "horizontal";
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const list = listRef.current;
    if (!horizontal || !strip || !list) return;
    let frame = 0;
    const fit = () => {
      frame = 0;
      const next = fitTabs(strip, list, moreRef.current);
      setHidden((previous) => (sameTabs(previous, next) ? previous : next));
      const wanted = focusAfterFit.current;
      if (wanted !== null) {
        focusAfterFit.current = null;
        const item = itemsOf(list).find((candidate) => candidate.dataset["value"] === wanted);
        if (item && !item.hasAttribute("data-overflow")) triggerOf(item)?.focus();
      }
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(fit);
    };
    fit();
    // The strip's width, the tabs (added, closed, renamed, reordered) and the selection decide it.
    const resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
    resize?.observe(strip);
    const mutation = new MutationObserver(schedule);
    mutation.observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["aria-selected", "data-value"] });
    void document.fonts?.ready.then(schedule);
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
      for (const item of itemsOf(list)) item.removeAttribute("data-overflow");
    };
  }, [horizontal]);

  const choose = (value: string) => {
    const list = listRef.current;
    const item = list ? itemsOf(list).find((candidate) => candidate.dataset["value"] === value) : undefined;
    const trigger = item ? triggerOf(item) : null;
    if (!trigger) return;
    focusAfterFit.current = value;
    // Selects it as a click would (controlled or not); the next fit shows it and focuses it.
    trigger.click();
    requestAnimationFrame(() => {
      if (focusAfterFit.current === value && !item!.hasAttribute("data-overflow")) {
        focusAfterFit.current = null;
        trigger.focus();
      }
    });
  };

  return (
    <div ref={stripRef} data-slot="tabs-strip" data-orientation={orientation} className={cn(classes.strip, listVariants[appearance], className)}>
      <TabsPrimitive.List data-slot="tabs-list" ref={setRef} className={cn(classes.list)} {...props} />
      {horizontal ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            ref={moreRef}
            hidden={hidden.length === 0}
            render={<IconButton appearance="subtle" size="small" aria-label={`${moreLabel} (${hidden.length})`} title={moreLabel} className={cn(classes.more)} />}
          >
            <Icon icon={MoreHorizontal} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" finalFocus={false}>
            {hidden.map((tab) => (
              <DropdownMenuItem key={tab.value} onClick={() => choose(tab.value)}>
                {tab.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
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
  const { appearance, size, orientation, reorder, order, dragging, setDragging, drop, setDrop } = useContext(TabsContext);
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
    const horizontal = orientation === "horizontal";
    const rtl = horizontal && itemRef.current !== null && getComputedStyle(itemRef.current).direction === "rtl";
    const back = horizontal ? (rtl ? "ArrowRight" : "ArrowLeft") : "ArrowUp";
    const forward = horizontal ? (rtl ? "ArrowLeft" : "ArrowRight") : "ArrowDown";
    const list = itemRef.current?.parentElement;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
    // With tabs hidden behind "More tabs", arrows, Home and End move among the visible tabs only
    // (Base UI's own navigation would try to focus a hidden one).
    if (plain && list?.querySelector(':scope > [data-overflow]') && [back, forward, "Home", "End"].includes(event.key)) {
      const visible = itemsOf(list)
        .filter((item) => !item.hasAttribute("data-overflow"))
        .map(triggerOf)
        .filter((trigger): trigger is HTMLElement => trigger !== null && !trigger.hasAttribute("data-disabled"));
      const at = visible.indexOf(event.currentTarget);
      const count = visible.length;
      const target = event.key === "Home" ? visible[0] : event.key === "End" ? visible[count - 1] : visible[(at + (event.key === forward ? 1 : -1) + count) % count];
      event.preventDefault();
      event.stopPropagation();
      target?.focus();
      return;
    }
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
        className={cn(classes.trigger, tabsVariants.appearance[appearance], tabsVariants.size[size], className)}
        {...props}
      >
        {icon}
        <span className={classes.label}>{children}</span>
      </TabsPrimitive.Tab>
      {onClose ? (
        // Out of the tab order and hidden from assistive technology: keyboard and screen-reader
        // users close the focused tab with Delete (aria-keyshortcuts), so the tablist holds only tabs.
        <button type="button" data-slot="tabs-close" tabIndex={-1} aria-hidden="true" title={closeLabel} onClick={close} className={cn(classes.close)}>
          <Icon icon={Dismiss} />
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
