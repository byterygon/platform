import { Autocomplete as AutocompletePrimitive } from "@base-ui/react/autocomplete";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dialogClasses, ScopeAnchor, useDialogScope } from "@/components/dialog/dialog";
import { menuClasses } from "@/components/dropdown-menu/dropdown-menu";
import { cn } from "@/lib/cn";

// The searchable list of every action, opened with a shortcut (Ctrl+K), on Base UI: a Dialog whose
// content is an Autocomplete rendered inline (the list sits under the search field, not in a
// popup). Commands are data: groups of { id, label, shortcut, keywords, disabled, onSelect }.
// Filtering runs in the page on labels and keywords; nothing is fetched.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const commandPaletteVariants = {} as const;

const classes = {
  viewport: "items-start",
  popup: "gap-0 p-0 max-w-panel-lg",
  search: "flex items-center gap-inline-sm border-b border-border px-inset-md text-fg-muted [&_svg]:size-icon-md [&_svg]:shrink-0",
  input: "h-control-lg min-w-0 flex-1 bg-transparent font-sans text-body text-fg outline-none placeholder:text-fg-subtle",
  list: "flex max-h-panel-sm flex-col overflow-y-auto overscroll-contain p-inset-xs outline-none empty:hidden",
  group: "flex flex-col",
  empty: "px-inset-md py-inset-lg text-center text-body text-fg-muted empty:hidden",
} as const;

export interface Command {
  /** Unique in the palette. */
  id: string;
  /** What the command does, as shown and searched ("Open query tab"). */
  label: string;
  /** Its shortcut as text ("Ctrl+T"), shown at the end of the row. */
  shortcut?: string;
  /** More words that find it ("new", "tab"). */
  keywords?: readonly string[];
  /** A leading icon, aria-hidden. */
  icon?: ReactNode;
  /** Shown but cannot run (no connection). */
  disabled?: boolean;
  /** Runs the command; the palette closes first. */
  onSelect: () => void;
}

export interface CommandGroup {
  /** The group's heading ("Query", "Connections"). */
  label: string;
  items: readonly Command[];
}

/** True when every word of `query` is in the command's label, keywords or group. */
export function matchCommand(command: Command, query: string, group = ""): boolean {
  const text = [command.label, group, ...(command.keywords ?? [])].join(" ").toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}

const isMac = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** True when the key event is `hotkey` ("Mod+K", "Ctrl+Shift+P"); Mod is Cmd on macOS, Ctrl elsewhere. */
export function matchesHotkey(event: KeyboardEvent, hotkey: string): boolean {
  const parts = hotkey.split("+").map((part) => part.trim().toLowerCase());
  const keyName = parts.pop()!;
  const mod = parts.includes("mod");
  const want = {
    ctrl: parts.includes("ctrl") || (mod && !isMac()),
    meta: parts.includes("meta") || parts.includes("cmd") || (mod && isMac()),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
  };
  return event.key.toLowerCase() === keyName && event.ctrlKey === want.ctrl && event.metaKey === want.meta && event.shiftKey === want.shift && event.altKey === want.alt;
}

const SearchIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </svg>
);

export interface CommandPaletteItemProps {
  /** The command the row shows. */
  command: Command;
  /** Runs it (CommandPalette closes the palette first). */
  onRun: (command: Command) => void;
}

/** One command's row: role="option" with its icon, label and shortcut. CommandPalette renders one per command. */
export function CommandPaletteItem({ command, onRun }: CommandPaletteItemProps) {
  return (
    <AutocompletePrimitive.Item value={command} disabled={command.disabled ?? false} onClick={() => onRun(command)} data-slot="command-palette-item" className={cn(menuClasses.item)}>
      {command.icon}
      <span className="min-w-0 flex-1 truncate">{command.label}</span>
      {command.shortcut ? (
        <kbd data-slot="command-palette-shortcut" className={cn(menuClasses.shortcut, "font-mono")}>
          {command.shortcut}
        </kbd>
      ) : null}
    </AutocompletePrimitive.Item>
  );
}

