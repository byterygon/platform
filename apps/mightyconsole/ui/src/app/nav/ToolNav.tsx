// The tool navigation (Mightyconsole spec DOC-21 §3.1, TSK-91, Open question 45 (a)–(c)): a Fluent
// nav drawer on the backdrop, the tools grouped by category, pinned tools first, collapsible to a
// 48 px rail. Each item is a button named after its tool (the acceptance checks find tools that
// way); one tab stop, arrows, Home/End and type-ahead inside. The drawer shows the number of
// connected profiles per tool and a danger dot on a failure; the rail a presence dot and a tooltip.
import { type KeyboardEvent, useState } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Icon } from "@/components/ui/icon";
import { Kbd } from "@/components/ui/kbd";
import { SearchInput } from "@/components/ui/search-input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { ChevronDown, ChevronLeft, ChevronRight, Info, Pin } from "@/lib/icons";
import { TOOL_CATEGORIES, orderedTools, toolCategory, toolIcon } from "@/tools/registry";
import type { ToolCategory, ToolModule } from "@/tools/types";

/** From this many tools on, the drawer offers "Find a tool". */
export const FIND_FROM = 9;

/** A tool's connection summary for the navigation. */
export interface ToolState {
  connected: number;
  failed: boolean;
}

/** The navigation's order: pinned tools (in pin order), then each category in turn, by `order`. */
export function navOrder(tools: readonly ToolModule[], pinned: readonly string[]): ToolModule[] {
  const byId = new Map(tools.map((t) => [t.id, t]));
  const pins = pinned.map((id) => byId.get(id)).filter((t): t is ToolModule => t !== undefined);
  const rest = orderedTools(tools).filter((t) => !pinned.includes(t.id));
  return [...pins, ...TOOL_CATEGORIES.flatMap((c) => rest.filter((t) => toolCategory(t) === c))];
}

export interface ToolNavProps {
  tools: readonly ToolModule[];
  selected: string;
  onSelect(id: string): void;
  stateOf(tool: ToolModule): ToolState;
  /** The rail (marks only) instead of the drawer. */
  collapsed: boolean;
  /** The drawer floats over the panes (narrow windows). */
  overlay?: boolean;
  onToggleCollapsed(): void;
  pinned: readonly string[];
  onTogglePin(id: string): void;
  closedCategories: readonly string[];
  onToggleCategory(category: ToolCategory): void;
  /** The binding that selects the nth tool of the navigation order, or "" past the bindings. */
  bindingAt(index: number): string;
  onAbout(): void;
  /** The id of the "Find a tool" field, so the palette's "Find a tool" can focus it. */
  findId?: string;
}

const itemClass = [
  "relative flex w-full min-w-0 shrink-0 cursor-default select-none items-center gap-inline-lg rounded-md px-inline-md text-start text-body-1 text-fg",
  "h-control-lg hover:bg-hover active:bg-pressed",
  "aria-[current=page]:bg-pressed aria-[current=page]:text-body-1-strong",
  "aria-[current=page]:before:absolute aria-[current=page]:before:inset-s-0 aria-[current=page]:before:top-1/2 aria-[current=page]:before:h-icon-md aria-[current=page]:before:w-track aria-[current=page]:before:-translate-y-1/2 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-accent-solid",
  focusRing,
];

