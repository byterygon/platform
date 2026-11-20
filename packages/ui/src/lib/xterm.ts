import type { FitAddon } from "@xterm/addon-fit";
import type { SearchAddon } from "@xterm/addon-search";
import type { ITheme, Terminal } from "@xterm/xterm";
import type { TokenReader } from "@/lib/token-reader";

// xterm.js for Byterygon UI (Mightyconsole spec §12, TSK-81): loaded lazily from the app's own
// bundle, never from a CDN, with its stylesheet, the fit addon (the terminal follows its element's
// size) and the search addon; its theme comes from the terminal.* roles in scope at the terminal's
// element. The Terminal component imports it.
//
// Bundling: `loadXterm()` is the only way in. Its dynamic imports put xterm.js and its CSS in a
// chunk of their own that a screen without a terminal never downloads. xterm.js needs no worker
// and no network; it creates `<style>` elements at run time, so a CSP needs
// `style-src 'self' 'unsafe-inline'` (as Monaco does).

/** What `loadXterm` gives: the classes the Terminal component constructs. */
export interface Xterm {
  Terminal: typeof Terminal;
  FitAddon: typeof FitAddon;
  SearchAddon: typeof SearchAddon;
}

let loading: Promise<Xterm> | undefined;

/** Loads xterm.js, its addons and its stylesheet once. A failed load is tried again next time. */
export function loadXterm(): Promise<Xterm> {
  loading ??= Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/addon-search"), import("@xterm/xterm/css/xterm.css")]).then(
    ([xterm, fit, search]) => ({ Terminal: xterm.Terminal, FitAddon: fit.FitAddon, SearchAddon: search.SearchAddon }),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** The xterm.js theme keys and the token variable each one reads. */
export const XTERM_COLORS: Readonly<Partial<Record<Exclude<keyof ITheme, "extendedAnsi">, string>>> = {
  foreground: "--by-terminal-fg",
  background: "--by-terminal-bg",
  cursor: "--by-terminal-cursor",
  cursorAccent: "--by-terminal-bg",
  selectionBackground: "--by-terminal-selection",
  black: "--by-terminal-ansi-black",
  red: "--by-terminal-ansi-red",
  green: "--by-terminal-ansi-green",
  yellow: "--by-terminal-ansi-yellow",
  blue: "--by-terminal-ansi-blue",
  magenta: "--by-terminal-ansi-magenta",
  cyan: "--by-terminal-ansi-cyan",
  white: "--by-terminal-ansi-white",
  brightBlack: "--by-terminal-ansi-bright-black",
  brightRed: "--by-terminal-ansi-bright-red",
  brightGreen: "--by-terminal-ansi-bright-green",
  brightYellow: "--by-terminal-ansi-bright-yellow",
  brightBlue: "--by-terminal-ansi-bright-blue",
  brightMagenta: "--by-terminal-ansi-bright-magenta",
  brightCyan: "--by-terminal-ansi-bright-cyan",
  brightWhite: "--by-terminal-ansi-bright-white",
  scrollbarSliderBackground: "--by-color-scrollbar-thumb",
  scrollbarSliderHoverBackground: "--by-color-scrollbar-thumb-hover",
  scrollbarSliderActiveBackground: "--by-color-scrollbar-thumb-hover",
};

/** The xterm.js theme for the tokens a reader resolves. Pure: the same tokens give the same theme. */
export function xtermTheme(read: Pick<TokenReader, "color">): ITheme {
  const theme: Record<string, string> = {};
  for (const [key, cssVar] of Object.entries(XTERM_COLORS)) if (cssVar) theme[key] = read.color(cssVar);
  return theme as ITheme;
}

/** xterm.js's font options from `font.mono` and the density-aware `text.code` role. */
export interface XtermMetrics {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
}

/** The font of `text.code` at the element; `fontSize` overrides the size (the line keeps its ratio). */
export function xtermMetrics(read: Pick<TokenReader, "value">, fontSize?: number): XtermMetrics {
  const size = Number.parseFloat(read.value("--by-text-code-size")) || 13;
  const leading = read.value("--by-text-code-leading");
  const leadingNumber = Number.parseFloat(leading);
  // A unitless leading is a ratio; a length is divided by the size (xterm.js takes a ratio).
  const ratio = /[a-z%]$/.test(leading) ? leadingNumber / size : leadingNumber;
  const family = read.value("--by-font-mono") || "ui-monospace, monospace";
  return { fontFamily: family, fontSize: fontSize ?? size, lineHeight: Number.isFinite(ratio) && ratio >= 1 ? ratio : 1.2 };
}
