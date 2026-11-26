// What the TSK-94 walks share: typing into a Monaco editor of the tab on screen, opening its
// suggestions, checking that nothing covers them, and screenshots in each colour mode and density.
import type { BrowserContext } from "./checklist.mts";

const MAC = process.platform === "darwin";
const CTRL = 2;
const META = 4;

/** The text area of the Monaco editor named `label` that is drawn (another tab may hold one of the same name). */
export const editorArea = (label: string) =>
  `[...document.querySelectorAll("[data-slot=code-editor]")].filter((e) => e.getClientRects().length > 0).map((e) => e.querySelector(".monaco-editor [role=textbox], .monaco-editor textarea")).find((t) => t && (t.getAttribute("aria-label") === ${JSON.stringify(label)} || document.getElementById(t.getAttribute("aria-labelledby") ?? "")?.textContent?.trim() === ${JSON.stringify(label)}))`;

async function key(ctx: Pick<BrowserContext, "page">, key: string, code: string, keyCode: number, modifiers: number): Promise<void> {
  for (const type of ["rawKeyDown", "keyUp"]) await ctx.page.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode, modifiers });
}

/**
 * Scrolls the editor into view and clicks it, as a person does (focus from script does not always
 * reach Monaco), until Monaco has the focus. A click that lands while the page is still laying out
 * the tab is lost; the lab's Workflows walk timed out on one (TSK-141), so it clicks again.
 */
async function clickInto(ctx: Pick<BrowserContext, "page" | "run" | "until">, label: string): Promise<void> {
  await ctx.until(`Boolean(${editorArea(label)})`, `the ${label} editor`);
  const focused = `(${editorArea(label)})?.closest(".monaco-editor")?.classList.contains("focused") === true`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const box = await ctx.run<{ x: number; y: number }>(`(() => { const root = ${editorArea(label)}.closest("[data-slot=code-editor]"); root.scrollIntoView({ block: "center" }); const r = root.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 120), y: r.top + Math.min(r.height / 2, 16) }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await ctx.page.send("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 });
    const done = await ctx.run<boolean>(`new Promise((resolve) => { const start = Date.now(); const tick = () => (${focused} ? resolve(true) : Date.now() - start > 2000 ? resolve(false) : setTimeout(tick, 100)); tick(); })`);
    if (done) return;
  }
  await ctx.until(focused, `the ${label} editor focused`);
}

/** Replaces the editor's text with `text` as typed keys would (select all, then insert). */
export async function typeInEditor(ctx: Pick<BrowserContext, "page" | "run" | "until">, label: string, text: string): Promise<void> {
  await clickInto(ctx, label);
  await key(ctx, "a", "KeyA", 65, MAC ? META : CTRL);
  if (text === "") await key(ctx, "Backspace", "Backspace", 8, 0);
  else await ctx.page.send("Input.insertText", { text });
}

/**
 * Replaces the editor's text with a paste of `text`: one edit, as Ctrl+V. Typing a long text
 * through insertText runs Monaco's auto-indent and auto-close on every line and never returned
 * for 13 KB in a local run (TSK-113).
 */
export async function pasteInEditor(ctx: Pick<BrowserContext, "page" | "run" | "until">, label: string, text: string): Promise<void> {
  await clickInto(ctx, label);
  // The selectAll command too: on macOS the key alone does not reach it.
  for (const type of ["rawKeyDown", "keyUp"]) await ctx.page.send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: MAC ? META : CTRL, ...(type === "rawKeyDown" ? { commands: ["selectAll"] } : {}) });
  await ctx.run(`(() => { const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(text)}); ${editorArea(label)}.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); return true; })()`);
  // The view follows the cursor to the end of the pasted text.
  await ctx.until(`${editorArea(label)}.closest("[data-slot=code-editor]").querySelector(".view-lines").textContent.replace(/\\s+/g, "").includes(${JSON.stringify(text.slice(-60).replace(/\s+/g, ""))})`, `the text pasted into the ${label} editor`);
}

/** The visible suggest widget (Monaco's, in an editor's overflow layer). */
export const SUGGEST = `document.querySelector("[data-slot=code-editor-overflow] .suggest-widget.visible")`;

/** Opens the suggestions at the cursor (Ctrl+Space; a second press toggles the details pane). */
export async function openSuggestions(ctx: Pick<BrowserContext, "page" | "until" | "run">, details = false): Promise<void> {
  await key(ctx, " ", "Space", 32, CTRL);
  await ctx.until(`${SUGGEST} && ${SUGGEST}.querySelectorAll(".monaco-list-row").length > 0`, "the suggestions");
  const shown = `document.querySelector("[data-slot=code-editor-overflow] .suggest-details-container .suggest-details")?.offsetHeight > 0`;
  // Monaco remembers whether the details pane was open; Ctrl+Space again toggles it.
  const already = details && (await ctx.run<boolean>(`new Promise((resolve) => { const start = Date.now(); const tick = () => (${shown} ? resolve(true) : Date.now() - start > 1500 ? resolve(false) : setTimeout(tick, 100)); tick(); })`));
  if (details && !already) {
    await key(ctx, " ", "Space", 32, CTRL);
    await ctx.until(shown, "the details pane");
  }
}

/** The rows of the open suggestions, as text. */
export const suggestionRows = (ctx: Pick<BrowserContext, "run">) => ctx.run<string[]>(`[...${SUGGEST}.querySelectorAll(".monaco-list-row")].map((r) => r.textContent.trim())`);

/** Every row of the open suggestions is on top where it is drawn (no sticky header or layer covers it). */
export const suggestionsOnTop = (ctx: Pick<BrowserContext, "run">) =>
  ctx.run<boolean>(`(() => { const w = ${SUGGEST}; return [...w.querySelectorAll(".monaco-list-row")].every((row) => { const r = row.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + Math.min(40, r.width / 2), r.top + r.height / 2); return hit !== null && w.contains(hit); }); })()`);

/** The four appearances the mockup's frames are drawn in. */
export const APPEARANCES = [
  ["light", "comfortable"],
  ["dark", "comfortable"],
  ["light", "compact"],
  ["dark", "compact"],
] as const;

/** Sets the page's colour mode and density as the settings do (data-theme, data-density on the root). */
export async function appearance(ctx: Pick<BrowserContext, "run">, theme: string, density: string): Promise<void> {
  await ctx.run(`(document.documentElement.dataset.theme = ${JSON.stringify(theme)}, document.documentElement.dataset.density = ${JSON.stringify(density)}, true)`);
  await ctx.run(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => resolve(true), 250))))`);
}
