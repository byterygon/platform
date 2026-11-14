import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/context-menu/context-menu";

const area = "flex min-h-control-lg w-full items-center justify-center rounded-md border border-dashed border-border-strong px-inset-md text-body text-fg-muted";

/** The smallest useful ContextMenu: right-click an area for its actions. */
export function ContextMenuMinimal() {
  return (
    <ContextMenu>
      <ContextMenuTrigger className={area}>Right-click the table “orders”</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Open query tab</ContextMenuItem>
        <ContextMenuItem>Copy name</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * A connection node in the schema tree: the actions with shortcuts, a "Copy" submenu, the tree's
 * view options as checkbox and radio items, a disabled action and a destructive one.
 */
export function ContextMenuRealistic() {
  return (
    <ContextMenu>
      <ContextMenuTrigger className={area}>Right-click the connection “orders-prod”</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuLabel>orders-prod</ContextMenuLabel>
          <ContextMenuItem>
            Connect
            <ContextMenuShortcut>Enter</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem disabled>
            Disconnect
            <ContextMenuShortcut>Ctrl+Shift+D</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem>
            Open query tab
            <ContextMenuShortcut>Ctrl+T</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem>
            Refresh
            <ContextMenuShortcut>F5</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Copy</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            <ContextMenuItem>Connection id</ContextMenuItem>
            <ContextMenuItem>Host and port</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuCheckboxItem defaultChecked>Show system schemas</ContextMenuCheckboxItem>
        <ContextMenuRadioGroup defaultValue="name">
          <ContextMenuRadioItem value="name">Sort by name</ContextMenuRadioItem>
          <ContextMenuRadioItem value="size">Sort by size</ContextMenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuItem>Edit…</ContextMenuItem>
        <ContextMenuItem danger>Delete…</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
