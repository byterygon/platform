// Keyboard (Mightyconsole spec §3.4): web only, so keys the browser owns are Alt+Shift. One table
// of actions; the palette and the shortcuts dialog show each action with its binding. Ctrl is Cmd
// on macOS ("Mod").

export type ActionId =
  | "palette"
  | "tool1"
  | "tool2"
  | "tool3"
  | "tool4"
  | "tool5"
  | "tool6"
  | "tool7"
  | "tool8"
  | "tool9"
  | "toggleToolNav"
  | "findTool"
  | "addConnection"
  | "closeTab"
  | "nextTab"
  | "prevTab"
  | "back"
  | "forward"
  | "parent"
  | "primary"
  | "stop"
  | "pause"
  | "clear"
  | "find"
  | "refresh"
  | "focusSidebar"
  | "nextPane"
  | "prevPane"
  | "toggleSidebar"
  | "settings"
  | "shortcuts"
  | "about"
  | "exportProfiles"
  | "importProfiles"
  | "moveProfiles";

export type ActionGroup = "App" | "Tools" | "Connections" | "Tabs" | "Live views" | "Navigation";

export interface Action {
  id: ActionId;
  label: string;
  group: ActionGroup;
  /** Bindings as "Mod+Shift+K"; the first is shown. Empty for palette-only actions. */
  keys: readonly string[];
  keywords?: readonly string[];
  /** Handled by the component that owns the focus (the palette's own hotkeys, the sidebar's). */
  local?: boolean;
}

export const ACTIONS: readonly Action[] = [
  { id: "palette", label: "Command palette", group: "App", keys: ["Mod+K", "Mod+Shift+P"], keywords: ["commands", "search", "go to"], local: true },
  { id: "tool1", label: "Switch to tool 1", group: "Tools", keys: ["Alt+Shift+1"] },
  { id: "tool2", label: "Switch to tool 2", group: "Tools", keys: ["Alt+Shift+2"] },
  { id: "tool3", label: "Switch to tool 3", group: "Tools", keys: ["Alt+Shift+3"] },
  { id: "tool4", label: "Switch to tool 4", group: "Tools", keys: ["Alt+Shift+4"] },
  { id: "tool5", label: "Switch to tool 5", group: "Tools", keys: ["Alt+Shift+5"] },
  { id: "tool6", label: "Switch to tool 6", group: "Tools", keys: ["Alt+Shift+6"] },
  { id: "tool7", label: "Switch to tool 7", group: "Tools", keys: ["Alt+Shift+7"] },
  { id: "tool8", label: "Switch to tool 8", group: "Tools", keys: ["Alt+Shift+8"] },
  { id: "tool9", label: "Switch to tool 9", group: "Tools", keys: ["Alt+Shift+9"] },
  // Palette only: Shift+Alt+B and Shift+Alt+T are Chrome's own on Windows and Linux (DOC-21 §3.4).
  { id: "toggleToolNav", label: "Collapse or expand the tool list", group: "Tools", keys: [], keywords: ["navigation", "rail", "drawer"] },
  { id: "findTool", label: "Find a tool", group: "Tools", keys: [], keywords: ["navigation", "search", "tools"] },
  { id: "addConnection", label: "Add connection", group: "Connections", keys: ["Mod+Alt+N"], keywords: ["new", "profile"] },
  { id: "exportProfiles", label: "Export profiles", group: "Connections", keys: [], keywords: ["backup", "save", "file"] },
  { id: "importProfiles", label: "Import profiles", group: "Connections", keys: [], keywords: ["restore", "load", "file"] },
  { id: "moveProfiles", label: "Move my profiles to the server", group: "Connections", keys: [], keywords: ["import", "browser", "indexeddb", "migrate"] },
  { id: "closeTab", label: "Close tab", group: "Tabs", keys: ["Alt+Shift+W"] },
  { id: "nextTab", label: "Next tab", group: "Tabs", keys: ["Alt+Shift+]"] },
  { id: "prevTab", label: "Previous tab", group: "Tabs", keys: ["Alt+Shift+["] },
  // DOC-21 §3.7: each tab's own history, as in a browser tab (the browser's buttons do the same).
  { id: "back", label: "Back in this tab", group: "Tabs", keys: ["Alt+Left"], keywords: ["history", "previous place"] },
  { id: "forward", label: "Forward in this tab", group: "Tabs", keys: ["Alt+Right"], keywords: ["history", "next place"] },
  { id: "parent", label: "Go to parent", group: "Tabs", keys: [], keywords: ["up", "breadcrumb", "level above"] },
  { id: "primary", label: "Primary action of the tab (Send, Apply, Run, Consume)", group: "Tabs", keys: ["Mod+Enter"], keywords: ["run", "send", "start"] },
  { id: "stop", label: "Stop the tab's stream", group: "Live views", keys: ["Shift+Escape"], keywords: ["cancel"] },
  { id: "pause", label: "Pause or resume a live view", group: "Live views", keys: ["Alt+Shift+P"] },
  { id: "clear", label: "Clear a live view", group: "Live views", keys: ["Alt+Shift+K"] },
  { id: "find", label: "Find in view", group: "Live views", keys: ["Mod+F"], keywords: ["search"] },
  { id: "refresh", label: "Refresh the list or node", group: "Navigation", keys: ["Alt+Shift+R"], keywords: ["reload"] },
  { id: "focusSidebar", label: "Focus sidebar", group: "Navigation", keys: ["Mod+Shift+E"] },
  { id: "nextPane", label: "Next pane", group: "Navigation", keys: ["F6"] },
  { id: "prevPane", label: "Previous pane", group: "Navigation", keys: ["Shift+F6"] },
  { id: "toggleSidebar", label: "Toggle sidebar", group: "Navigation", keys: ["Mod+B"], local: true },
  { id: "settings", label: "Settings", group: "App", keys: ["Mod+,"], keywords: ["preferences", "theme", "density"] },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "App", keys: ["Mod+/"], keywords: ["help", "keys"] },
  { id: "about", label: "About Mightyconsole", group: "App", keys: [], keywords: ["version", "diagnostics", "certificate"] },
];

