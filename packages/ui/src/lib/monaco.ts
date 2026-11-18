import type * as MonacoNamespace from "monaco-editor/editor/editor.api";
import { MONACO_COLORS, MONACO_TOKENS, monacoTheme as themeFromTokens } from "@byterygon/design-tokens/monaco";

// Monaco for Byterygon UI (spec section 7): loaded lazily from the app's own bundle, never from a
// CDN or through Monaco's AMD loader, with its one web worker bundled by Vite (`?worker`), and a
// theme generated from the design tokens in scope at the editor's element. SqlEditor imports it.
//
// Bundling: `loadMonaco()` is the only way in. Its dynamic imports make Vite put Monaco (the
// editor core, the features below, the PostgreSQL grammar, its CSS and the codicon font) in chunks
// of their own that a screen without an editor never downloads, and `?worker` emits the editor
// worker as a separate file. Everything is served by the app itself, so it works offline and
// air-gapped. With another bundler, set `self.MonacoEnvironment.getWorker` before the first editor
// mounts and replace the `?worker` import below with that bundler's way of building a worker.

/** The Monaco API (`monaco-editor/editor/editor.api`). */
export type Monaco = typeof MonacoNamespace;
export type MonacoEditor = MonacoNamespace.editor.IStandaloneCodeEditor;
export type MonacoThemeData = MonacoNamespace.editor.IStandaloneThemeData;

interface MonacoEnvironmentHolder {
  MonacoEnvironment?: { getWorker?: (workerId: string, label: string) => Worker; getWorkerUrl?: unknown };
}

let loading: Promise<Monaco> | undefined;

/**
 * Loads Monaco once and returns its API. Only the editor core and the features a SQL editor needs
 * are loaded (find, comment, brackets, clipboard, context menu, multi-cursor, line and word
 * operations, hovers for error markers, go to error, read-only message, placeholder, Tab focus
 * mode), plus the `pgsql` and `sql` grammars; no language service, so the editor worker is the
 * only worker. An app that set `MonacoEnvironment.getWorker` itself keeps its own.
 */
export function loadMonaco(): Promise<Monaco> {
  loading ??= (async () => {
    const [monaco, worker] = await Promise.all([
      import("monaco-editor/editor/editor.api"),
      import("monaco-editor/editor/editor.worker?worker"),
      import("monaco-editor/features/codicon/register"),
      import("monaco-editor/features/find/register"),
      import("monaco-editor/features/comment/register"),
      import("monaco-editor/features/bracketMatching/register"),
      import("monaco-editor/features/clipboard/register"),
      import("monaco-editor/features/contextmenu/register"),
      import("monaco-editor/features/cursorUndo/register"),
      import("monaco-editor/features/multicursor/register"),
      import("monaco-editor/features/linesOperations/register"),
      import("monaco-editor/features/wordOperations/register"),
      import("monaco-editor/features/hover/register"),
      import("monaco-editor/features/gotoError/register"),
      import("monaco-editor/features/readOnlyMessage/register"),
      import("monaco-editor/features/placeholderText/register"),
      import("monaco-editor/features/toggleTabFocusMode/register"),
      import("monaco-editor/languages/definitions/pgsql/register"),
      import("monaco-editor/languages/definitions/sql/register"),
    ]);
    const holder = globalThis as MonacoEnvironmentHolder;
    const EditorWorker = worker.default;
    if (!holder.MonacoEnvironment?.getWorker && !holder.MonacoEnvironment?.getWorkerUrl) {
      // The JSON language service has a worker of its own, loaded with the language (below).
      holder.MonacoEnvironment = {
        ...holder.MonacoEnvironment,
        getWorker: (_workerId: string, label: string) => {
          const Language = languageWorkers.get(label);
          return Language ? new Language({ name: `monaco-${label}` }) : new EditorWorker({ name: "monaco-editor" });
        },
      };
    }
    return monaco;
  })();
  loading.catch(() => {
    loading = undefined;
  });
  return loading;
}

// ---------------------------------------------------------------------------------------------
// Languages beyond SQL (CodeEditor, TSK-80): loaded on demand, each in a chunk of its own. JSON
// brings Monaco's JSON language service (validation, completion and hovers from a JSON Schema)
// and its worker; schemas are given by the app and never fetched (enableSchemaRequest is off).

