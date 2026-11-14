import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Menubar as MenubarPrimitive } from "@base-ui/react/menubar";
import { useContext, type ReactNode, type Ref } from "react";
import { createMenuParts, menuClasses, menuOffset, menuPopupStyle, MenuScopeContext, useMenuScope } from "@/components/dropdown-menu/dropdown-menu";
import { cn } from "@/lib/cn";
import { useMergedRef } from "@/lib/theme-scope";

// A row of menus, as at the top of a desktop window, on Base UI's Menubar: `Menubar` is the row
// (role="menubar"), MenubarMenu one menu (Base UI's Menu root), MenubarTrigger its title and
// MenubarContent its popup. Once one menu is open, hovering or arrowing to another opens it. The
// items are DropdownMenu's (createMenuParts), named Menubar*.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const menubarVariants = {} as const;

const classes = {
  root: "flex items-center gap-inline-xs rounded-md border border-border bg-surface p-inset-xs font-sans",
  trigger: [
    "flex h-control-sm cursor-default select-none items-center rounded-sm px-inset-sm text-label text-fg outline-none",
    "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
    "hover:bg-hover data-popup-open:bg-hover",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
    "data-disabled:pointer-events-none data-disabled:text-fg-disabled",
  ],
} as const;

const parts = createMenuParts("menubar");

export interface MenubarProps extends Omit<MenubarPrimitive.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
  /** Reaches the row element. */
  ref?: Ref<HTMLDivElement>;
}

/** The menu row (role="menubar"); put a MenubarMenu per menu inside. Arrow keys move between them. */
export function Menubar({ className, ...props }: MenubarProps) {
  return <MenubarPrimitive data-slot="menubar" className={cn(classes.root, className)} {...props} />;
}

export type MenubarMenuProps = MenuPrimitive.Root.Props;

/** One menu of the row (Base UI's Menu root); it renders no element: a MenubarTrigger and a MenubarContent go inside. */
export function MenubarMenu({ onOpenChange, ...props }: MenubarMenuProps) {
  const { value, onOpenChange: handleOpenChange } = useMenuScope(onOpenChange);
  return (
    <MenuScopeContext value={value}>
      <MenuPrimitive.Root onOpenChange={handleOpenChange} {...props} />
    </MenuScopeContext>
  );
}

export interface MenubarTriggerProps extends Omit<MenuPrimitive.Trigger.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
  /** Reaches the trigger element. */
  ref?: Ref<HTMLButtonElement>;
}

/** The menu's title in the row: color.interactive.hover while hovered or open. */
export function MenubarTrigger({ ref, className, ...props }: MenubarTriggerProps) {
  const { anchorRef } = useContext(MenuScopeContext);
  const merged = useMergedRef<HTMLButtonElement>(anchorRef, ref);
  return <MenuPrimitive.Trigger data-slot="menubar-trigger" ref={merged} className={cn(classes.trigger, className)} {...props} />;
}

export interface MenubarContentProps extends Omit<MenuPrimitive.Popup.Props, "className" | "children"> {
  /** How the menu lines up with its title. */
  align?: MenuPrimitive.Positioner.Props["align"];
  /** The gap to the row in px; space.inline.xs by default. */
  sideOffset?: number;
  children?: ReactNode;
  /** Extra classes for the menu, merged after the component's own so they win. */
  className?: string;
}

/** The portal, the positioner under the title (z.popover, the row's theme) and the menu (role="menu"). */
export function MenubarContent({ align = "start", sideOffset, className, style, children, ...props }: MenubarContentProps) {
  const { anchor, scope } = useContext(MenuScopeContext);
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner {...scope} data-slot="menubar-positioner" side="bottom" align={align} sideOffset={sideOffset ?? (() => menuOffset(anchor.current))} className={cn(menuClasses.positioner)}>
        <MenuPrimitive.Popup data-slot="menubar-content" style={{ ...menuPopupStyle, ...style }} className={cn(menuClasses.popup, className)} {...props}>
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

/** An action: role="menuitem"; `danger` for a destructive one. */
export const MenubarItem = parts.Item;
/** An option that is on or off: role="menuitemcheckbox". */
export const MenubarCheckboxItem = parts.CheckboxItem;
/** One choice among MenubarRadioItems. */
export const MenubarRadioGroup = parts.RadioGroup;
/** One option of a radio group: role="menuitemradio". */
export const MenubarRadioItem = parts.RadioItem;
/** A group of items, named by its MenubarLabel. */
export const MenubarGroup = parts.Group;
/** A group's heading; not an item. */
export const MenubarLabel = parts.Label;
/** A line between items or groups. */
export const MenubarSeparator = parts.Separator;
/** The item's keyboard shortcut, at the end of the row. */
export const MenubarShortcut = parts.Shortcut;
/** A submenu's root; it renders no element. */
export const MenubarSub = MenuPrimitive.SubmenuRoot;
/** The item that opens a submenu. */
export const MenubarSubTrigger = parts.SubTrigger;
/** The submenu's popup. */
export const MenubarSubContent = parts.SubContent;
