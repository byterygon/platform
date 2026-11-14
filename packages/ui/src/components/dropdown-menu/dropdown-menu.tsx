import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { createContext, useContext, type ComponentProps, type CSSProperties, type ReactNode, type Ref, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { tokenPx, useMergedRef, useThemeScope, type ThemeScope } from "@/lib/theme-scope";

// A menu of actions opened from a button, on Base UI's Menu: `DropdownMenu` is the root, the
// parts are shadcn's (DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, CheckboxItem,
// RadioGroup and RadioItem, Group and Label, Separator, Shortcut, Sub with SubTrigger and
// SubContent). ContextMenu and Menubar build the same parts with `createMenuParts` and style
// them with `menuClasses`, so the three menus look and behave alike.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const dropdownMenuVariants = {} as const;

/** The classes DropdownMenu, ContextMenu, Menubar and SplitButton share. */
export const menuClasses = {
  positioner: "z-[var(--by-z-popover)] outline-none",
  popup: [
    "flex flex-col overflow-y-auto overscroll-contain rounded-md border border-border bg-overlay p-inset-xs font-sans text-body text-fg shadow-overlay outline-none",
    "transition duration-[var(--by-motion-duration-base)] ease-enter motion-reduce:transition-none",
    "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:ease-exit",
  ],
  item: [
    "flex min-h-control-sm cursor-default select-none items-center gap-inline-sm whitespace-nowrap rounded-sm px-inset-sm text-body text-fg outline-none",
    "data-highlighted:bg-hover data-popup-open:bg-hover",
    "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
    "data-danger:text-danger-fg data-danger:data-highlighted:bg-danger-subtle",
    "[&_svg]:size-icon-sm [&_svg]:shrink-0",
  ],
  indicator: "flex size-icon-sm shrink-0 items-center justify-center",
  label: "flex min-h-control-xs select-none items-center px-inset-sm text-caption text-fg-subtle",
  separator: "-mx-inset-xs my-inset-xs h-px shrink-0 bg-border",
  shortcut: "ms-auto ps-inline-lg text-caption text-fg-subtle",
  chevron: "ms-auto flex shrink-0 text-fg-muted",
} as const;

/** Base UI's run-time variables for the popup: not tokens, so they go in `style`. */
export const menuPopupStyle: CSSProperties = {
  maxHeight: "var(--available-height)",
  transformOrigin: "var(--transform-origin)",
};

/** The gap between a trigger and its menu: space.inline.xs where the trigger is. */
export const menuOffset = (anchor: Element | null) => tokenPx(anchor, "--by-space-inline-xs", 4);

export const CheckIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);

const DotIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="currentColor">
    <circle cx="8" cy="8" r="3" />
  </svg>
);

export const ChevronRightIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 4 4 4-4 4" />
  </svg>
);

export interface MenuScope {
  anchorRef: (element: Element | null) => void;
  anchor: RefObject<Element | null>;
  scope: ThemeScope;
}

/** The theme scope of the open menu tree: its root sets it, every popup in it (submenus too) reads it. */
export const MenuScopeContext = createContext<MenuScope>({ anchorRef: () => {}, anchor: { current: null }, scope: {} });

/** A menu root's theme scope and the `onOpenChange` that refreshes it. */
export function useMenuScope<Details>(onOpenChange?: (open: boolean, details: Details) => void) {
  const { ref, anchor, scope, refresh } = useThemeScope<Element>();
  return {
    value: { anchorRef: ref, anchor, scope } satisfies MenuScope,
    onOpenChange: (open: boolean, details: Details) => {
      if (open) refresh();
      onOpenChange?.(open, details);
    },
  };
}

type WithClass<P> = Omit<P, "className"> & {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
};

