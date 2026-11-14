import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarGroup,
  MenubarItem,
  MenubarLabel,
  MenubarMenu,
  MenubarRadioGroup,
  MenubarRadioItem,
  MenubarSeparator,
  MenubarShortcut,
  MenubarSub,
  MenubarSubContent,
  MenubarSubTrigger,
  MenubarTrigger,
} from "@/components/menubar/menubar";

/** The smallest useful Menubar: two menus. */
export function MenubarMinimal() {
  return (
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>New query tab</MenubarItem>
          <MenubarItem>Close tab</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>Help</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>About DBee</MenubarItem>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}

/**
 * A web build's menu row (the desktop keeps the native one): shortcuts, a recent-files submenu,
 * view options as checkbox and radio items, a disabled and a destructive action.
 */
export function MenubarRealistic() {
  return (
    <Menubar>
      <MenubarMenu>
        <MenubarTrigger>File</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>
            New query tab <MenubarShortcut>Alt+Shift+T</MenubarShortcut>
          </MenubarItem>
          <MenubarItem>
            Add connection <MenubarShortcut>Ctrl+Alt+N</MenubarShortcut>
          </MenubarItem>
          <MenubarSub>
            <MenubarSubTrigger>Open recent</MenubarSubTrigger>
            <MenubarSubContent>
              <MenubarItem>orders-by-region.sql</MenubarItem>
              <MenubarItem>vacuum-report.sql</MenubarItem>
            </MenubarSubContent>
          </MenubarSub>
          <MenubarSeparator />
          <MenubarItem>
            Export result <MenubarShortcut>Ctrl+Shift+S</MenubarShortcut>
          </MenubarItem>
          <MenubarItem danger>
            Close tab <MenubarShortcut>Alt+Shift+W</MenubarShortcut>
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>Query</MenubarTrigger>
        <MenubarContent>
          <MenubarItem>
            Run statement <MenubarShortcut>Ctrl+Enter</MenubarShortcut>
          </MenubarItem>
          <MenubarItem disabled>
            Cancel <MenubarShortcut>Shift+Escape</MenubarShortcut>
          </MenubarItem>
        </MenubarContent>
      </MenubarMenu>
      <MenubarMenu>
        <MenubarTrigger>View</MenubarTrigger>
        <MenubarContent>
          <MenubarCheckboxItem defaultChecked>Sidebar</MenubarCheckboxItem>
          <MenubarCheckboxItem>Status bar</MenubarCheckboxItem>
          <MenubarSeparator />
          <MenubarGroup>
            <MenubarLabel>Density</MenubarLabel>
            <MenubarRadioGroup defaultValue="compact">
              <MenubarRadioItem value="compact">Compact</MenubarRadioItem>
              <MenubarRadioItem value="comfortable">Comfortable</MenubarRadioItem>
            </MenubarRadioGroup>
          </MenubarGroup>
        </MenubarContent>
      </MenubarMenu>
    </Menubar>
  );
}