export interface CommandPaletteProps {
  /** The commands, in groups. */
  groups: readonly CommandGroup[];
  /** Controlled open state; `defaultOpen` when uncontrolled. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Shortcuts that toggle the palette anywhere in the page ("Mod+K", "Mod+Shift+P"). */
  hotkeys?: readonly string[];
  /** The search field's placeholder. */
  placeholder?: string;
  /** Shown when nothing matches. */
  emptyText?: ReactNode;
  /** The dialog's accessible name (visually hidden). */
  title?: string;
  /** Extra classes for the popup, merged after the component's own so they win. */
  className?: string;
}

/** The command palette: a Dialog with a search field over a filtered, grouped list of commands. */
export function CommandPalette({
  groups = [],
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  hotkeys,
  placeholder = "Type a command",
  emptyText = "No matching commands",
  title = "Command palette",
  className,
}: CommandPaletteProps) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };
  const { anchorRef, scope, refresh } = useDialogScope(open);

  const latest = useRef({ open, setOpen });
  latest.current = { open, setOpen };
  const hotkeyList = hotkeys?.join("|");
  useEffect(() => {
    if (!hotkeyList) return undefined;
    const keys = hotkeyList.split("|");
    const listener = (event: KeyboardEvent) => {
      if (!keys.some((hotkey) => matchesHotkey(event, hotkey))) return;
      event.preventDefault();
      refresh();
      latest.current.setOpen(!latest.current.open);
    };
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, [hotkeyList, refresh]);

  const run = (command: Command) => {
    if (command.disabled) return;
    setOpen(false);
    command.onSelect();
  };

  return (
    <>
      <ScopeAnchor anchorRef={anchorRef} />
      <DialogPrimitive.Root open={open} onOpenChange={(next) => setOpen(next)}>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Backdrop {...scope} data-slot="command-palette-backdrop" className={cn(dialogClasses.backdrop)} />
          <DialogPrimitive.Viewport {...scope} data-slot="command-palette-viewport" className={cn(dialogClasses.viewport, classes.viewport)}>
            <DialogPrimitive.Popup data-slot="command-palette" className={cn(dialogClasses.popup, classes.popup, className)}>
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
              <AutocompletePrimitive.Root
                inline
                open={open}
                items={groups}
                autoHighlight="always"
                filter={(command: Command, query: string) => matchCommand(command, query, groups.find((group) => group.items.includes(command))?.label)}
                itemToStringValue={(command: Command) => command.label}
              >
                <div data-slot="command-palette-search" className={cn(classes.search)}>
                  <SearchIcon />
                  <AutocompletePrimitive.Input data-slot="command-palette-input" aria-label={title} placeholder={placeholder} className={cn(classes.input)} />
                </div>
                <AutocompletePrimitive.Empty data-slot="command-palette-empty" className={cn(classes.empty)}>
                  {emptyText}
                </AutocompletePrimitive.Empty>
                <AutocompletePrimitive.List data-slot="command-palette-list" className={cn(classes.list)}>
                  {(group: CommandGroup) => (
                    <AutocompletePrimitive.Group key={group.label} items={group.items} data-slot="command-palette-group" className={cn(classes.group)}>
                      <AutocompletePrimitive.GroupLabel data-slot="command-palette-group-label" className={cn(menuClasses.label)}>
                        {group.label}
                      </AutocompletePrimitive.GroupLabel>
                      <AutocompletePrimitive.Collection>
                        {(command: Command) => (
                          <CommandPaletteItem key={command.id} command={command} onRun={run} />
                        )}
                      </AutocompletePrimitive.Collection>
                    </AutocompletePrimitive.Group>
                  )}
                </AutocompletePrimitive.List>
              </AutocompletePrimitive.Root>
            </DialogPrimitive.Popup>
          </DialogPrimitive.Viewport>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
    </>
  );
}
