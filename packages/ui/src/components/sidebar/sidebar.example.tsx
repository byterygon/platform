import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/sidebar/sidebar";
import { Tree, type TreeNode } from "@/components/tree/tree";

const DatabaseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <ellipse cx="8" cy="4" rx="5" ry="1.75" />
    <path d="M3 4v8c0 1 2.2 1.75 5 1.75s5-.75 5-1.75V4" />
  </svg>
);

const HistoryIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </svg>
);

const GearIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <circle cx="8" cy="8" r="2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </svg>
);

/** The smallest useful Sidebar: a panel with a menu beside the main area, and its toggle. */
export function SidebarMinimal() {
  return (
    <SidebarProvider hotkey={false} className="h-panel-xs rounded-md border border-border">
      <Sidebar aria-label="Navigation">
        <SidebarContent>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton icon={<DatabaseIcon />} active>
                Connections
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton icon={<HistoryIcon />}>History</SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarContent>
      </Sidebar>
      <SidebarInset className="p-inset-sm">
        <SidebarTrigger />
      </SidebarInset>
    </SidebarProvider>
  );
}

const schema: TreeNode[] = [
  { id: "orders-prod", label: "orders-prod", icon: <DatabaseIcon />, children: [{ id: "public", label: "public" }, { id: "analytics", label: "analytics" }] },
  { id: "staging", label: "staging", icon: <DatabaseIcon /> },
];

/**
 * DBee's shell: the connections tree in a sidebar with a header and a footer (Ctrl+B toggles it),
 * and the same shell collapsed to an icon rail where the labels become tooltips.
 */
export function SidebarRealistic() {
  return (
    <div className="flex w-full flex-col gap-stack-md">
      <SidebarProvider className="h-panel-sm rounded-md border border-border">
        <Sidebar aria-label="Connections" collapsible="icon">
          <SidebarHeader>
            <p className="text-label text-fg">orders workspace</p>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Connections</SidebarGroupLabel>
              <Tree nodes={schema} defaultExpanded={["orders-prod"]} aria-label="Connections and schemas" className="h-panel-xs" />
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton icon={<GearIcon />}>Settings</SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset className="gap-stack-sm p-inset-sm">
          <SidebarTrigger />
          <p className="text-body text-fg-muted">Query tabs go here.</p>
        </SidebarInset>
      </SidebarProvider>

      <SidebarProvider defaultOpen={false} hotkey={false} className="h-panel-xs rounded-md border border-border">
        <Sidebar aria-label="Navigation (collapsed)" collapsible="icon">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Workspace</SidebarGroupLabel>
              <SidebarMenu>
                <SidebarMenuItem>
                  <SidebarMenuButton icon={<DatabaseIcon />} active>
                    Connections
                  </SidebarMenuButton>
                </SidebarMenuItem>
                <SidebarMenuItem>
                  <SidebarMenuButton icon={<HistoryIcon />} disabled>
                    History
                  </SidebarMenuButton>
                </SidebarMenuItem>
              </SidebarMenu>
            </SidebarGroup>
          </SidebarContent>
        </Sidebar>
        <SidebarInset className="p-inset-sm">
          <SidebarTrigger />
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}