export type MenuItemProps = WithClass<MenuPrimitive.Item.Props> & {
  /** A destructive action: color.status.danger.fg text. */
  danger?: boolean;
};
export type MenuCheckboxItemProps = WithClass<MenuPrimitive.CheckboxItem.Props>;
export type MenuRadioGroupProps = WithClass<MenuPrimitive.RadioGroup.Props>;
export type MenuRadioItemProps = WithClass<MenuPrimitive.RadioItem.Props>;
export type MenuGroupProps = WithClass<MenuPrimitive.Group.Props>;
export type MenuLabelProps = WithClass<MenuPrimitive.GroupLabel.Props>;
export type MenuSeparatorProps = WithClass<MenuPrimitive.Separator.Props>;
export type MenuShortcutProps = WithClass<ComponentProps<"span">>;
export type MenuSubTriggerProps = WithClass<MenuPrimitive.SubmenuTrigger.Props>;
export type MenuSubContentProps = WithClass<Omit<MenuPrimitive.Popup.Props, "children">> & {
  /** The gap to the parent menu in px. */
  sideOffset?: number;
  children?: ReactNode;
};

/**
 * The items of a menu, with `data-slot` names under `prefix` (`dropdown-menu-item`,
 * `context-menu-item`, `menubar-item`). ContextMenu and Menubar export them under their own names.
 */
export function createMenuParts<Prefix extends string>(prefix: Prefix) {
  function Item({ className, danger = false, ...props }: MenuItemProps) {
    return <MenuPrimitive.Item data-slot={`${prefix}-item`} data-danger={danger ? "" : undefined} className={cn(menuClasses.item, className)} {...props} />;
  }
  function CheckboxItem({ className, children, ...props }: MenuCheckboxItemProps) {
    return (
      <MenuPrimitive.CheckboxItem data-slot={`${prefix}-checkbox-item`} className={cn(menuClasses.item, className)} {...props}>
        <span className={menuClasses.indicator}>
          <MenuPrimitive.CheckboxItemIndicator>
            <CheckIcon />
          </MenuPrimitive.CheckboxItemIndicator>
        </span>
        {children}
      </MenuPrimitive.CheckboxItem>
    );
  }
  function RadioGroup({ className, ...props }: MenuRadioGroupProps) {
    return <MenuPrimitive.RadioGroup data-slot={`${prefix}-radio-group`} className={cn("flex flex-col", className)} {...props} />;
  }
  function RadioItem({ className, children, ...props }: MenuRadioItemProps) {
    return (
      <MenuPrimitive.RadioItem data-slot={`${prefix}-radio-item`} className={cn(menuClasses.item, className)} {...props}>
        <span className={menuClasses.indicator}>
          <MenuPrimitive.RadioItemIndicator>
            <DotIcon />
          </MenuPrimitive.RadioItemIndicator>
        </span>
        {children}
      </MenuPrimitive.RadioItem>
    );
  }
  function Group({ className, ...props }: MenuGroupProps) {
    return <MenuPrimitive.Group data-slot={`${prefix}-group`} className={cn("flex flex-col", className)} {...props} />;
  }
  function Label({ className, ...props }: MenuLabelProps) {
    return <MenuPrimitive.GroupLabel data-slot={`${prefix}-label`} className={cn(menuClasses.label, className)} {...props} />;
  }
  function Separator({ className, ...props }: MenuSeparatorProps) {
    return <MenuPrimitive.Separator data-slot={`${prefix}-separator`} className={cn(menuClasses.separator, className)} {...props} />;
  }
  function Shortcut({ className, ...props }: MenuShortcutProps) {
    return <span data-slot={`${prefix}-shortcut`} className={cn(menuClasses.shortcut, className)} {...props} />;
  }
  function SubTrigger({ className, children, ...props }: MenuSubTriggerProps) {
    return (
      <MenuPrimitive.SubmenuTrigger data-slot={`${prefix}-sub-trigger`} className={cn(menuClasses.item, className)} {...props}>
        {children}
        <span className={menuClasses.chevron}>
          <ChevronRightIcon />
        </span>
      </MenuPrimitive.SubmenuTrigger>
    );
  }
  function SubContent({ className, style, sideOffset, children, ...props }: MenuSubContentProps) {
    const { scope } = useContext(MenuScopeContext);
    return (
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner {...scope} data-slot={`${prefix}-positioner`} side="inline-end" align="start" sideOffset={sideOffset ?? 0} className={cn(menuClasses.positioner)}>
          <MenuPrimitive.Popup data-slot={`${prefix}-sub-content`} style={{ ...menuPopupStyle, ...style }} className={cn(menuClasses.popup, className)} {...props}>
            {children}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    );
  }
  return { Item, CheckboxItem, RadioGroup, RadioItem, Group, Label, Separator, Shortcut, SubTrigger, SubContent };
}