/** The languages CodeEditor offers. */
export type CodeLanguage = "json" | "yaml" | "protobuf" | "plaintext";

type WorkerConstructor = new (options?: { name?: string }) => Worker;
const languageWorkers = new Map<string, WorkerConstructor>();
const languageLoads = new Map<CodeLanguage, Promise<void>>();

interface JsonDefaults {
  setDiagnosticsOptions: (options: Record<string, unknown>) => void;
}
let jsonDefaults: JsonDefaults | undefined;
/** The JSON Schema of each model (by its URI), all given to the language service together. */
const jsonSchemas = new Map<string, unknown>();

/** Loads a language's grammar (and, for JSON, its language service and worker) once. */
export function loadMonacoLanguage(language: CodeLanguage): Promise<void> {
  if (language === "plaintext") return Promise.resolve();
  let load = languageLoads.get(language);
  if (!load) {
    load = (async () => {
      if (language === "json") {
        const [json, worker] = await Promise.all([import("monaco-editor/languages/features/json/register"), import("monaco-editor/languages/features/json/json.worker?worker")]);
        languageWorkers.set("json", worker.default as WorkerConstructor);
        jsonDefaults = (json as unknown as { jsonDefaults: JsonDefaults }).jsonDefaults;
        applyJsonSchemas();
      } else if (language === "yaml") {
        await import("monaco-editor/languages/definitions/yaml/register");
      } else {
        await import("monaco-editor/languages/definitions/protobuf/register");
      }
    })();
    load.catch(() => languageLoads.delete(language));
    languageLoads.set(language, load);
  }
  return load;
}

function applyJsonSchemas() {
  jsonDefaults?.setDiagnosticsOptions({
    validate: true,
    allowComments: false,
    trailingCommas: "error",
    enableSchemaRequest: false,
    schemaValidation: "error",
    schemas: [...jsonSchemas].map(([uri, schema]) => ({ uri: `${uri}#schema`, fileMatch: [uri], schema })),
  });
}

/** Validates the JSON model at `modelUri` against `schema` (undefined: no schema). */
export function setJsonSchema(modelUri: string, schema: unknown): void {
  if (schema === undefined) jsonSchemas.delete(modelUri);
  else jsonSchemas.set(modelUri, schema);
  applyJsonSchemas();
}

// ---------------------------------------------------------------------------------------------
// Colours: the tokens are OKLCH CSS variables; Monaco's defineTheme takes hex. The browser resolves
// a variable at the editor's element (so a data-theme or data-density region, or a swapped preset,
// is honoured) and the result is converted here.

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const toByte = (x: number) => Math.round(clamp01(x) * 255);
const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const gamma = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

