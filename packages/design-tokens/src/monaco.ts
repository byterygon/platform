/**
 * The Monaco theme of the design tokens: which token role colours each Monaco colour id and each
 * token type of the SQL grammars, and the function that turns resolved colours into Monaco's
 * `IStandaloneThemeData`. One source for three users:
 *
 *   - `renderOutputs` (`monaco-theme.ts`, `by-tokens export monaco`, the Theme Studio export),
 *     which reads the resolved token values of a theme;
 *   - `@byterygon/ui`'s `lib/monaco.ts` (SqlEditor), which reads the CSS variables in scope at
 *     the editor, so a data-theme region or a swapped preset is honoured;
 *   - the `@byterygon/monaco-theme` registry item, which is this file as it is.
 *
 * Self-contained on purpose: no imports (a test enforces it), so the registry can ship it and
 * `@byterygon/ui` can import it as TypeScript source without a build. Never pass raw colours to
 * Monaco; add a role here instead.
 */

/** The shape of Monaco's `editor.IStandaloneThemeData`, without importing Monaco. */
export interface MonacoThemeData {
  base: "vs" | "vs-dark" | "hc-black" | "hc-light";
  inherit: boolean;
  rules: { token: string; foreground?: string }[];
  colors: Record<string, string>;
}

/**
 * Token roles (as CSS variables) per Monaco colour id. `editor.*` and `syntax.*` drive the text
 * area; the widgets Monaco draws (find, hover, context menu, suggestions) take the overlay roles, so
 * they look like Byterygon popovers.
 */
export const MONACO_COLORS: Readonly<Record<string, string>> = {
  "editor.background": "--by-editor-bg",
  "editor.foreground": "--by-editor-fg",
  "editorGutter.background": "--by-editor-bg",
  "editor.selectionBackground": "--by-editor-selection",
  "editor.inactiveSelectionBackground": "--by-editor-selection",
  "editor.selectionHighlightBackground": "--by-editor-match",
  "editor.lineHighlightBackground": "--by-editor-line-highlight",
  "editor.lineHighlightBorder": "--by-editor-line-highlight",
  "editorCursor.foreground": "--by-editor-cursor",
  "editorLineNumber.foreground": "--by-editor-gutter",
  "editorLineNumber.activeForeground": "--by-editor-fg",
  "editor.findMatchBackground": "--by-editor-match",
  "editor.findMatchHighlightBackground": "--by-editor-match",
  "editor.wordHighlightBackground": "--by-editor-match",
  "editorBracketMatch.background": "--by-editor-match",
  "editorBracketMatch.border": "--by-color-border-strong",
  "editorIndentGuide.background1": "--by-color-border-muted",
  "editorWhitespace.foreground": "--by-color-border-default",
  "editorError.foreground": "--by-syntax-error",
  "editorWarning.foreground": "--by-color-status-warning-fg",
  "editorInfo.foreground": "--by-color-status-info-fg",
  "editorOverviewRuler.border": "--by-color-border-muted",
  "editorWidget.background": "--by-color-bg-overlay",
  "editorWidget.foreground": "--by-color-fg-default",
  "editorWidget.border": "--by-color-border-default",
  "editorHoverWidget.background": "--by-color-bg-overlay",
  "editorHoverWidget.foreground": "--by-color-fg-default",
  "editorHoverWidget.border": "--by-color-border-default",
  // The suggest widget as the Mightyconsole mockup's flyout (TSK-102): the chosen row in the
  // editor's selection colour, the matched letters in the link colour.
  "editorSuggestWidget.background": "--by-color-bg-overlay",
  "editorSuggestWidget.border": "--by-color-border-default",
  "editorSuggestWidget.foreground": "--by-editor-fg",
  "editorSuggestWidget.selectedBackground": "--by-editor-selection",
  "editorSuggestWidget.selectedForeground": "--by-editor-fg",
  "editorSuggestWidget.selectedIconForeground": "--by-editor-fg",
  "editorSuggestWidget.highlightForeground": "--by-color-fg-link",
  "editorSuggestWidget.focusHighlightForeground": "--by-color-fg-link",
  "menu.background": "--by-color-bg-overlay",
  "menu.foreground": "--by-color-fg-default",
  "menu.selectionBackground": "--by-color-interactive-hover",
  "menu.selectionForeground": "--by-color-fg-default",
  "menu.separatorBackground": "--by-color-border-default",
  "input.background": "--by-color-bg-surface",
  "input.foreground": "--by-color-fg-default",
  "input.border": "--by-color-border-strong",
  "inputOption.activeBorder": "--by-color-ring",
  "focusBorder": "--by-color-ring",
  "scrollbarSlider.background": "--by-color-interactive-hover",
  "scrollbarSlider.hoverBackground": "--by-color-interactive-active",
  "scrollbarSlider.activeBackground": "--by-color-interactive-active",
};

/** Token roles per Monaco token type of the `pgsql` and `sql` grammars (and the common names). */
export const MONACO_TOKENS: Readonly<Record<string, string>> = {
  "": "--by-editor-fg",
  keyword: "--by-syntax-keyword",
  operator: "--by-syntax-operator",
  delimiter: "--by-syntax-operator",
  predefined: "--by-syntax-function",
  "support.function": "--by-syntax-function",
  string: "--by-syntax-string",
  number: "--by-syntax-number",
  comment: "--by-syntax-comment",
  type: "--by-syntax-type",
  identifier: "--by-syntax-identifier",
  constant: "--by-syntax-constant",
  invalid: "--by-syntax-error",
  // Monaco's base themes colour these SQL tokens themselves (red strings, magenta functions).
  "string.sql": "--by-syntax-string",
  "operator.sql": "--by-syntax-operator",
  "predefined.sql": "--by-syntax-function",
};

/** Relative luminance of `#rrggbb`, to pick Monaco's light or dark base for what the tokens leave out. */
export function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!);
}

/**
 * The Monaco theme for the colours a reader resolves: `color(cssVar)` returns `#rrggbb`, or
 * `#rrggbbaa` when translucent. Pure: the same colours give the same theme.
 */
export function monacoTheme(read: { color: (cssVar: string) => string }): MonacoThemeData {
  const colors = Object.fromEntries(Object.entries(MONACO_COLORS).map(([id, cssVar]) => [id, read.color(cssVar)]));
  const rules = Object.entries(MONACO_TOKENS).map(([token, cssVar]) => ({ token, foreground: read.color(cssVar).slice(1, 7) }));
  const dark = luminance(colors["editor.background"]!.slice(0, 7)) < 0.2;
  return { base: dark ? "vs-dark" : "vs", inherit: true, rules, colors };
}
