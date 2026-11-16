/**
 * Addressable Theme Studio state (spec section 9a.7): the URL hash and the theme file use one
 * documented, versioned schema, so an agent can open a Studio state, generate one, or read back
 * what a human tuned. The Studio and `by-tokens hash` both call these functions.
 *
 * URL hash, version 1 (`#` + URL search parameters, in this order):
 *
 *   by=1              the hash schema version (required)
 *   theme=<payload>   the theme file: base64url (no padding) of the deflate-raw compressed UTF-8
 *                     JSON of a theme file (required)
 *   mode=light|dark   the colour mode the Studio shows (optional)
 *   density=comfortable|compact   the density the Studio shows (optional)
 *
 * Readers ignore parameters they do not know. A hash with a newer `by` is still read (the payload
 * encoding is the same in every version) and comes back with a `state-newer-version` warning; a
 * theme with a newer `schemaVersion` is read the same way by `readThemeFile`, which keeps the keys
 * this version knows and warns about each one it drops.
 *
 * Pure apart from the Compression Streams API, which browsers and Node 24 both have. No Node APIs.
 */
import { SCHEMA_VERSION, type Diagnostic } from "./model.js";
import { RAMP_KEYS, SEED_KEYS } from "./seeds.js";
import { THEME_KEYS } from "./generate.js";
import { isPlainObject } from "./util.js";

/** Version of the URL hash schema. */
export const STATE_HASH_VERSION = 1;

export const STATE_MODES = ["light", "dark"] as const;
export const STATE_DENSITIES = ["comfortable", "compact"] as const;

export interface StudioState {
  /** A theme file (`schemaVersion`, `name`, `seeds`, `overrides`). */
  readonly theme: Record<string, unknown>;
  readonly mode?: (typeof STATE_MODES)[number];
  readonly density?: (typeof STATE_DENSITIES)[number];
}

export interface DecodedState {
  readonly ok: boolean;
  /** Present when `ok`. */
  readonly state?: StudioState;
  /** Errors when not `ok`; warnings (newer versions, dropped keys, ignored values) otherwise. */
  readonly diagnostics: readonly Diagnostic[];
}

// ---------------------------------------------------------------------------------------------
// base64url and deflate-raw

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function base64urlEncode(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let j = 0; j < chars; j += 1) out += ALPHABET[(n >> (18 - 6 * j)) & 63];
  }
  return out;
}

export function base64urlDecode(text: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return undefined;
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of text) {
    value = (value << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 255;
    }
  }
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).catch(() => undefined);
  void writer.close().catch(() => undefined);
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value as Uint8Array);
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Theme files

/**
 * Reads a parsed theme file for this version of the engine. A file with a newer `schemaVersion`
 * keeps the top-level keys, seeds and ramp fields this version knows, is labelled version
 * `SCHEMA_VERSION`, and gets one `theme-newer-version` warning plus one `theme-key-dropped`
 * warning per key it lost. Any other file is returned unchanged (`generateTokens` reports what is
 * wrong with it).
 */
export function readThemeFile(theme: unknown): { theme: unknown; diagnostics: Diagnostic[] } {
  if (!isPlainObject(theme) || typeof theme["schemaVersion"] !== "number" || theme["schemaVersion"] <= SCHEMA_VERSION) {
    return { theme, diagnostics: [] };
  }
  const diagnostics: Diagnostic[] = [
    {
      severity: "warning",
      rule: "theme-newer-version",
      token: "schemaVersion",
      measured: theme["schemaVersion"],
      required: SCHEMA_VERSION,
      message: `the theme file is schemaVersion ${theme["schemaVersion"]}; this version reads ${SCHEMA_VERSION} and drops what it does not know`,
      fix: { summary: "Update @byterygon/design-tokens to keep every field, or accept the dropped ones." },
    },
  ];
  const drop = (path: string) =>
    diagnostics.push({ severity: "warning", rule: "theme-key-dropped", token: path, message: `"${path}" is not known to schemaVersion ${SCHEMA_VERSION} and was dropped` });
  const keep = (source: Record<string, unknown>, keys: readonly string[], prefix: string) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(source)) {
      if (keys.includes(key)) out[key] = value;
      else drop(`${prefix}${key}`);
    }
    return out;
  };
  const out = keep(theme, THEME_KEYS, "");
  out["schemaVersion"] = SCHEMA_VERSION;
  if (isPlainObject(out["seeds"])) {
    const seeds = keep(out["seeds"], SEED_KEYS, "seeds.");
    if (isPlainObject(seeds["colors"])) {
      seeds["colors"] = Object.fromEntries(
        Object.entries(seeds["colors"]).map(([ramp, seed]) => [ramp, isPlainObject(seed) ? keep(seed, RAMP_KEYS, `seeds.colors.${ramp}.`) : seed]),
      );
    }
    if (isPlainObject(seeds["contrast"])) seeds["contrast"] = keep(seeds["contrast"], ["level", "apca"], "seeds.contrast.");
    out["seeds"] = seeds;
  }
  return { theme: out, diagnostics };
}

