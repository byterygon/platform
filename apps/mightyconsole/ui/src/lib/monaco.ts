import type * as MonacoNamespace from "monaco-editor/editor/editor.api";
import { MONACO_COLORS, MONACO_TOKENS, monacoTheme as themeFromTokens } from "@/lib/monaco-theme";

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
      // Completion (TSK-93): the suggest widget (Ctrl+Space) and the snippets its items insert.
      // @ts-expect-error -- the module has no declaration file; it only registers the widget.
      import("monaco-editor/editor/contrib/suggest/browser/suggestController"),
      import("monaco-editor/features/snippet/register"),
      // The services the JSON language's contributions need (code lenses, outline, drag and drop).
      // Monaco collects services once, when the first editor is created, so they are registered
      // here: a JSON editor that mounts after a jq or SQL one would otherwise fail (TSK-93).
      // @ts-expect-error -- no declaration file; the module registers a service.
      import("monaco-editor/editor/contrib/codelens/browser/codeLensCache"),
      // @ts-expect-error -- no declaration file; the module registers a service.
      import("monaco-editor/editor/contrib/documentSymbols/browser/outlineModel"),
      // @ts-expect-error -- no declaration file; the module registers a service.
      import("monaco-editor/editor/common/services/treeViewsDndService"),
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

/** The languages CodeEditor offers; an app adds its own with `registerCodeLanguage`. */
export type CodeLanguage = "json" | "yaml" | "protobuf" | "plaintext" | "jq";

/** Sets up a language an app defines (a Monarch grammar, a configuration) on the Monaco API. */
export type CodeLanguageSetup = (monaco: Monaco) => void | Promise<void>;
const customLanguages = new Map<string, CodeLanguageSetup>();

/**
 * Registers a language for CodeEditor's `language` prop under `id` (TSK-93: Mightyconsole's
 * `temporal-visibility`). `setup` runs once, the first time an editor uses the language, after
 * `monaco.languages.register({ id })`. Registering the same id again keeps the first setup.
 */
export function registerCodeLanguage(id: string, setup: CodeLanguageSetup): void {
  if (!customLanguages.has(id)) customLanguages.set(id, setup);
}

type WorkerConstructor = new (options?: { name?: string }) => Worker;
const languageWorkers = new Map<string, WorkerConstructor>();
const languageLoads = new Map<string, Promise<void>>();

interface JsonDefaults {
  setDiagnosticsOptions: (options: Record<string, unknown>) => void;
  readonly modeConfiguration?: Record<string, unknown>;
  setModeConfiguration?: (configuration: Record<string, unknown>) => void;
}
let jsonDefaults: JsonDefaults | undefined;
/** The JSON Schema of each model (by its URI), all given to the language service together. */
const jsonSchemas = new Map<string, unknown>();

/**
 * Loads a language's grammar (and, for JSON, its language service and worker) once: a built-in
 * one, or one an app registered with `registerCodeLanguage`. An unknown id loads nothing (the
 * text shows plain).
 */