/** Shortcuts owned by a component, listed in the dialog only (spec §3.4, last row). */
export const LOCAL_KEYS: readonly { label: string; keys: readonly string[] }[] = [
  { label: "Terminal: copy, paste (Ctrl+C goes to the process)", keys: ["Mod+Shift+C", "Mod+Shift+V"] },
  { label: "Tree: move, collapse and expand, type-ahead", keys: ["↑", "↓", "←", "→", "Home", "End"] },
  { label: "Message detail: maximize or restore (a double click on its handle does too)", keys: ["Alt+Shift+D"] },
];

export const actionById = (id: ActionId): Action => ACTIONS.find((a) => a.id === id)!;

export const isMac = (): boolean => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

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

/** An action's binding as `aria-keyshortcuts` reads it ("Control+Alt+N", "Meta+Alt+N" on macOS), or undefined for palette-only actions. */
export function ariaBindingOf(id: ActionId, mac = isMac()): string | undefined {
  const first = actionById(id).keys[0];
  if (!first) return undefined;
  return first
    .split("+")
    .map((key) => (key === "Mod" ? (mac ? "Meta" : "Control") : key === "Ctrl" ? "Control" : key))
    .join("+");
}

/** The shown binding of an action, or "" for palette-only actions. */
export function bindingOf(id: ActionId, mac = isMac()): string {
  const first = actionById(id).keys[0];
  return first ? displayBinding(first, mac) : "";
}

const KEY_NAMES: Record<string, string> = { " ": "Space", ArrowLeft: "Left", ArrowRight: "Right" };
const CODES: Record<string, string> = { "]": "BracketRight", "[": "BracketLeft", ",": "Comma", "/": "Slash" };

/** Whether a keydown event is the binding (modifiers exactly, key case-insensitively). */
export function matchesBinding(event: KeyboardEvent, binding: string, mac = isMac()): boolean {
  const parts = binding.split("+");
  const key = parts.pop() ?? "";
  const wantCtrl = parts.includes("Ctrl") || (parts.includes("Mod") && !mac);
  const wantMeta = parts.includes("Mod") && mac;
  if (event.ctrlKey !== wantCtrl || event.metaKey !== wantMeta || event.shiftKey !== parts.includes("Shift") || event.altKey !== parts.includes("Alt")) return false;
  const pressed = KEY_NAMES[event.key] ?? event.key;
  if (pressed.toLowerCase() === key.toLowerCase()) return true;
  // Alt and Shift change the key on many layouts ("1" becomes "!", "]" becomes "}"): use codes.
  const code = event.code;
  if (/^[a-z]$/i.test(key)) return code === `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return code === `Digit${key}`;
  return CODES[key] !== undefined && code === CODES[key];
}

/** The global action a keydown asks for, if any. */
export function actionFor(event: KeyboardEvent, mac = isMac()): Action | undefined {
  return ACTIONS.find((action) => !action.local && action.keys.some((binding) => matchesBinding(event, binding, mac)));
}

/** True inside a text control, where Mod+Enter and Mod+F belong to it unless the tab takes them. */
export function inTextControl(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("input, textarea, [contenteditable=true], [role=textbox], .monaco-editor, .xterm") !== null;
}