const parts = createMenuParts("dropdown-menu");

export type DropdownMenuProps = MenuPrimitive.Root.Props;

/** A dropdown menu on Base UI's Menu. It renders no element: put a DropdownMenuTrigger and a DropdownMenuContent inside. */
export function DropdownMenu({ onOpenChange, ...props }: DropdownMenuProps) {
  const { value, onOpenChange: handleOpenChange } = useMenuScope(onOpenChange);
  return (
    <MenuScopeContext value={value}>
      <MenuPrimitive.Root onOpenChange={handleOpenChange} {...props} />
    </MenuScopeContext>
  );
}

export interface DropdownMenuTriggerProps extends MenuPrimitive.Trigger.Props {
  /** Reaches the trigger element. */
  ref?: Ref<HTMLButtonElement>;
}

/** Opens the menu. Unstyled: render a Button or an IconButton through `render`. */
export function DropdownMenuTrigger({ ref, ...props }: DropdownMenuTriggerProps) {
  const { anchorRef } = useContext(MenuScopeContext);
  const merged = useMergedRef<HTMLButtonElement>(anchorRef, ref);
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" ref={merged} {...props} />;
}

export interface DropdownMenuContentProps extends WithClass<Omit<MenuPrimitive.Popup.Props, "children">> {
  /** The side of the trigger the menu opens on. */
  side?: MenuPrimitive.Positioner.Props["side"];
  /** How the menu lines up with the trigger. */
  align?: MenuPrimitive.Positioner.Props["align"];
  /** The gap to the trigger in px; space.inline.xs by default. */
  sideOffset?: number;
  children?: ReactNode;
}

/** The portal, the positioner (at z.popover, with the trigger's theme) and the menu (role="menu"). */
export function DropdownMenuContent({ side = "bottom", align = "start", sideOffset, className, style, children, ...props }: DropdownMenuContentProps) {
  const { anchor, scope } = useContext(MenuScopeContext);
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner {...scope} data-slot="dropdown-menu-positioner" side={side} align={align} sideOffset={sideOffset ?? (() => menuOffset(anchor.current))} className={cn(menuClasses.positioner)}>
        <MenuPrimitive.Popup data-slot="dropdown-menu-content" style={{ ...menuPopupStyle, ...style }} className={cn(menuClasses.popup, className)} {...props}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** An action: role="menuitem". `danger` for one that destroys data; `closeOnClick` (default true) as Base UI. */
export const DropdownMenuItem = parts.Item;
/** An option that is on or off: role="menuitemcheckbox", a check mark while checked. */
export const DropdownMenuCheckboxItem = parts.CheckboxItem;
/** One choice among DropdownMenuRadioItems: `value` and `onValueChange`. */
export const DropdownMenuRadioGroup = parts.RadioGroup;
/** One option of a radio group: role="menuitemradio", a dot while chosen. */
export const DropdownMenuRadioItem = parts.RadioItem;
/** A group of items, named by the DropdownMenuLabel inside it. */
export const DropdownMenuGroup = parts.Group;
/** A group's heading, in type.caption; not an item. */
export const DropdownMenuLabel = parts.Label;
/** A line between items or groups. */
export const DropdownMenuSeparator = parts.Separator;
/** The item's keyboard shortcut, at the end of the row. */
export const DropdownMenuShortcut = parts.Shortcut;
/** A submenu's root (Base UI's SubmenuRoot); it renders no element. */
export const DropdownMenuSub = MenuPrimitive.SubmenuRoot;
/** The item that opens a submenu, with a chevron; ArrowRight opens it. */
export const DropdownMenuSubTrigger = parts.SubTrigger;
/** The submenu's popup, beside its trigger. */
export const DropdownMenuSubContent = parts.SubContent;