export function loadMonacoLanguage(language: CodeLanguage | (string & {})): Promise<void> {
  if (language === "plaintext") return Promise.resolve();
  let load = languageLoads.get(language);
  if (!load) {
    load = (async () => {
      const setup = customLanguages.get(language);
      if (setup) {
        const monaco = await loadMonaco();
        monaco.languages.register({ id: language });
        await setup(monaco);
      } else if (language === "jq") {
        const monaco = await loadMonaco();
        monaco.languages.register({ id: "jq", aliases: ["jq"] });
        monaco.languages.setMonarchTokensProvider("jq", JQ_GRAMMAR);
        monaco.languages.setLanguageConfiguration("jq", JQ_CONFIGURATION);
      } else if (language === "json") {
        const [monaco, json, worker, lsp] = await Promise.all([
          loadMonaco(),
          import("monaco-editor/languages/features/json/register"),
          import("monaco-editor/languages/features/json/json.worker?worker"),
          // @ts-expect-error -- no declaration file; Monaco's own LSP adapters (CompletionAdapter).
          import("monaco-editor/languages/features/common/lspLanguageFeatures"),
        ]);
        languageWorkers.set("json", worker.default as WorkerConstructor);
        const module = json as unknown as { jsonDefaults: JsonDefaults; getWorker: () => Promise<(...uris: unknown[]) => Promise<JsonWorker>> };
        jsonDefaults = module.jsonDefaults;
        registerJsonCompletion(monaco, module, (lsp as unknown as { CompletionAdapter: CompletionAdapterConstructor }).CompletionAdapter);
        applyJsonSchemas();
      } else if (language === "yaml") {
        await import("monaco-editor/languages/definitions/yaml/register");
      } else if (language === "protobuf") {
        await import("monaco-editor/languages/definitions/protobuf/register");
      }
    })();
    load.catch(() => languageLoads.delete(language));
    languageLoads.set(language, load);
  }
  return load;
}

// jq (TSK-93: the messaging filter): a Monarch grammar of jq 1.7 as jaq reads it. Tokens are the
// ones the design tokens colour (MONACO_TOKENS): keywords, builtins as `predefined`, fields as
// `identifier`, `$variables` as `type`, `@formats` as `support.function`, and string
// interpolation `\(…)` back to code.

/** jq's builtin filters (jq 1.7, as jaq implements them), for highlighting and completion. */
export const JQ_BUILTINS: readonly string[] = [
  "abs", "add", "all", "any", "arrays", "ascii", "ascii_downcase", "ascii_upcase", "booleans", "capture", "ceil",
  "combinations", "contains", "debug", "del", "delpaths", "empty", "endswith", "env", "error", "explode", "first",
  "flatten", "floor", "from_entries", "fromdate", "fromdateiso8601", "fromjson", "getpath", "group_by", "gsub", "halt",
  "halt_error", "has", "implode", "in", "index", "indices", "infinite", "input", "inputs", "inside", "isinfinite",
  "isnan", "isnormal", "isvalid", "iterables", "join", "keys", "keys_unsorted", "last", "leaf_paths", "length", "limit",
  "log", "ltrimstr", "map", "map_values", "match", "max", "max_by", "min", "min_by", "mktime", "nan", "not", "now",
  "nth", "nulls", "numbers", "objects", "path", "paths", "pick", "pow", "range", "recurse", "repeat", "reverse",
  "rindex", "round", "rtrimstr", "scalars", "scan", "select", "setpath", "sort", "sort_by", "split", "splits", "sqrt",
  "startswith", "strftime", "strings", "strptime", "sub", "test", "to_entries", "toarray", "todate", "todateiso8601",
  "tojson", "tonumber", "tostream", "tostring", "transpose", "trim", "ltrim", "rtrim", "type", "unique", "unique_by",
  "until", "utf8bytelength", "values", "walk", "while", "with_entries",
];

const JQ_KEYWORDS = ["def", "if", "then", "elif", "else", "end", "as", "reduce", "foreach", "try", "catch", "label", "import", "include", "and", "or", "__loc__"];

