import {
  NavigationMenu,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  navigationMenuTriggerStyle,
} from "@/components/navigation-menu/navigation-menu";

/** The smallest useful NavigationMenu: one panel of links and one link in the row. */
export function NavigationMenuMinimal() {
  return (
    <NavigationMenu>
      <NavigationMenuList>
        <NavigationMenuItem>
          <NavigationMenuTrigger>Workspace</NavigationMenuTrigger>
          <NavigationMenuContent>
            <NavigationMenuLink href="#connections">Connections</NavigationMenuLink>
            <NavigationMenuLink href="#saved">Saved queries</NavigationMenuLink>
          </NavigationMenuContent>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink href="#audit" className={navigationMenuTriggerStyle}>
            Audit log
          </NavigationMenuLink>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}

const describedLink = (title: string, description: string) => (
  <>
    <span className="text-body-strong text-fg">{title}</span>
    <span className="text-caption text-fg-muted">{description}</span>
  </>
);

/** The web build's top navigation: two panels of described links, the current page marked, and a plain link. */
export function NavigationMenuRealistic() {
  return (
    <NavigationMenu>
      <NavigationMenuList>
        <NavigationMenuItem value="workspace">
          <NavigationMenuTrigger>Workspace</NavigationMenuTrigger>
          <NavigationMenuContent>
            <NavigationMenuLink href="#connections" active>
              {describedLink("Connections", "Databases you approved access to")}
            </NavigationMenuLink>
            <NavigationMenuLink href="#saved">{describedLink("Saved queries", "SQL files in this workspace")}</NavigationMenuLink>
            <NavigationMenuLink href="#history">{describedLink("History", "Statements you ran, newest first")}</NavigationMenuLink>
          </NavigationMenuContent>
        </NavigationMenuItem>
        <NavigationMenuItem value="admin">
          <NavigationMenuTrigger>Administration</NavigationMenuTrigger>
          <NavigationMenuContent>
            <NavigationMenuLink href="#grants">{describedLink("Grants", "Who may connect where, and until when")}</NavigationMenuLink>
            <NavigationMenuLink href="#audit">{describedLink("Audit log", "Every call with its correlation id")}</NavigationMenuLink>
          </NavigationMenuContent>
        </NavigationMenuItem>
        <NavigationMenuItem>
          <NavigationMenuLink href="#about" className={navigationMenuTriggerStyle}>
            About
          </NavigationMenuLink>
        </NavigationMenuItem>
      </NavigationMenuList>
    </NavigationMenu>
  );
}