/** OKLab (L 0..1) to gamma-encoded sRGB 0..1, clipped to the gamut (the ramps are in gamut already). */
export function oklabToSrgb(l: number, a: number, b: number): [number, number, number] {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clamp01(gamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    clamp01(gamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    clamp01(gamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
  ];
}

const number = (part: string | undefined, percentScale = 1): number => {
  if (part === undefined || part === "none") return 0;
  return part.endsWith("%") ? (Number.parseFloat(part) / 100) * percentScale : Number.parseFloat(part);
};

/**
 * A computed CSS colour (`rgb()`, `rgba()`, `oklch()`, `oklab()`, `color(srgb ...)` or hex) as
 * `#rrggbb`, or `#rrggbbaa` when it is translucent. Returns null for a format it does not know.
 */
export function cssColorToHex(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (text === "transparent") return "#00000000";
  const out = (rgb: [number, number, number], alpha: number) => {
    const hex = `#${rgb.map((c) => hex2(toByte(c))).join("")}`;
    return alpha >= 1 ? hex : `${hex}${hex2(toByte(alpha))}`;
  };
  const short = /^#([0-9a-f]{3,8})$/.exec(text);
  if (short) {
    const h = short[1]!;
    const full = h.length <= 4 ? [...h].map((c) => c + c).join("") : h;
    if (full.length !== 6 && full.length !== 8) return null;
    return full.length === 8 && full.endsWith("ff") ? `#${full.slice(0, 6)}` : `#${full}`;
  }
  const fn = /^([a-z]+)\((.*)\)$/.exec(text);
  if (!fn) return null;
  const [, name, body] = fn as unknown as [string, string, string];
  const [main, alphaPart] = body.includes("/") ? body.split("/").map((s) => s.trim()) : [body, undefined];
  const parts = main!.split(/[\s,]+/).filter(Boolean);
  let alpha = alphaPart !== undefined ? number(alphaPart) : 1;
  switch (name) {
    case "rgb":
    case "rgba": {
      if (parts.length === 4 && alphaPart === undefined) alpha = number(parts[3]);
      return out([number(parts[0], 255) / 255, number(parts[1], 255) / 255, number(parts[2], 255) / 255], alpha);
    }
    case "oklab":
      return out(oklabToSrgb(number(parts[0]), number(parts[1], 0.4), number(parts[2], 0.4)), alpha);
    case "oklch": {
      const hue = (number(parts[2]) * Math.PI) / 180;
      const chroma = number(parts[1], 0.4);
      return out(oklabToSrgb(number(parts[0]), chroma * Math.cos(hue), chroma * Math.sin(hue)), alpha);
    }
    case "color": {
      if (parts[0] !== "srgb") return null;
      return out([number(parts[1]), number(parts[2]), number(parts[3])], alpha);
    }
    default:
      return null;
  }
}

/** Reads token variables at an element: colours as hex, other values as the computed text. */
export interface TokenReader {
  color: (cssVar: string) => string;
  value: (cssVar: string) => string;
}

/**
 * A reader that resolves variables in the cascade of `element` (its data-theme and data-density
 * region, and whatever preset stylesheet is loaded). A hidden probe element inside it lets the
 * browser substitute the variable chain; colours the converter does not know are drawn on a
 * canvas pixel instead.
 */
export function tokenReader(element: HTMLElement): TokenReader & { dispose: () => void } {
  const probe = element.ownerDocument.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.hidden = true;
  element.append(probe);
  const view = element.ownerDocument.defaultView ?? window;
  let canvas: CanvasRenderingContext2D | null | undefined;
  return {
    color(cssVar) {
      probe.style.color = `var(${cssVar})`;
      const computed = view.getComputedStyle(probe).color;
      const hex = cssColorToHex(computed);
      if (hex) return hex;
      // Unresolved (no token stylesheet, or an environment without CSS): transparent.
      if (computed === "" || computed.includes("var(")) return "#00000000";
      canvas ??= element.ownerDocument.createElement("canvas").getContext("2d", { willReadFrequently: true });
      if (!canvas) return "#00000000";
      canvas.clearRect(0, 0, 1, 1);
      canvas.fillStyle = computed;
      canvas.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = canvas.getImageData(0, 0, 1, 1).data;
      return cssColorToHex(`rgb(${r} ${g} ${b} / ${(a ?? 255) / 255})`) ?? "#00000000";
    },
    value(cssVar) {
      return view.getComputedStyle(element).getPropertyValue(cssVar).trim();
    },
    dispose() {
      probe.remove();
    },
  };
}

// The colour ids and token types Monaco is given, the role each one reads, and the theme function
// are one source with the `monaco-theme.ts` output of @byterygon/design-tokens (and the Theme
// Studio's Monaco export): its src/monaco.ts, installed beside this file as `@/lib/monaco-theme`.
export { MONACO_COLORS, MONACO_TOKENS, luminance } from "@byterygon/design-tokens/monaco";

/** The Monaco theme for the tokens a reader resolves. Pure: the same tokens give the same theme. */
export function monacoTheme(read: Pick<TokenReader, "color">): MonacoThemeData {
  return themeFromTokens(read);
}

/** Text metrics from the density-aware `text.code` and `space.inset` roles, as Monaco options. */
export interface MonacoMetrics {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  letterSpacing: number;
  padding: { top: number; bottom: number };
}

const px = (value: string, fontSize: number) => {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  if (value.endsWith("em")) return n * fontSize;
  return n;
};

/** Monaco's font and spacing options from `text.code.*` and `space.inset.sm` at the element. */
export function monacoMetrics(read: Pick<TokenReader, "value">): MonacoMetrics {
  const fontSize = px(read.value("--by-text-code-size"), 16) || 13;
  const leading = read.value("--by-text-code-leading");
  const leadingNumber = Number.parseFloat(leading);
  const lineHeight = Math.round(/[a-z%]$/.test(leading) ? px(leading, fontSize) : (leadingNumber || 1.5) * fontSize);
  const inset = Math.round(px(read.value("--by-space-inset-sm"), fontSize));
  return {
    fontFamily: read.value("--by-text-code-family") || "monospace",
    fontSize,
    lineHeight,
    letterSpacing: px(read.value("--by-text-code-tracking"), fontSize),
    padding: { top: inset, bottom: inset },
  };
}

/** A short stable name for a theme, so identical themes are defined once. */
export function themeName(theme: MonacoThemeData): string {
  const text = JSON.stringify(theme);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `byterygon-${(hash >>> 0).toString(36)}`;
}

/** The attribute that marks an editor's root, so its colours follow the tokens of its own region. */
export const MONACO_SCOPE_ATTRIBUTE = "data-monaco-scope";
const SCOPE = `[${MONACO_SCOPE_ATTRIBUTE}]`;
const STYLE_ATTRIBUTE = "data-byterygon-monaco";

/**
 * CSS that makes every editor inside a scope take its colours from the token variables of its own
 * region, not from Monaco's page-wide theme: Monaco's colour variables (`--vscode-<id>`, set on
 * `.monaco-editor`) are redefined as the token variables, and each token colour class Monaco
 * generated (`.mtk<n>`, found in its stylesheet by the active theme's colours) as the syntax token
 * it stands for. So a Light and a Dark editor side by side are both right, and a theme switch is a
 * pure CSS change. Monaco's popups outside the editor (the context menu) keep the active theme.
 */
export function scopedCss(theme: MonacoThemeData, monacoCss: string): string {
  const variables = Object.entries(MONACO_COLORS).map(([id, cssVar]) => `  --vscode-${id.replace(/\./g, "-")}: var(${cssVar});`);
  const classes = new Map<string, number[]>();
  for (const m of monacoCss.matchAll(/\.mtk(\d+)\s*\{\s*color:\s*(#[0-9a-f]{6})[0-9a-f]{0,2}\s*;?\s*\}/gi)) {
    const hex = m[2]!.toLowerCase();
    classes.set(hex, [...(classes.get(hex) ?? []), Number(m[1])]);
  }
  const claimed = new Set<number>();
  const rules: string[] = [];
  for (const rule of theme.rules) {
    const cssVar = MONACO_TOKENS[rule.token];
    if (!cssVar || !rule.foreground) continue;
    for (const index of classes.get(`#${rule.foreground.toLowerCase()}`) ?? []) {
      if (claimed.has(index)) continue;
      claimed.add(index);
      rules.push(`${SCOPE} .mtk${index} { color: var(${cssVar}); }`);
    }
  }
  return [`${SCOPE} .monaco-editor {`, ...variables, "}", ...rules].join("\n");
}

/** Monaco's own stylesheets, and the scoped one, so an observer can ignore their updates. */
export const isEditorStylesheet = (node: Node) => node instanceof Element && (node.classList.contains("monaco-colors") || node.hasAttribute(STYLE_ATTRIBUTE));

const defined = new Set<string>();
let active: string | undefined;

/**
 * Defines (once) and activates a theme, and writes the scoped CSS for it into `doc`. Monaco has
 * one theme per page; the scoped CSS makes each editor's text area follow its own region anyway.
 */
export function applyTheme(monaco: Monaco, theme: MonacoThemeData, doc: Document = document): string {
  const name = themeName(theme);
  if (!defined.has(name)) {
    monaco.editor.defineTheme(name, theme);
    defined.add(name);
  }
  if (active !== name) {
    monaco.editor.setTheme(name);
    active = name;
  }
  const monacoCss = [...doc.querySelectorAll("style.monaco-colors")].map((style) => style.textContent ?? "").join("\n");
  let style = doc.head.querySelector<HTMLStyleElement>(`style[${STYLE_ATTRIBUTE}]`);
  if (!style) {
    style = doc.createElement("style");
    style.setAttribute(STYLE_ATTRIBUTE, "");
    doc.head.append(style);
  }
  const css = scopedCss(theme, monacoCss);
  if (style.textContent !== css) style.textContent = css;
  return name;
}
