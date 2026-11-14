import { useState } from "react";
import { Button } from "@/components/button/button";
import { CommandPalette, type CommandGroup } from "@/components/command-palette/command-palette";
import { Kbd } from "@/components/kbd/kbd";

const noop = () => {};

/** The smallest useful CommandPalette: a button (and Ctrl+K) opening a few commands. */
export function CommandPaletteMinimal() {
  const [open, setOpen] = useState(false);
  const groups: CommandGroup[] = [
    {
      label: "Query",
      items: [
        { id: "run", label: "Run statement", shortcut: "Ctrl+Enter", onSelect: noop },
        { id: "new-tab", label: "New query tab", shortcut: "Ctrl+T", onSelect: noop },
      ],
    },
  ];
  return (
    <>
      <Button variant="secondary" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Commands <Kbd>Ctrl+K</Kbd>
      </Button>
      <CommandPalette groups={groups} open={open} onOpenChange={setOpen} hotkeys={["Mod+K"]} />
    </>
  );
}

const TableIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
    <path d="M2.5 6.5h11M6.5 6.5V13" />
  </svg>
);

/** DBee's palette: every action with its binding, in groups, with keywords and an action that needs a connection. */
export function CommandPaletteRealistic() {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState("nothing yet");
  const run = (label: string) => () => setLast(label);
  const groups: CommandGroup[] = [
    {
      label: "Query",
      items: [
        { id: "run", label: "Run statement", shortcut: "Ctrl+Enter", keywords: ["execute"], onSelect: run("Run statement") },
        { id: "cancel", label: "Cancel running statement", shortcut: "Shift+Escape", disabled: true, onSelect: run("Cancel") },
        { id: "export", label: "Export result", shortcut: "Ctrl+Shift+S", keywords: ["csv", "json", "download"], onSelect: run("Export result") },
        { id: "new-tab", label: "New query tab", shortcut: "Alt+Shift+T", keywords: ["open"], onSelect: run("New query tab") },
      ],
    },
    {
      label: "Connections",
      items: [
        { id: "add", label: "Add connection", shortcut: "Ctrl+Alt+N", onSelect: run("Add connection") },
        { id: "open-orders", label: "Open public.orders", icon: <TableIcon />, keywords: ["table"], onSelect: run("Open public.orders") },
      ],
    },
    {
      label: "View",
      items: [
        { id: "sidebar", label: "Toggle sidebar", shortcut: "Ctrl+B", onSelect: run("Toggle sidebar") },
        { id: "settings", label: "Settings", shortcut: "Ctrl+,", keywords: ["preferences", "theme", "density"], onSelect: run("Settings") },
      ],
    },
  ];
  return (
    <div className="flex items-center gap-inline-md">
      <Button aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Open command palette
      </Button>
      <span className="text-body text-fg-muted">Last command: {last}</span>
      <CommandPalette groups={groups} open={open} onOpenChange={setOpen} hotkeys={["Mod+Shift+P"]} placeholder="Type a command or a table" />
    </div>
  );
}
