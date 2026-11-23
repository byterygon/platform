// The title area's tab strip, grouped by tool (DOC-21 §3.2.1, TSK-111). The focused tab's group is
// open: its heading (the tool's mark, name and tab count) then its tabs on one neutral track; every
// other group is folded to a chip, a tab of its own that opens the group on its last focused tab.
// Chips and headings never go into "More tabs". Tabs move inside their group only, groups move as
// a whole; a context menu on a tab or a chip closes and moves them.
import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Spinner } from "@/components/ui/spinner";
import { TabsLabel, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/cn";
import { toolById, toolIcon } from "@/tools/registry";
import type { LiveState, TabRecord, ToolModule } from "@/tools/types";
import type { ConnState, MissingLink } from "./store";

/** A folded group's chip and an open group's heading carry this value: `group:<tool>`. */
export const GROUP_PREFIX = "group:";
export const groupValue = (tool: string) => `${GROUP_PREFIX}${tool}`;
export const groupOfValue = (value: string) => (value.startsWith(GROUP_PREFIX) ? value.slice(GROUP_PREFIX.length) : null);

export const BACKGROUND_LIVE = "Live, paused in the background (catches up when shown)";

export interface TabStripProps {
  tools: readonly ToolModule[];
  tabs: readonly TabRecord[];
  groups: readonly string[];
  activeTab: string | null;
  live: Readonly<Record<string, LiveState | null>>;
  conns: Readonly<Record<string, ConnState>>;
  profileName: (profileId: string) => string;
  /** The missing-profile page's tab (DOC-21 §3.7), after the groups. */
  missingLink: MissingLink | null;
  linkTab: string;
  onCloseLink: () => void;
  onClose: (id: string) => void;
  /** Closes several tabs; a tab holding state asks first (§3.2). */
  onCloseMany: (ids: string[]) => void;
  onMoveTab: (id: string, index: number) => void;
  onMoveGroup: (tool: string, index: number) => void;
  onOpenGroup: (tool: string) => void;
  onCopyLink: (id: string) => void;
  /** Keeps a preview tab: a normal tab from now on. */
  onKeep: (id: string) => void;
  /** The focused tab clicked again: the tree shows its node again (DOC-21 §3.2.1). */
  onRevealAgain: () => void;
}

/**
 * The strip's items in order, as TabsList's onReorder counts them: each group's value, then (for
 * the open group) its tabs, then the link tab.
 */
export function stripOrder(tabs: readonly TabRecord[], groups: readonly string[], openTool: string | null, linkTab: string | null): string[] {
  const out: string[] = [];
  for (const g of groups) {
    out.push(groupValue(g));
    if (g === openTool) for (const t of tabs) if (t.tool === g) out.push(t.id);
  }
  if (linkTab) out.push(linkTab);
  return out;
}

/**
 * What a drop (or Alt+Shift+Arrow) means: a tab moved inside its group (its index among the group's
 * tabs), a group moved (its index among the groups), or nothing when a tab would leave its group.
 */
export function moveOf(order: readonly string[], tabs: readonly TabRecord[], value: string, index: number): { tab: string; index: number } | { group: string; index: number } | null {
  const moved = [...order.filter((v) => v !== value)];
  moved.splice(Math.max(0, Math.min(index, moved.length)), 0, value);
  const group = groupOfValue(value);
  if (group !== null) {
    const groups = moved.map(groupOfValue).filter((g): g is string => g !== null);
    return { group, index: groups.indexOf(group) };
  }
  const tab = tabs.find((t) => t.id === value);
  if (!tab) return null;
  const at = moved.indexOf(value);
  const before = moved[at - 1];
  const sameGroup = before === groupValue(tab.tool) || tabs.some((t) => t.id === before && t.tool === tab.tool);
  if (!sameGroup) return null;
  return { tab: value, index: moved.slice(0, at).filter((v) => tabs.some((t) => t.id === v && t.tool === tab.tool)).length };
}

const plural = (n: number, one: string, other: string) => `${n.toLocaleString("en")} ${n === 1 ? one : other}`;

export function TabStrip(props: TabStripProps) {
  const { tools, tabs, groups, activeTab, live, conns } = props;
  const openTool = tabs.find((t) => t.id === activeTab)?.tool ?? null;
  // The item the context menu is for: a tab id or a group value.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const lastMenu = useRef<string | null>(null);
  const order = stripOrder(tabs, groups, openTool, props.missingLink ? props.linkTab : null);
  // A chip activated by a click or the keyboard is gone once its group opens: focus moves to the
  // group's selected tab instead of falling to the page (only when it did fall).
  const stripRef = useRef<HTMLDivElement | null>(null);
  const focusOpened = useRef(false);
  useEffect(() => {
    if (!focusOpened.current) return;
    focusOpened.current = false;
    if (document.activeElement && document.activeElement !== document.body) return;
    stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [activeTab]);

  const tabState = (t: TabRecord) => {
    const conn = conns[t.profileId];
    const state = live[t.id];
    if (conn?.status === "connecting") return <Spinner size="sm" label="Connecting" />;
    if (conn?.status === "failed") return <span role="img" aria-label="error" className="size-inline-md shrink-0 rounded-full bg-danger" />;
    // A tab that is not the active one holds its live view (DOC-21 §3.2, TSK-107): the dot stays and says so.
    if (state?.status === "live") return <span role="img" aria-label={t.id === activeTab ? "live" : BACKGROUND_LIVE} title={t.id === activeTab ? "Live" : BACKGROUND_LIVE} className="size-inline-md shrink-0 rounded-full bg-success" />;
    return null;
  };
  // A tab's profile shows only where two tabs of its group would read the same.
  const ambiguous = (t: TabRecord) => tabs.some((o) => o !== t && o.tool === t.tool && o.title === t.title && o.profileId !== t.profileId);

  const items = groups.flatMap((g) => {
    const tool = toolById(tools, g);
    const mine = tabs.filter((t) => t.tool === g);
    if (!tool || mine.length === 0) return [];
    const mark = <Icon icon={toolIcon(tool)} />;
    if (g !== openTool) {
      const liveCount = mine.filter((t) => live[t.id]?.status === "live").length;
      const summary = [tool.label, plural(mine.length, "tab", "tabs"), liveCount > 0 ? `${liveCount} live` : ""].filter(Boolean).join(" · ");
      return [
        <TabsTrigger key={groupValue(g)} value={groupValue(g)} onClick={() => (focusOpened.current = true)} keepVisible icon={mark} count={mine.length} countLabel={["tab", "tabs"]} title={`${summary}\n${mine.map((t) => t.title).join(", ")}`} className="ps-inline-md" data-group={g}>
          <span className="sr-only">{tool.label}</span>
          {liveCount > 0 ? <span aria-hidden="true" data-testid="group-live" className="size-inline-sm shrink-0 rounded-full bg-success" /> : null}
        </TabsTrigger>,
      ];
    }
    return [
      <TabsLabel key={groupValue(g)} value={groupValue(g)} icon={mark} className="rounded-s-lg bg-neutral-subtle ps-inline-md pe-inline-sm text-body-1-strong">
        {tool.label}
        <span className="sr-only">, {plural(mine.length, "tab", "tabs")}</span>
        <Badge aria-hidden="true" className="bg-surface tabular-nums">
          {mine.length.toLocaleString("en")}
        </Badge>
      </TabsLabel>,
      ...mine.map((t, i) => (
        <TabsTrigger
          key={t.id}
          value={t.id}
          onClose={() => props.onClose(t.id)}
          onAuxClick={(e) => e.button === 1 && props.onClose(t.id)}
          onClick={() => t.id === activeTab && props.onRevealAgain()}
          // A double click keeps a preview tab (DOC-21 §3.2.1).
          onDoubleClick={() => t.preview && props.onKeep(t.id)}
          title={`${t.title} · ${props.profileName(t.profileId)}${t.preview ? " · preview (double-click to keep it open)" : ""}`}
          data-preview={t.preview ? "" : undefined}
          className={cn("bg-neutral-subtle ps-inline-md", i === mine.length - 1 && "rounded-e-lg")}
        >
          <span className="flex min-w-0 items-center gap-inline-sm">
            <span className={cn("truncate", t.preview && "italic")}>
              {t.title}
              {t.preview ? <span className="sr-only">, preview</span> : null}
              {ambiguous(t) ? <span className="text-fg-subtle"> · {props.profileName(t.profileId)}</span> : null}
            </span>
            {tabState(t)}
          </span>
        </TabsTrigger>
      )),
    ];
  });

  const target = menuFor ?? lastMenu.current;
  const menuGroup = target ? groupOfValue(target) : null;
  const menuTab = target && menuGroup === null ? tabs.find((t) => t.id === target) : undefined;
  const mineOf = (tool: string) => tabs.filter((t) => t.tool === tool);

  return (
    <ContextMenu onOpenChange={(open) => !open && setMenuFor(null)}>
      <ContextMenuTrigger
        ref={stripRef}
        className="flex min-w-0"
        onContextMenuCapture={(e) => {
          const item = (e.target as HTMLElement).closest<HTMLElement>('[data-slot="tabs-item"]');
          const value = item?.dataset["value"] ?? null;
          if (!value || value === props.linkTab) {
            // Not on a tab or a chip: no menu.
            e.preventDefault();
            e.stopPropagation();
            return;
          }
          lastMenu.current = value;
          setMenuFor(value);
        }}
      >
        <TabsList
          aria-label="Tabs"
          onReorder={(value, index) => {
            const move = moveOf(order, tabs, String(value), index);
            if (move && "tab" in move) props.onMoveTab(move.tab, move.index);
            else if (move) props.onMoveGroup(move.group, move.index);
          }}
          className="min-w-0 border-b-0"
        >
          {items}
          {props.missingLink ? (
            <TabsTrigger
              value={props.linkTab}
              icon={(() => {
                const t = toolById(tools, props.missingLink.tool);
                return t ? <Icon icon={toolIcon(t)} /> : undefined;
              })()}
              onClose={props.onCloseLink}
              className="ps-inline-md"
            >
              <span className="truncate">{props.missingLink.title}</span>
            </TabsTrigger>
          ) : null}
        </TabsList>
      </ContextMenuTrigger>
      <ContextMenuContent aria-label={menuTab ? menuTab.title : menuGroup ? `${toolById(tools, menuGroup)?.label ?? menuGroup} group` : "Tabs"}>
        {menuTab ? (
          <>
            {menuTab.preview ? (
              <>
                <ContextMenuItem onClick={() => props.onKeep(menuTab.id)}>
                  Keep open <ContextMenuShortcut>Double-click</ContextMenuShortcut>
                </ContextMenuItem>
                <ContextMenuSeparator />
              </>
            ) : null}
            <ContextMenuItem onClick={() => props.onClose(menuTab.id)}>
              Close <ContextMenuShortcut>Alt+Shift+W</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem disabled={mineOf(menuTab.tool).length < 2} onClick={() => props.onCloseMany(mineOf(menuTab.tool).filter((t) => t.id !== menuTab.id).map((t) => t.id))}>
              Close others in group
            </ContextMenuItem>
            <ContextMenuItem
              disabled={mineOf(menuTab.tool).at(-1)?.id === menuTab.id}
              onClick={() => {
                const mine = mineOf(menuTab.tool);
                props.onCloseMany(mine.slice(mine.findIndex((t) => t.id === menuTab.id) + 1).map((t) => t.id));
              }}
            >
              Close tabs to the right
            </ContextMenuItem>
            <ContextMenuItem onClick={() => props.onCloseMany(mineOf(menuTab.tool).map((t) => t.id))}>Close group ({plural(mineOf(menuTab.tool).length, "tab", "tabs")})</ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => props.onCopyLink(menuTab.id)}>Copy link</ContextMenuItem>
          </>
        ) : menuGroup ? (
          <>
            <ContextMenuItem disabled={menuGroup === openTool} onClick={() => props.onOpenGroup(menuGroup)}>
              Open group
            </ContextMenuItem>
            <ContextMenuItem disabled={groups.indexOf(menuGroup) <= 0} onClick={() => props.onMoveGroup(menuGroup, groups.indexOf(menuGroup) - 1)}>
              Move left
            </ContextMenuItem>
            <ContextMenuItem disabled={groups.indexOf(menuGroup) >= groups.length - 1} onClick={() => props.onMoveGroup(menuGroup, groups.indexOf(menuGroup) + 1)}>
              Move right
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => props.onCloseMany(mineOf(menuGroup).map((t) => t.id))}>Close group ({plural(mineOf(menuGroup).length, "tab", "tabs")})</ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  );
}
