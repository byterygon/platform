import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { useContext, type ReactNode, type Ref } from "react";
import { createMenuParts, menuClasses, menuPopupStyle, MenuScopeContext, useMenuScope } from "@/components/dropdown-menu/dropdown-menu";
import { cn } from "@/lib/cn";
import { useMergedRef } from "@/lib/theme-scope";

// A menu opened by a right-click (or the context-menu key, Shift+F10) on an area, on Base UI's
// ContextMenu: `ContextMenu` is the root, ContextMenuTrigger the area, ContextMenuContent the menu
// at the pointer. Its items are DropdownMenu's (createMenuParts), named ContextMenu*.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const contextMenuVariants = {} as const;

const parts = createMenuParts("context-menu");

export type ContextMenuProps = ContextMenuPrimitive.Root.Props;

/** A context menu on Base UI's ContextMenu. It renders no element: put a ContextMenuTrigger and a ContextMenuContent inside. */
export function ContextMenu({ onOpenChange, ...props }: ContextMenuProps) {
  const { value, onOpenChange: handleOpenChange } = useMenuScope(onOpenChange);
  return (
    <MenuScopeContext value={value}>
      <ContextMenuPrimitive.Root onOpenChange={handleOpenChange} {...props} />
    </MenuScopeContext>
  );
}

export interface ContextMenuTriggerProps extends ContextMenuPrimitive.Trigger.Props {
  /** Reaches the area element. */
  ref?: Ref<HTMLDivElement>;
}

/** The area that opens the menu on right-click or the context-menu key (a `<div>`; `render` changes it). Unstyled. */
export function ContextMenuTrigger({ ref, ...props }: ContextMenuTriggerProps) {
  const { anchorRef } = useContext(MenuScopeContext);
  const merged = useMergedRef<HTMLDivElement>(anchorRef, ref);
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" ref={merged} {...props} />;
}

export interface ContextMenuContentProps extends Omit<ContextMenuPrimitive.Popup.Props, "className" | "children"> {
  children?: ReactNode;
  /** Extra classes for the menu, merged after the component's own so they win. */
  className?: string;
}

/** The portal, the positioner at the pointer (z.popover, the area's theme) and the menu (role="menu"). */
export function ContextMenuContent({ className, style, children, ...props }: ContextMenuContentProps) {
  const { scope } = useContext(MenuScopeContext);
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner {...scope} data-slot="context-menu-positioner" className={cn(menuClasses.positioner)}>
        <ContextMenuPrimitive.Popup data-slot="context-menu-content" style={{ ...menuPopupStyle, ...style }} className={cn(menuClasses.popup, className)} {...props}>
          {children}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

/** An action: role="menuitem"; `danger` for a destructive one. */
export const ContextMenuItem = parts.Item;
/** An option that is on or off: role="menuitemcheckbox". */
export const ContextMenuCheckboxItem = parts.CheckboxItem;
/** One choice among ContextMenuRadioItems. */
export const ContextMenuRadioGroup = parts.RadioGroup;
/** One option of a radio group: role="menuitemradio". */
export const ContextMenuRadioItem = parts.RadioItem;
/** A group of items, named by its ContextMenuLabel. */
export const ContextMenuGroup = parts.Group;
/** A group's heading; not an item. */
export const ContextMenuLabel = parts.Label;
/** A line between items or groups. */
export const ContextMenuSeparator = parts.Separator;
/** The item's keyboard shortcut, at the end of the row. */
export const ContextMenuShortcut = parts.Shortcut;
/** A submenu's root; it renders no element. */
export const ContextMenuSub = ContextMenuPrimitive.SubmenuRoot;
/** The item that opens a submenu. */
export const ContextMenuSubTrigger = parts.SubTrigger;
/** The submenu's popup. */
export const ContextMenuSubContent = parts.SubContent;