export function ToolNav(props: ToolNavProps) {
  const { tools, selected, onSelect, stateOf, collapsed, overlay = false, onToggleCollapsed, pinned, onTogglePin, closedCategories, onToggleCategory, bindingAt, onAbout, findId } = props;
  const [query, setQuery] = useState("");
  const order = navOrder(tools, pinned);
  const indexOf = (id: string) => order.findIndex((t) => t.id === id);
  const finding = !collapsed && tools.length >= FIND_FROM && query.trim() !== "";

  // One tab stop: the selected tool (or the first); arrows, Home, End and type-ahead move inside.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-nav-item]")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    let next = -1;
    if (event.key === "ArrowDown") next = (i + 1) % items.length;
    else if (event.key === "ArrowUp") next = (i + items.length - 1) % items.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = items.length - 1;
    else if (event.key.length === 1 && /\S/.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const k = event.key.toLowerCase();
      for (let step = 1; step <= items.length; step++) {
        const candidate = items[(i + step) % items.length]!;
        if ((candidate.dataset["navLabel"] ?? "").toLowerCase().startsWith(k)) {
          next = (i + step) % items.length;
          break;
        }
      }
    }
    if (next < 0) return;
    event.preventDefault();
    items[next]!.focus();
  };

  const item = (t: ToolModule, isPinned: boolean) => {
    const s = stateOf(t);
    const active = t.id === selected;
    const binding = bindingAt(indexOf(t.id));
    const stateText = s.failed ? "a connection failed" : s.connected > 0 ? `${s.connected} connected` : "not connected";
    const button = (
      <button
        key={t.id}
        type="button"
        data-nav-item=""
        data-nav-label={t.label}
        data-tool={t.id}
        aria-current={active ? "page" : undefined}
        aria-label={t.label}
        aria-keyshortcuts={binding || undefined}
        tabIndex={active || (!order.some((o) => o.id === selected) && indexOf(t.id) === 0) ? 0 : -1}
        onClick={() => onSelect(t.id)}
        className={cn(itemClass, collapsed && "w-control-lg justify-center px-0")}
      >
        <span className="relative inline-flex">
          <Icon icon={toolIcon(t)} size="lg" filled={active} />
          {collapsed && (s.connected > 0 || s.failed) ? (
            <span role="img" aria-label={stateText} className={cn("absolute -inset-e-inline-xs -top-inline-xs size-icon-xs rounded-full border-2 border-canvas", s.failed ? "bg-danger" : "bg-success")} />
          ) : null}
        </span>
        {collapsed ? null : (
          <>
            <span className="min-w-0 flex-1 truncate">{t.label}</span>
            <span className="flex items-center gap-inline-xs text-caption-1 text-fg-muted">
              {s.failed ? <span role="img" aria-label="a connection failed" className="size-icon-xs rounded-full bg-danger" /> : null}
              {s.connected > 0 ? (
                <>
                  <span aria-hidden="true" className="size-icon-xs rounded-full bg-success" />
                  <span aria-label={`${s.connected} connected`}>{s.connected}</span>
                </>
              ) : null}
            </span>
          </>
        )}
      </button>
    );
    // Right-click pins or unpins; in the rail a tooltip gives the name, the state and the binding.
    const trigger = <ContextMenuTrigger render={button} />;
    return (
      <ContextMenu key={t.id}>
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger render={trigger} />
            <TooltipContent side="right">
              {t.label} · {stateText}
              {binding ? <Kbd className="ms-inline-sm">{binding}</Kbd> : null}
            </TooltipContent>
          </Tooltip>
        ) : (
          trigger
        )}
        <ContextMenuContent>
          <ContextMenuItem onClick={() => onTogglePin(t.id)}>
            <Icon icon={Pin} /> {isPinned ? "Unpin" : "Pin to the top"}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const section = (key: string, label: string, list: ToolModule[], category?: ToolCategory) => {
    if (list.length === 0) return null;
    const closed = category !== undefined && closedCategories.includes(category) && !collapsed;
    return (
      <div key={key} role="group" aria-label={label} className="flex flex-col gap-stack-xs">
        {collapsed ? (
          <span aria-hidden="true" className="mx-auto my-stack-xs h-px w-icon-lg bg-border-subtle first:hidden" />
        ) : category !== undefined ? (
          <button type="button" aria-expanded={!closed} onClick={() => onToggleCategory(category)} className={cn("flex h-control-sm items-center gap-inline-sm rounded-md px-inline-md pt-stack-sm text-caption-1-strong text-fg-muted hover:text-fg", focusRing)}>
            <Icon icon={closed ? ChevronRight : ChevronDown} size="sm" />
            <span className="flex-1 text-start">{label}</span>
            {closed ? <span className="text-caption-1 font-normal">{list.length}</span> : null}
          </button>
        ) : (
          <span className="flex h-control-sm items-center px-inline-md pt-stack-sm text-caption-1-strong text-fg-muted">{label}</span>
        )}
        {closed ? null : list.map((t) => item(t, key === "pinned"))}
      </div>
    );
  };

  const pins = order.filter((t) => pinned.includes(t.id));
  const rest = order.filter((t) => !pinned.includes(t.id));
  const matches = finding ? order.filter((t) => t.label.toLowerCase().includes(query.trim().toLowerCase())) : [];

  const footerButton = (label: string, icon: typeof Info, onClick: () => void, extra?: Record<string, unknown>) => {
    const b = (
      <button type="button" aria-label={label} onClick={onClick} className={cn(itemClass, "h-control-md text-fg-muted", collapsed && "w-control-lg justify-center px-0")} {...extra}>
        <Icon icon={icon} />
        {collapsed ? null : <span className="min-w-0 flex-1 truncate">{label}</span>}
      </button>
    );
    return collapsed ? (
      <Tooltip key={label}>
        <TooltipTrigger render={b} />
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
    ) : (
      <span key={label}>{b}</span>
    );
  };

  return (
    <nav
      aria-label="Tools"
      data-pane="rail"
      data-collapsed={collapsed ? "" : undefined}
      data-overlay={overlay ? "" : undefined}
      className={cn(
        "flex shrink-0 flex-col gap-stack-xs pb-inset-xs",
        collapsed ? "w-control-xl items-center" : "w-panel-xs px-inset-xs",
        overlay && "absolute inset-y-0 inset-s-0 z-[var(--by-z-overlay)] rounded-e-lg border-e border-border-subtle bg-surface pt-inset-xs shadow-flyout",
      )}
    >
      {!collapsed && tools.length >= FIND_FROM ? <SearchInput id={findId} aria-label="Find a tool" placeholder="Find a tool" value={query} onValueChange={setQuery} /> : null}
      <div className="flex min-h-0 flex-1 flex-col gap-stack-xs overflow-y-auto" onKeyDown={onKeyDown}>
        {finding ? (
          matches.length > 0 ? matches.map((t) => item(t, pinned.includes(t.id))) : <p className="px-inline-md text-caption-1 text-fg-muted">No tool matches.</p>
        ) : (
          <>
            {section("pinned", "Pinned", pins)}
            {TOOL_CATEGORIES.map((c) => section(c, c, rest.filter((t) => toolCategory(t) === c), c))}
          </>
        )}
      </div>
      <span aria-hidden="true" className={cn("h-px bg-border-subtle", collapsed ? "mx-auto w-icon-lg" : "mx-inline-md")} />
      {footerButton(collapsed ? "Expand the tool list" : "Collapse the tool list", collapsed ? ChevronRight : ChevronLeft, onToggleCollapsed, { "aria-expanded": !collapsed })}
      {footerButton("About Mightyconsole", Info, onAbout)}
    </nav>
  );
}
