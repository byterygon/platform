import { act, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, honoursReducedMotion, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { CommandPalette, matchCommand, matchesHotkey, type CommandGroup } from "./command-palette";

afterEach(cleanup);

function Example({ onRun, onExport }: { onRun?: () => void; onExport?: () => void }) {
  const [open, setOpen] = useState(false);
  const groups: CommandGroup[] = [
    {
      label: "Query",
      items: [
        { id: "run", label: "Run statement", shortcut: "Ctrl+Enter", onSelect: onRun ?? (() => {}) },
        { id: "cancel", label: "Cancel running statement", disabled: true, onSelect: () => {} },
        { id: "export", label: "Export result", keywords: ["csv"], onSelect: onExport ?? (() => {}) },
      ],
    },
    { label: "View", items: [{ id: "sidebar", label: "Toggle sidebar", onSelect: () => {} }] },
  ];
  return (
    <>
      <button type="button" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        Commands
      </button>
      <CommandPalette groups={groups} open={open} onOpenChange={setOpen} hotkeys={["Ctrl+K"]} />
    </>
  );
}

const opener = () => $$<HTMLButtonElement>("button").find((b) => b.textContent === "Commands")!;
const palette = () => $('[data-slot="command-palette"]');
const input = () => $<HTMLInputElement>('[data-slot="command-palette-input"]')!;
const options = () => $$('[role="option"]').map((option) => option.textContent);

const type = async (text: string) => {
  await act(async () => {
    const field = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("CommandPalette", () => {
  test("opens a dialog with a combobox search field over a listbox of grouped options", async () => {
    const { container } = render(<Example />);
    await click(opener());
    expect(palette()!.getAttribute("role")).toBe("dialog");
    expect(input().getAttribute("role")).toBe("combobox");
    expect($('[data-slot="command-palette-list"]')!.getAttribute("role")).toBe("listbox");
    expect(options()).toEqual(["Run statementCtrl+Enter", "Cancel running statement", "Export result", "Toggle sidebar"]);
    const group = $('[data-slot="command-palette-group"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Query");
    await waitFor(() => expect(document.activeElement).toBe(input()));
    expect(await axeViolations(container)).toEqual([]);
  });

  test("typing filters by label and keywords and highlights the first match; Enter runs it and closes", async () => {
    const onExport = vi.fn();
    render(<Example onExport={onExport} />);
    await click(opener());
    await type("csv");
    expect(options()).toEqual(["Export result"]);
    await waitFor(() => expect($('[role="option"][data-highlighted]')?.textContent).toBe("Export result"));
    await key("Enter", input());
    expect(onExport).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(palette()).toBeNull());
  });

  test("arrows move the highlight; nothing matching shows the empty text", async () => {
    render(<Example />);
    await click(opener());
    await type("t");
    await key("ArrowDown", input());
    await key("ArrowUp", input());
    await waitFor(() => expect($('[role="option"][data-highlighted]')?.textContent).toBe("Run statementCtrl+Enter"));
    await type("zzz");
    expect(options()).toEqual([]);
    expect($('[data-slot="command-palette-empty"]')!.textContent).toBe("No matching commands");
  });

  test("a disabled command does not run", async () => {
    render(<Example />);
    await click(opener());
    const cancel = $$('[role="option"]').find((option) => option.textContent === "Cancel running statement")!;
    expect(cancel.hasAttribute("data-disabled")).toBe(true);
    await click(cancel);
    expect(palette()).not.toBeNull();
  });

  test("the hotkey toggles it anywhere; Escape closes it and focus returns", async () => {
    render(<Example />);
    opener().focus();
    await key("k", document.body, { ctrlKey: true });
    await waitFor(() => expect(palette()).not.toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(input()));
    await key("Escape", input());
    await waitFor(() => expect(palette()).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener()));
  });

  test("matching and hotkey helpers", () => {
    const command = { id: "x", label: "Export result", keywords: ["csv"], onSelect: () => {} };
    expect(matchCommand(command, "exp res")).toBe(true);
    expect(matchCommand(command, "CSV")).toBe(true);
    expect(matchCommand(command, "query", "Query")).toBe(true);
    expect(matchCommand(command, "json")).toBe(false);
    expect(matchesHotkey(new KeyboardEvent("keydown", { key: "P", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+P")).toBe(true);
    expect(matchesHotkey(new KeyboardEvent("keydown", { key: "k" }), "Ctrl+K")).toBe(false);
  });

  test("takes its region's theme and honours reduced motion", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await click(opener());
    expect($('[data-slot="command-palette-viewport"]')!.getAttribute("data-theme")).toBe("dark");
    expect(honoursReducedMotion($$("[data-slot^='command-palette']"))).toEqual([]);
  });
});