/** The jq Monarch grammar (`monaco.languages.IMonarchLanguage`). */
export const JQ_GRAMMAR: MonacoNamespace.languages.IMonarchLanguage = {
  defaultToken: "",
  keywords: JQ_KEYWORDS,
  constants: ["true", "false", "null"],
  builtins: [...JQ_BUILTINS],
  tokenizer: {
    root: [{ include: "@code" }],
    code: [
      [/#.*$/, "comment"],
      [/"/, "string", "@string"],
      [/\$[A-Za-z_][\w]*/, "type"],
      [/@[A-Za-z_][\w]*/, "support.function"],
      [/\.\.?(?:[A-Za-z_][\w]*)?/, "identifier"],
      [/\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/[A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*/, { cases: { "@keywords": "keyword", "@constants": "constant", "@builtins": "predefined", "@default": "identifier" } }],
      [/\|=|\+=|-=|\*=|\/=|%=|\/\/=|\/\/|==|!=|<=|>=|\?\/\/|[|,+\-*\/%=<>?]/, "operator"],
      [/[()[\]{}:;]/, "delimiter"],
    ],
    string: [
      [/[^\\"]+/, "string"],
      [/\\\(/, { token: "delimiter", next: "@interpolation" }],
      [/\\./, "string"],
      [/"/, "string", "@pop"],
    ],
    interpolation: [
      [/\(/, { token: "delimiter", next: "@interpolation" }],
      [/\)/, { token: "delimiter", next: "@pop" }],
      { include: "@code" },
    ],
  },
};

const JQ_CONFIGURATION: MonacoNamespace.languages.LanguageConfiguration = {
  comments: { lineComment: "#" },
  brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
  autoClosingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"', notIn: ["string"] }],
  surroundingPairs: [{ open: "{", close: "}" }, { open: "[", close: "]" }, { open: "(", close: ")" }, { open: '"', close: '"' }],
};

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

// JSON completion with the schema's types (TSK-94): the language service's own items name a
// property and nothing else, so its completion provider is replaced by the same adapter Monaco
// uses (lspLanguageFeatures' CompletionAdapter), and each property item gets the property's type
// and "required" from the schema the worker matched at the cursor (`getMatchingSchemas`, which
// has resolved $ref, allOf and the rest): "string · required", `"email" | "chat"`, "integer 1–5".

/** A JSON Schema, as far as completion reads it. */
export interface JsonSchemaLike {
  type?: string | string[];
  enum?: readonly unknown[];
  const?: unknown;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchemaLike | boolean;
  anyOf?: readonly (JsonSchemaLike | boolean)[];
  oneOf?: readonly (JsonSchemaLike | boolean)[];
  properties?: Record<string, JsonSchemaLike | boolean>;
  required?: readonly string[];
}

const typesOf = (schema: JsonSchemaLike): string[] => {
  if (schema.type !== undefined) return Array.isArray(schema.type) ? [...schema.type] : [schema.type as string];
  if (schema.properties) return ["object"];
  if (schema.items) return ["array"];
  return [];
};

/** What a property's schema allows, in a few words: `"email" | "chat"`, `integer 1–5`, `string[]`, `object`. */
export function describeJsonSchema(schema: JsonSchemaLike | boolean | undefined): string {
  if (schema === undefined || typeof schema === "boolean") return "";
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum && schema.enum.length > 0) {
    const values = schema.enum.slice(0, 4).map((v) => JSON.stringify(v));
    return schema.enum.length > 4 ? `${values.join(" | ")} | …` : values.join(" | ");
  }
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives && typesOf(schema).length === 0) {
    const parts = [...new Set(alternatives.map((s) => describeJsonSchema(s)).filter(Boolean))];
    return parts.slice(0, 3).join(" | ");
  }
  const types = typesOf(schema).filter((t) => !(t === "null" && typesOf(schema).length > 1));
  const nullable = typesOf(schema).includes("null") && types.length > 0;
  let text = types.join(" | ");
  if (types.length === 1 && types[0] === "array" && schema.items && typeof schema.items !== "boolean") {
    const inner = describeJsonSchema(schema.items);
    text = inner && !inner.includes(" ") ? `${inner}[]` : "array";
  }
  const low = typeof schema.exclusiveMinimum === "number" ? schema.exclusiveMinimum : schema.minimum;
  const high = typeof schema.exclusiveMaximum === "number" ? schema.exclusiveMaximum : schema.maximum;
  if (low !== undefined && high !== undefined) text += ` ${low}–${high}`;
  else if (low !== undefined) text += ` ≥ ${low}`;
  else if (high !== undefined) text += ` ≤ ${high}`;
  if (schema.format) text += ` (${schema.format})`;
  if (nullable) text += " | null";
  return text.trim();
}

/** The note beside a property in the list: its type and whether the object requires it. */
export function jsonPropertyDetail(objectSchema: JsonSchemaLike, key: string): string | undefined {
  const property = objectSchema.properties?.[key];
  if (property === undefined) return undefined;
  const parts = [describeJsonSchema(property), objectSchema.required?.includes(key) ? "required" : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

interface JsonAstNode {
  type: string;
  offset: number;
  length: number;
}
interface JsonWorker {
  getMatchingSchemas: (uri: string) => Promise<{ node: JsonAstNode; schema: JsonSchemaLike }[]>;
}
type CompletionAdapterConstructor = new (
  worker: (...uris: unknown[]) => Promise<unknown>,
  triggerCharacters: string[],
) => MonacoNamespace.languages.CompletionItemProvider;

/**
 * The object schemas that apply where the cursor is: of the object nodes around `offset`, the
 * innermost one's. A schema with properties wins over one without (a `oneOf` branch that failed).
 */
export function objectSchemasAt(matching: readonly { node: JsonAstNode; schema: JsonSchemaLike }[], offset: number): JsonSchemaLike[] {
  const around = matching.filter((m) => m.node.type === "object" && m.node.offset < offset && offset <= m.node.offset + m.node.length && m.schema.properties);
  if (around.length === 0) return [];
  const innermost = Math.max(...around.map((m) => m.node.offset));
  return around.filter((m) => m.node.offset === innermost).map((m) => m.schema);
}

let jsonCompletion: MonacoNamespace.IDisposable | undefined;

function registerJsonCompletion(monaco: Monaco, json: { jsonDefaults: JsonDefaults; getWorker: () => Promise<(...uris: unknown[]) => Promise<JsonWorker>> }, Adapter: CompletionAdapterConstructor) {
  if (jsonCompletion || !json.jsonDefaults.setModeConfiguration) return;
  json.jsonDefaults.setModeConfiguration({ ...json.jsonDefaults.modeConfiguration, completionItems: false });
  const worker = (...uris: unknown[]) => json.getWorker().then((get) => get(...uris));
  const adapter = new Adapter(worker, [" ", ":", '"']);
  const propertyKind = monaco.languages.CompletionItemKind.Property;
  jsonCompletion = monaco.languages.registerCompletionItemProvider("json", {
    triggerCharacters: [" ", ":", '"'],
    async provideCompletionItems(model, position, context, token) {
      const list = await adapter.provideCompletionItems(model, position, context, token);
      if (!list || !jsonSchemas.has(model.uri.toString())) return list;
      const properties = list.suggestions.filter((s) => s.kind === propertyKind);
      if (properties.length === 0) return list;
      let schemas: JsonSchemaLike[] = [];
      try {
        const service = (await worker(model.uri)) as JsonWorker;
        schemas = objectSchemasAt(await service.getMatchingSchemas(model.uri.toString()), model.getOffsetAt(position));
      } catch {
        return list;
      }
      for (const item of properties) {
        const key = typeof item.label === "string" ? item.label : item.label.label;
        const detail = schemas.map((s) => jsonPropertyDetail(s, key)).find(Boolean);
        if (!detail) continue;
        item.label = { label: key, description: detail };
        item.detail ??= detail;
      }
      return list;
    },
  });
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
export { MONACO_COLORS, MONACO_TOKENS, luminance } from "@/lib/monaco-theme";

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
  /** The suggestion rows' height: a line and 2 px. */
  suggestLineHeight: number;
}

const px = (value: string, fontSize: number) => {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 0;
  if (value.endsWith("em")) return n * fontSize;
  return n;
};

/**
 * Monaco's font and spacing options from `text.code.*` (or `text.code-sm.*`, a small field's:
 * TSK-94) and `space.inset.sm` at the element.
 */
export function monacoMetrics(read: Pick<TokenReader, "value">, role: "code" | "code-sm" = "code"): MonacoMetrics {
  const text = `--by-text-${role}`;
  const fontSize = px(read.value(`${text}-size`), 16) || 13;
  const leading = read.value(`${text}-leading`);
  const leadingNumber = Number.parseFloat(leading);
  const lineHeight = Math.round(/[a-z%]$/.test(leading) ? px(leading, fontSize) : (leadingNumber || 1.5) * fontSize);
  const inset = Math.round(px(read.value("--by-space-inset-sm"), fontSize));
  return {
    fontFamily: read.value(`${text}-family`) || "monospace",
    fontSize,
    lineHeight,
    letterSpacing: px(read.value(`${text}-tracking`), fontSize),
    padding: { top: inset, bottom: inset },
    suggestLineHeight: lineHeight + 2,
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
  // A one-line editor sits in a field's frame and shows the field's fill (CodeEditor singleLine).
  const singleLine = `${SCOPE}[data-single-line] .monaco-editor { --vscode-editor-background: transparent; --vscode-editorGutter-background: transparent; }`;
  const suggest = [
    `${SCOPE} .monaco-editor .suggest-widget { border-radius: var(--by-radius-md); box-shadow: var(--by-depth-16); overflow: hidden; }`,
    `${SCOPE} .monaco-editor .suggest-widget .monaco-list .monaco-list-row > .contents { padding-inline: var(--by-space-2); }`,
    `${SCOPE} .monaco-editor .suggest-widget .monaco-list .monaco-list-row .main > .left { gap: var(--by-space-1-5); }`,
    // The type at the row's end, as the mockup puts it.
    `${SCOPE} .monaco-editor .suggest-widget .monaco-list .monaco-list-row > .contents > .main { flex: 1 1 auto; }`,
    `${SCOPE} .monaco-editor .suggest-widget .monaco-list .monaco-list-row .main > .right { margin-inline-start: auto; padding-inline-start: var(--by-space-4); }`,
    `${SCOPE} .monaco-editor .suggest-widget .monaco-list .monaco-list-row .details-label { font-family: var(--by-font-sans); font-size: var(--by-text-caption-1-size); color: var(--by-color-fg-muted); }`,
    `${SCOPE} .monaco-editor .suggest-widget .monaco-list .monaco-list-row .monaco-highlighted-label .highlight { font-weight: var(--by-font-weight-semibold); }`,
  ];
  return [`${SCOPE} .monaco-editor {`, ...variables, ...WIDGET_VARIABLES, "}", singleLine, ...suggest, ...WIDGET_RULES, ...rules].join("\n");
}

const W = `${SCOPE} .monaco-editor`;
const ROW = `${W} .suggest-widget .monaco-list .monaco-list-row`;

/** Monaco's non-colour widget variables, as tokens: the corner radius of its flyouts. */
const WIDGET_VARIABLES = ["  --vscode-cornerRadius-large: var(--by-radius-md);", "  --vscode-cornerRadius-medium: var(--by-radius-md);"];

/**
 * The widgets Monaco draws by the text (TSK-94): suggestions, their details, hovers and parameter
 * hints are a Fluent flyout (the mockup's `.msug`: flyout fill and stroke from MONACO_COLORS,
 * radius.md, the flyout's depth). They live in the editor's overflow layer (`overflowWidgetsNode`,
 * TSK-99: z.popover at the end of `<body>`), which carries the editor's scope attribute, so these
 * rules and the token variables above reach them there.
 */
const WIDGET_RULES = [
  // Tailwind's `contents` utility (display: contents) also matches Monaco's `.contents` element
  // and collapses the row's layout (its padding above did nothing); it is a block, as Monaco means it.
  `${ROW} > .contents { display: block; }`,
  // The details pane, hovers and parameter hints as the same flyout.
  `${W} .suggest-details, ${W} .monaco-hover, ${W} .parameter-hints-widget { border-radius: var(--by-radius-md); box-shadow: var(--by-elevation-flyout-shadow); }`,
  `${W} .suggest-widget .monaco-list { border-radius: var(--by-radius-md); }`,
  // The note stays muted on the chosen row too (Monaco gives it the row's colour).
  `${ROW}.focused > .contents > .main > .right > .details-label { color: var(--by-color-fg-muted); opacity: 1; }`,
  `${ROW} > .contents > .main > .right > .details-label { opacity: 1; }`,
  // The details pane and hovers in the UI font, code in the editor's.
  `${W} .suggest-details, ${W} .monaco-hover { font-family: var(--by-font-sans); font-size: var(--by-text-caption-1-size); line-height: var(--by-text-caption-1-leading); }`,
  `${W} .suggest-details code, ${W} .monaco-hover code, ${W} .suggest-details .header .type { font-family: var(--by-font-mono); }`,
];

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

/**
 * A node of its own for an editor's floating widgets (suggestions and their details, hovers,
 * parameter hints), handed to Monaco as `overflowWidgetsDomNode`. It sits at the end of `<body>` on
 * the popover layer, so a sticky table header or any other layer of the page never covers the
 * widgets, and it carries the editor's theme scope and Monaco's `monaco-editor` class, so they keep
 * their colours and styles. Remove it with `dispose` when the editor goes.
 */
export function overflowWidgetsNode(anchor: Element): { node: HTMLElement; follow: (editorNode: HTMLElement | null) => void; sync: () => void; dispose: () => void } {
  const doc = anchor.ownerDocument;
  // The layer: fixed at the origin with no size, on the popover layer, in the editor's theme scope.
  const layer = doc.createElement("div");
  layer.setAttribute("data-slot", "code-editor-overflow");
  // Monaco draws its own DOM in it; the conventions suite skips foreign DOM.
  layer.setAttribute("data-foreign-dom", "");
  // The editor's scope (TSK-94): the scoped CSS (token variables, the flyout's look) reaches the
  // widgets here too. `sync` copies the region's theme and density again after they change.
  layer.setAttribute(MONACO_SCOPE_ATTRIBUTE, "");
  const sync = () => {
    const theme = anchor.closest("[data-theme], .dark, .light");
    if (theme) layer.setAttribute("data-theme", theme.getAttribute("data-theme") ?? (theme.classList.contains("dark") ? "dark" : "light"));
    else layer.removeAttribute("data-theme");
    const density = anchor.closest("[data-density]")?.getAttribute("data-density");
    if (density) layer.setAttribute("data-density", density);
    else layer.removeAttribute("data-density");
  };
  sync();
  layer.style.cssText = "position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: var(--by-z-popover);";
  // Monaco's styles select its widgets under a `monaco-editor` element.
  const node = doc.createElement("div");
  node.className = "monaco-editor";
  layer.append(node);
  doc.body.append(layer);
  // Monaco's theme class (vs, vs-dark, hc-black, hc-light) sits on the editor's own node; the
  // widgets' rules need it on theirs too, kept in step when the theme changes.
  const THEME_CLASSES = ["vs", "vs-dark", "hc-black", "hc-light"];
  let observer: MutationObserver | null = null;
  const follow = (editorNode: HTMLElement | null) => {
    observer?.disconnect();
    if (!editorNode) return;
    const copy = () => {
      for (const c of THEME_CLASSES) node.classList.toggle(c, editorNode.classList.contains(c));
    };
    copy();
    observer = new MutationObserver(copy);
    observer.observe(editorNode, { attributes: true, attributeFilter: ["class"] });
  };
  return {
    node,
    follow,
    sync,
    dispose: () => {
      observer?.disconnect();
      layer.remove();
    },
  };
}
