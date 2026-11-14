import { useRender } from "@base-ui/react/use-render";
import { createContext, useContext, useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { IconButton, type IconButtonProps } from "@/components/icon-button/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/tooltip/tooltip";
import { cn } from "@/lib/cn";

// The side panel of an app shell (DBee's connections and schema tree): SidebarProvider holds the
// open state (and Ctrl/Cmd+B), Sidebar is the panel, SidebarInset the main area beside it,
// SidebarTrigger the toggle. Collapsing leaves an icon rail (collapsible="icon", menu labels
// become tooltips) or hides the panel (collapsible="offcanvas"). The content is SidebarHeader,
// SidebarContent (scrolls), SidebarFooter, SidebarGroup with SidebarGroupLabel, and SidebarMenu of
// SidebarMenuItem > SidebarMenuButton. No Base UI part exists for it; the buttons use useRender.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const sidebarVariants = {
  /** The side of the shell the panel sits on: the border is on its inner edge. */
  side: {
    left: "border-e",
    right: "order-last border-s",
  },
} as const;

type Collapsible = "icon" | "offcanvas" | "none";

interface SidebarContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  sidebarId: string;
}

const SidebarContext = createContext<SidebarContextValue>({ open: true, setOpen: () => {}, sidebarId: "" });
const CollapsibleContext = createContext<Collapsible>("none");

/** The sidebar's open state, for a custom toggle. */
export function useSidebar() {
  const { open, setOpen } = useContext(SidebarContext);
  return { open, setOpen, toggle: () => setOpen(!open) };
}

const classes = {
  provider: "flex h-full min-h-0 w-full",
  root: [
    "flex h-full w-panel-xs shrink-0 flex-col overflow-hidden border-border bg-surface font-sans text-body text-fg",
    "transition-all duration-[var(--by-motion-duration-base)] ease-standard motion-reduce:transition-none",
    "data-[collapsed=icon]:w-control-lg data-[collapsed=offcanvas]:hidden",
  ],
  header: "flex flex-col gap-stack-xs p-inset-sm",
  content: "flex min-h-0 flex-1 flex-col gap-stack-sm overflow-y-auto overflow-x-hidden p-inset-xs",
  footer: "mt-auto flex flex-col gap-stack-xs p-inset-sm",
  group: "flex flex-col gap-stack-xs",
  groupLabel: "flex h-control-xs items-center px-inset-sm text-caption text-fg-subtle data-collapsed:sr-only",
  menu: "flex flex-col gap-stack-xs",
  item: "relative",
  button: [
    "flex h-control-md w-full min-w-0 cursor-default select-none items-center gap-inline-sm rounded-md px-inset-sm text-start text-body text-fg outline-none",
    "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard hover:bg-hover data-active:bg-selected data-active:hover:bg-selected-hover",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:-outline-offset-[var(--by-ring-width)] focus-visible:outline-ring",
    "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
    "data-collapsed:justify-center data-collapsed:px-0 [&_svg]:size-icon-md [&_svg]:shrink-0 [&_svg]:text-fg-muted",
  ],
  label: "min-w-0 flex-1 truncate data-collapsed:sr-only",
  inset: "flex min-h-0 min-w-0 flex-1 flex-col",
} as const;

const PanelIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="2" y="3" width="12" height="10" rx="1.5" />
    <path d="M6 3v10" />
  </svg>
);

