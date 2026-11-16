// Keyboard-first (DBee spec §9): every action with its desktop and web bindings. Keys the browser
// owns (Ctrl+T, Ctrl+W, Ctrl+Tab, F5) are Alt+Shift on web; the palette and the shortcuts dialog
// show the shell's actual binding. Ctrl is Cmd on macOS ("Mod").
import { isTauri } from "@byterygon/ambidex";

export type ActionId =
  | "palette"
  | "addConnection"
  | "newTab"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "run"
  | "cancel"
  | "toggleRowLimit"
  | "export"
  | "copy"
  | "copyWithHeaders"
  | "openValue"
  | "focusTree"
  | "cyclePanes"
  | "cyclePanesBack"
  | "refreshNode"
  | "connectToggle"
  | "settings"
  | "toggleSidebar"
  | "shortcuts";

export interface Action {
  id: ActionId;
  label: string;
  group: "Query" | "Tabs" | "Connections" | "Results" | "Navigation" | "App";
  /** Bindings as "Mod+Shift+K"; the first is shown. */
  desktop: readonly string[];
  web: readonly string[];
  keywords?: readonly string[];
  /** Handled by the component that owns the focus (the editor, the grid), not by the global listener. */
  local?: boolean;
}

export const ACTIONS: readonly Action[] = [
  { id: "palette", label: "Command palette", group: "App", desktop: ["Mod+K", "Mod+Shift+P"], web: ["Mod+K", "Mod+Shift+P"], keywords: ["commands", "search"] },
  { id: "addConnection", label: "Add connection", group: "Connections", desktop: ["Mod+Alt+N"], web: ["Mod+Alt+N"], keywords: ["new", "database"] },
  { id: "newTab", label: "New query tab", group: "Tabs", desktop: ["Mod+T"], web: ["Alt+Shift+T"], keywords: ["query", "editor"] },
  { id: "closeTab", label: "Close tab", group: "Tabs", desktop: ["Mod+W"], web: ["Alt+Shift+W"] },
  { id: "nextTab", label: "Next tab", group: "Tabs", desktop: ["Ctrl+Tab"], web: ["Alt+Shift+]"] },
  { id: "prevTab", label: "Previous tab", group: "Tabs", desktop: ["Ctrl+Shift+Tab"], web: ["Alt+Shift+["] },
  { id: "run", label: "Run selection or statement under cursor", group: "Query", desktop: ["Mod+Enter"], web: ["Mod+Enter"], keywords: ["execute"] },
  { id: "cancel", label: "Cancel running statement", group: "Query", desktop: ["Shift+Escape"], web: ["Shift+Escape"], keywords: ["stop"] },
  { id: "toggleRowLimit", label: "Toggle row limit", group: "Query", desktop: ["Mod+Shift+L"], web: ["Mod+Shift+L"] },
  { id: "export", label: "Export result", group: "Results", desktop: ["Mod+Shift+S"], web: ["Mod+Shift+S"], keywords: ["csv", "tsv", "json", "save"] },
  { id: "copy", label: "Copy cells", group: "Results", desktop: ["Mod+C"], web: ["Mod+C"], local: true },
  { id: "copyWithHeaders", label: "Copy with headers", group: "Results", desktop: ["Mod+Shift+C"], web: ["Mod+Shift+C"], local: true },
  { id: "openValue", label: "Open cell value", group: "Results", desktop: ["Enter", "F2"], web: ["Enter", "F2"], local: true },
  { id: "focusTree", label: "Focus connections tree", group: "Navigation", desktop: ["Mod+Shift+E"], web: ["Mod+Shift+E"] },
  { id: "cyclePanes", label: "Next pane (tree, editor, results)", group: "Navigation", desktop: ["F6"], web: ["F6"] },
  { id: "cyclePanesBack", label: "Previous pane", group: "Navigation", desktop: ["Shift+F6"], web: ["Shift+F6"] },
  { id: "refreshNode", label: "Refresh tree node", group: "Connections", desktop: ["F5"], web: ["Alt+Shift+F5"] },
  { id: "connectToggle", label: "Connect or disconnect selected", group: "Connections", desktop: ["Mod+Shift+D"], web: ["Mod+Shift+D"] },
  { id: "settings", label: "Settings", group: "App", desktop: ["Mod+,"], web: ["Mod+,"], keywords: ["preferences", "theme", "density"] },
  { id: "toggleSidebar", label: "Toggle sidebar", group: "Navigation", desktop: ["Mod+B"], web: ["Mod+B"] },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "App", desktop: ["Mod+/"], web: ["Mod+/"], keywords: ["help", "keys"] },
];

export type Shell = "desktop" | "web";

export function currentShell(): Shell {
  return isTauri() ? "desktop" : "web";
}

export const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** The bindings of an action in this shell. */
export function bindingsOf(action: Action, shell: Shell): readonly string[] {
  return shell === "desktop" ? action.desktop : action.web;
}

/** "Mod+Shift+K" as the keys the user sees: "⌘ Shift K" on macOS, "Ctrl Shift K" elsewhere. */
export function displayKeys(binding: string, mac = isMac()): string[] {
  return binding.split("+").map((key) => {
    if (key === "Mod") return mac ? "⌘" : "Ctrl";
    if (key === "Alt") return mac ? "⌥" : "Alt";
    return key;
  });
}

export function displayBinding(binding: string, mac = isMac()): string {
  return displayKeys(binding, mac).join("+");
}

const KEY_NAMES: Record<string, string> = { " ": "Space", ",": ",", "/": "/", "[": "[", "]": "]" };

/** Whether a keydown event is the binding (modifiers exactly, key case-insensitively). */
export function matchesBinding(event: KeyboardEvent, binding: string, mac = isMac()): boolean {
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  const wantCtrl = parts.includes("Ctrl") || (parts.includes("Mod") && !mac);
  const wantMeta = parts.includes("Mod") && mac;
  const wantShift = parts.includes("Shift");
  const wantAlt = parts.includes("Alt");
  if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta || event.shiftKey !== wantShift || event.altKey !== wantAlt) return false;
  const pressed = KEY_NAMES[event.key] ?? event.key;
  // Shift changes the key of some bindings ("]" becomes "}" on US keyboards): compare codes too.
  if (pressed.toLowerCase() === key.toLowerCase()) return true;
  const code = event.code;
  if (key.length === 1 && /[a-z]/i.test(key) && code === `Key${key.toUpperCase()}`) return true;
  if (key === "]" && code === "BracketRight") return true;
  if (key === "[" && code === "BracketLeft") return true;
  if (key === "," && code === "Comma") return true;
  if (key === "/" && code === "Slash") return true;
  return false;
}

/** The global action a keydown asks for, if any (local actions are left to their component). */
export function actionFor(event: KeyboardEvent, shell: Shell, mac = isMac()): Action | undefined {
  return ACTIONS.find((action) => !action.local && bindingsOf(action, shell).some((binding) => matchesBinding(event, binding, mac)));
}

/** True inside a text control, where plain keys (F5, Escape) belong to it. */
export function inTextControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, [contenteditable=true], [role=textbox], .monaco-editor") !== null;
}
