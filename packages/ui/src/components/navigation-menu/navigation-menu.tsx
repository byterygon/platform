import { NavigationMenu as NavigationMenuPrimitive } from "@base-ui/react/navigation-menu";
import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/cn";
import { tokenPx, useThemeScope } from "@/lib/theme-scope";

// Site or app navigation with panels of links, on Base UI's NavigationMenu: `NavigationMenu` is
// the <nav> (it also renders the shared popup), NavigationMenuList the row, NavigationMenuItem
// one entry, NavigationMenuTrigger a title that opens its NavigationMenuContent, and
// NavigationMenuLink a link (in a panel, or straight in the row with navigationMenuTriggerStyle).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const navigationMenuVariants = {} as const;

/** The look of a row entry: NavigationMenuTrigger uses it; give it to a NavigationMenuLink placed straight in the row. */
export const navigationMenuTriggerStyle = [
  "inline-flex h-control-md select-none items-center gap-inline-xs rounded-md px-control-x font-sans text-label text-fg outline-none",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard hover:bg-hover data-popup-open:bg-hover data-active:bg-selected",
  "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "[&_svg]:size-icon-sm",
].join(" ");

const classes = {
  root: "relative font-sans",
  list: "flex items-center gap-inline-xs data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
  icon: "flex text-fg-muted transition-transform duration-[var(--by-motion-duration-base)] ease-standard motion-reduce:transition-none data-popup-open:rotate-180",
  positioner: "z-[var(--by-z-popover)] outline-none",
  popup: [
    "relative overflow-hidden rounded-md border border-border bg-overlay text-body text-fg shadow-overlay outline-none",
    "transition-opacity duration-[var(--by-motion-duration-base)] ease-enter motion-reduce:transition-none",
    "data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:ease-exit",
  ],
  viewport: "relative size-full overflow-hidden",
  content: [
    "flex w-panel-md max-w-full flex-col gap-stack-xs p-inset-sm",
    "transition-opacity duration-[var(--by-motion-duration-base)] ease-standard motion-reduce:transition-none",
    "data-starting-style:opacity-0 data-ending-style:opacity-0",
  ],
  link: [
    "flex flex-col gap-stack-xs rounded-sm p-inset-sm text-body text-fg outline-none",
    "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard hover:bg-hover data-active:bg-selected",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:-outline-offset-[var(--by-ring-width)] focus-visible:outline-ring",
  ],
} as const;

const ChevronIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m4 6 4 4 4-4" />
  </svg>
);

/** Base UI sizes the popup to the open panel through these run-time variables; they are not tokens. */
const popupStyle = { width: "var(--popup-width)", height: "var(--popup-height)", transformOrigin: "var(--transform-origin)" } as const;

export interface NavigationMenuProps extends Omit<NavigationMenuPrimitive.Root.Props, "className"> {
  /** Extra classes for the <nav>, merged after the component's own so they win. */
  className?: string;
  /** Reaches the <nav>. */
  ref?: Ref<HTMLElement>;
  children?: ReactNode;
}

/** The navigation (a <nav>): a NavigationMenuList inside; the panels open in one shared popup below the row. */
export function NavigationMenu({ className, children, ref, onValueChange, ...props }: NavigationMenuProps) {
  const { ref: scopeRef, anchor, scope, refresh } = useThemeScope<HTMLElement>(ref);
  return (
    <NavigationMenuPrimitive.Root
      data-slot="navigation-menu"
      ref={scopeRef}
      onValueChange={(value, details) => {
        if (value !== null) refresh();
        onValueChange?.(value, details);
      }}
      className={cn(classes.root, className)}
      {...props}
    >
      {children}
      <NavigationMenuPrimitive.Portal>
        <NavigationMenuPrimitive.Positioner {...scope} data-slot="navigation-menu-positioner" align="start" sideOffset={() => tokenPx(anchor.current, "--by-space-inline-xs", 4)} className={cn(classes.positioner)}>
          <NavigationMenuPrimitive.Popup data-slot="navigation-menu-popup" style={popupStyle} className={cn(classes.popup)}>
            <NavigationMenuPrimitive.Viewport data-slot="navigation-menu-viewport" className={cn(classes.viewport)} />
          </NavigationMenuPrimitive.Popup>
        </NavigationMenuPrimitive.Positioner>
      </NavigationMenuPrimitive.Portal>
    </NavigationMenuPrimitive.Root>
  );
}

type WithClass<P> = Omit<P, "className"> & {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
};

/** The row of entries (a <ul>). */
export function NavigationMenuList({ className, ...props }: WithClass<NavigationMenuPrimitive.List.Props>) {
  return <NavigationMenuPrimitive.List data-slot="navigation-menu-list" className={cn(classes.list, className)} {...props} />;
}

/** One entry (an <li>): a NavigationMenuTrigger with its NavigationMenuContent, or a NavigationMenuLink. */
export function NavigationMenuItem({ className, ...props }: WithClass<NavigationMenuPrimitive.Item.Props>) {
  return <NavigationMenuPrimitive.Item data-slot="navigation-menu-item" className={cn(className)} {...props} />;
}

/** A title that opens its panel on click, hover or Enter, with a chevron that turns while open. */
export function NavigationMenuTrigger({ className, children, ...props }: WithClass<NavigationMenuPrimitive.Trigger.Props>) {
  return (
    <NavigationMenuPrimitive.Trigger data-slot="navigation-menu-trigger" className={cn(navigationMenuTriggerStyle, className)} {...props}>
      {children}
      <NavigationMenuPrimitive.Icon data-slot="navigation-menu-icon" className={cn(classes.icon)}>
        <ChevronIcon />
      </NavigationMenuPrimitive.Icon>
    </NavigationMenuPrimitive.Trigger>
  );
}

/** The panel of an entry: its links, shown in the shared popup, size.panel.md wide. */
export function NavigationMenuContent({ className, ...props }: WithClass<NavigationMenuPrimitive.Content.Props>) {
  return <NavigationMenuPrimitive.Content data-slot="navigation-menu-content" className={cn(classes.content, className)} {...props} />;
}

/** A link: in a panel a row (title, then a muted description); `active` marks the current page (aria-current). */
export function NavigationMenuLink({ className, ...props }: WithClass<NavigationMenuPrimitive.Link.Props>) {
  return <NavigationMenuPrimitive.Link data-slot="navigation-menu-link" className={cn(classes.link, className)} {...props} />;
}