// ---------------------------------------------------------------------------------------------
// URL hash

/** The hash for a Studio state, with the leading `#`. Deterministic for a given state. */
export async function encodeState(state: StudioState): Promise<string> {
  const json = JSON.stringify(state.theme);
  const payload = base64urlEncode(await pipe(new TextEncoder().encode(json), new CompressionStream("deflate-raw")));
  const params = [`by=${STATE_HASH_VERSION}`, `theme=${payload}`];
  if (state.mode) params.push(`mode=${state.mode}`);
  if (state.density) params.push(`density=${state.density}`);
  return `#${params.join("&")}`;
}

/** Reads a hash (with or without `#`) or a whole URL that ends in one. */
export async function decodeState(input: string): Promise<DecodedState> {
  const error = (token: string, message: string, fix: string): DecodedState => ({
    ok: false,
    diagnostics: [{ severity: "error", rule: "state-invalid", token, message, fix: { summary: fix } }],
  });
  const hashAt = input.indexOf("#");
  const params = new URLSearchParams(hashAt === -1 ? input : input.slice(hashAt + 1));
  const diagnostics: Diagnostic[] = [];

  const version = params.get("by");
  if (version === null) return error("by", "the hash has no `by` version parameter", "A Studio hash starts with #by=1&theme=...");
  if (!/^[1-9][0-9]*$/.test(version)) return error("by", `\`by\` must be a positive integer, not "${version}"`, "Use #by=1&theme=...");
  if (Number(version) > STATE_HASH_VERSION) {
    diagnostics.push({
      severity: "warning",
      rule: "state-newer-version",
      token: "by",
      measured: Number(version),
      required: STATE_HASH_VERSION,
      message: `the hash is version ${version}; this version reads ${STATE_HASH_VERSION} and ignores what it does not know`,
    });
  }

  const payload = params.get("theme");
  if (payload === null) return error("theme", "the hash has no `theme` parameter", "Encode a theme file with `by-tokens hash encode`.");
  const bytes = base64urlDecode(payload);
  if (!bytes) return error("theme", "`theme` is not base64url", "Copy the whole hash; it may have been cut or changed.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await pipe(bytes, new DecompressionStream("deflate-raw"))));
  } catch {
    return error("theme", "`theme` does not decode to a JSON theme file", "Copy the whole hash; it may have been cut or changed.");
  }
  if (!isPlainObject(parsed)) return error("theme", "`theme` is not a JSON object", "Encode a theme file with `by-tokens hash encode`.");
  const read = readThemeFile(parsed);
  diagnostics.push(...read.diagnostics);

  const pick = <T extends string>(name: string, options: readonly T[]): T | undefined => {
    const value = params.get(name);
    if (value === null) return undefined;
    if ((options as readonly string[]).includes(value)) return value as T;
    diagnostics.push({ severity: "warning", rule: "state-value-ignored", token: name, message: `${name}=${value} is not one of ${options.join(", ")}; ignored` });
    return undefined;
  };
  const mode = pick("mode", STATE_MODES);
  const density = pick("density", STATE_DENSITIES);
  return {
    ok: true,
    state: { theme: read.theme as Record<string, unknown>, ...(mode ? { mode } : {}), ...(density ? { density } : {}) },
    diagnostics,
  };
}