export interface SidebarProviderProps extends Omit<ComponentProps<"div">, "className"> {
  /** Controlled open state; `defaultOpen` when uncontrolled. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Ctrl+<key> (Cmd on macOS) toggles the sidebar; false turns it off. */
  hotkey?: string | false;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The shell around a Sidebar and its SidebarInset: holds the open state and the Ctrl/Cmd+B toggle. */
export function SidebarProvider({ open: openProp, defaultOpen = true, onOpenChange, hotkey = "b", className, ...props }: SidebarProviderProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const sidebarId = useId();
  const latest = useRef({ open, setOpen: (_: boolean) => {} });
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  latest.current = { open, setOpen };
  useEffect(() => {
    if (!hotkey) return undefined;
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === hotkey.toLowerCase()) {
        event.preventDefault();
        latest.current.setOpen(!latest.current.open);
      }
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [hotkey]);
  return (
    <SidebarContext value={{ open, setOpen, sidebarId }}>
      <div data-slot="sidebar-provider" data-state={open ? "expanded" : "collapsed"} className={cn(classes.provider, className)} {...props} />
    </SidebarContext>
  );
}

export interface SidebarProps extends Omit<ComponentProps<"aside">, "className"> {
  /** The side of the shell. */
  side?: keyof typeof sidebarVariants.side;
  /** What collapsing does: leave an icon rail, hide the panel, or never collapse. */
  collapsible?: Collapsible;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The side panel (an <aside>), size.panel.xs wide; collapsed, an icon rail or hidden. */
export function Sidebar({ side = "left", collapsible = "offcanvas", className, "aria-label": label = "Sidebar", ...props }: SidebarProps) {
  const { open, sidebarId } = useContext(SidebarContext);
  const collapsed = !open && collapsible !== "none" ? collapsible : undefined;
  return (
    <CollapsibleContext value={collapsed === "icon" ? "icon" : "none"}>
      <aside
        id={sidebarId || undefined}
        data-slot="sidebar"
        data-side={side}
        data-state={collapsed ? "collapsed" : "expanded"}
        data-collapsed={collapsed}
        aria-label={label}
        className={cn(classes.root, sidebarVariants.side[side], className)}
        {...props}
      />
    </CollapsibleContext>
  );
}

type WithClass<P> = Omit<P, "className"> & {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
};

/** The top of the panel: a title, a filter box. */
export function SidebarHeader({ className, ...props }: WithClass<ComponentProps<"div">>) {
  return <div data-slot="sidebar-header" className={cn(classes.header, className)} {...props} />;
}

/** The scrolling middle of the panel: groups, menus, a Tree. */
export function SidebarContent({ className, ...props }: WithClass<ComponentProps<"div">>) {
  return <div data-slot="sidebar-content" className={cn(classes.content, className)} {...props} />;
}

/** The bottom of the panel: settings, the user. */
export function SidebarFooter({ className, ...props }: WithClass<ComponentProps<"div">>) {
  return <div data-slot="sidebar-footer" className={cn(classes.footer, className)} {...props} />;
}

const GroupLabelContext = createContext<string | undefined>(undefined);

/** A section of the panel (role="group"), named by its SidebarGroupLabel. */
export function SidebarGroup({ className, ...props }: WithClass<ComponentProps<"div">>) {
  const labelId = useId();
  return (
    <GroupLabelContext value={labelId}>
      <div data-slot="sidebar-group" role="group" aria-labelledby={labelId} className={cn(classes.group, className)} {...props} />
    </GroupLabelContext>
  );
}

/** A section's heading, in type.caption; it names its group, and is visually hidden in the icon rail. */
export function SidebarGroupLabel({ className, ...props }: WithClass<ComponentProps<"div">>) {
  const collapsed = useContext(CollapsibleContext) === "icon";
  const id = useContext(GroupLabelContext);
  return <div data-slot="sidebar-group-label" id={id} data-collapsed={collapsed ? "" : undefined} className={cn(classes.groupLabel, className)} {...props} />;
}

/** A list of entries (a <ul>). */
export function SidebarMenu({ className, ...props }: WithClass<ComponentProps<"ul">>) {
  return <ul data-slot="sidebar-menu" className={cn(classes.menu, className)} {...props} />;
}

/** One entry (an <li>). */
export function SidebarMenuItem({ className, ...props }: WithClass<ComponentProps<"li">>) {
  return <li data-slot="sidebar-menu-item" className={cn(classes.item, className)} {...props} />;
}

export interface SidebarMenuButtonProps extends WithClass<useRender.ComponentProps<"button">> {
  /** The leading icon; the only thing visible in the icon rail. */
  icon?: ReactNode;
  /** The current page or view: color.interactive.selected and aria-current. */
  active?: boolean;
  /** Shown as a tooltip in the icon rail (defaults to the label when it is text). */
  tooltip?: ReactNode;
  /** Shown but not usable. */
  disabled?: boolean;
}

/** An entry's button (or link, through `render`): icon and label; in the icon rail the label becomes a tooltip. */
export function SidebarMenuButton({ icon, active = false, tooltip, disabled = false, className, children, render, ...props }: SidebarMenuButtonProps) {
  const collapsed = useContext(CollapsibleContext) === "icon";
  const element = useRender({
    defaultTagName: "button",
    render,
    props: {
      "data-slot": "sidebar-menu-button",
      type: render ? undefined : "button",
      "aria-current": active ? "page" : undefined,
      "aria-disabled": disabled || undefined,
      "data-active": active ? "" : undefined,
      "data-disabled": disabled ? "" : undefined,
      "data-collapsed": collapsed ? "" : undefined,
      ...props,
      className: cn(classes.button, className),
      children: (
        <>
          {icon}
          <span data-collapsed={collapsed ? "" : undefined} className={cn(classes.label)}>
            {children}
          </span>
        </>
      ),
    },
  });
  const tip = tooltip ?? (typeof children === "string" ? children : undefined);
  if (!collapsed || tip === undefined) return element;
  return (
    <Tooltip>
      <TooltipTrigger render={element} />
      <TooltipContent side="right">{tip}</TooltipContent>
    </Tooltip>
  );
}

export interface SidebarTriggerProps extends Omit<IconButtonProps, "aria-label" | "children"> {
  /** The button's accessible name. */
  "aria-label"?: string;
}

/** Toggles the sidebar: an IconButton with aria-expanded and aria-controls (Ctrl/Cmd+B does the same). */
export function SidebarTrigger({ "aria-label": label = "Toggle sidebar", onClick, ...props }: SidebarTriggerProps) {
  const { open, setOpen, sidebarId } = useContext(SidebarContext);
  return (
    <IconButton
      data-slot="sidebar-trigger"
      aria-label={label}
      aria-expanded={open}
      aria-controls={sidebarId || undefined}
      aria-keyshortcuts="Control+B Meta+B"
      onClick={(event, ...rest) => {
        onClick?.(event, ...rest);
        setOpen(!open);
      }}
      {...props}
    >
      <PanelIcon />
    </IconButton>
  );
}

/** The main area beside the sidebar. */
export function SidebarInset({ className, ...props }: WithClass<ComponentProps<"main">>) {
  return <main data-slot="sidebar-inset" className={cn(classes.inset, className)} {...props} />;
}
