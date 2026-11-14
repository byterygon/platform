// The component manifest (spec section 9a.3): what an agent or a tool needs to use a component
// without reading its source. component.manifest.schema.json describes the same shape for editors;
// validateManifest is what the registry build and the tests enforce.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface ManifestProp {
  readonly name: string;
  /** The TypeScript type as written in the component (`"primary" | "secondary"`, `boolean`). */
  readonly type: string;
  readonly default?: string | number | boolean | null;
  readonly required?: boolean;
  readonly description: string;
}

export interface ManifestSlot {
  readonly name: string;
  /** The element the slot renders (`button`, `input`). */
  readonly element: string;
  readonly description: string;
}

export interface ManifestState {
  /** One of the quality-gate states, or another name the component documents. */
  readonly name: string;
  /** The Tailwind variant that styles the state (`hover`, `focus-visible`, `data-disabled`, `aria-invalid`). */
  readonly variant: string;
  /** Props that put the component in the state, for states an attribute shows (`{ "disabled": true }`). */
  readonly props?: Readonly<Record<string, unknown>>;
  readonly description: string;
}

export interface Manifest {
  readonly $schema?: string;
  readonly schemaVersion: 1;
  /** kebab-case; the folder, the file names and the registry item name. */
  readonly name: string;
  /** PascalCase; the exported component. */
  readonly title: string;
  readonly description: string;
  readonly status: "experimental" | "stable";
  /** The Base UI module the component wraps (`@base-ui/react/button`), or null for none. */
  readonly base: string | null;
  /** npm packages the component imports, besides React. */
  readonly dependencies: readonly string[];
  readonly props: readonly ManifestProp[];
  /** Variant prop -> its values, the same as the `<name>Variants` export. */
  readonly variants: Readonly<Record<string, readonly string[]>>;
  readonly slots: readonly ManifestSlot[];
  readonly states: readonly ManifestState[];
  /** Every token path the component's classes resolve to. The tests derive it and compare. */
  readonly tokens: readonly string[];
  /** Export names in component.example.tsx. */
  readonly examples: { readonly minimal: string; readonly realistic: string };
  /** The manual accessibility checklist (spec section 6, quality gates). */
  readonly accessibility: readonly string[];
}

export const COMPONENT_FILES = ["component.tsx", "component.manifest.json", "component.example.tsx", "component.test.tsx"] as const;
export const fileName = (name: string, kind: (typeof COMPONENT_FILES)[number]) => kind.replace("component", name);

export const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const pascal = (name: string) => name.split("-").map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
export const camel = (name: string) => {
  const p = pascal(name);
  return p[0]!.toLowerCase() + p.slice(1);
};

const KEYS = ["$schema", "schemaVersion", "name", "title", "description", "status", "base", "dependencies", "props", "variants", "slots", "states", "tokens", "examples", "accessibility"];
export const REQUIRED_KEYS = KEYS.filter((key) => key !== "$schema");

/** Returns every problem with `value` as a manifest; an empty list means it is valid. */
export function validateManifest(value: unknown, folder?: string): string[] {
  const errors: string[] = [];
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const isText = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  if (!isObject(value)) return ["the manifest must be a JSON object"];
  for (const key of Object.keys(value)) if (!KEYS.includes(key)) errors.push(`unknown key "${key}"`);
  for (const key of REQUIRED_KEYS) if (!(key in value)) errors.push(`missing "${key}"`);
  const m = value as Record<string, unknown>;
  if (m.schemaVersion !== 1) errors.push(`schemaVersion must be 1`);
  if (typeof m.name !== "string" || !KEBAB.test(m.name)) errors.push(`name must be kebab-case`);
  else {
    if (folder !== undefined && m.name !== folder) errors.push(`name "${m.name}" must equal its folder "${folder}"`);
    if (m.title !== pascal(m.name)) errors.push(`title must be "${pascal(m.name)}" (PascalCase of the name)`);
  }
  if (!isText(m.description)) errors.push(`description must be a sentence`);
  if (m.status !== "experimental" && m.status !== "stable") errors.push(`status must be "experimental" or "stable"`);
  if (m.base !== null && !(typeof m.base === "string" && m.base.startsWith("@base-ui/react/"))) errors.push(`base must be a @base-ui/react/<part> module or null`);
  const strings = (key: string, v: unknown) => {
    if (!Array.isArray(v) || v.some((x) => !isText(x))) errors.push(`${key} must be a list of strings`);
  };
  strings("dependencies", m.dependencies);
  strings("tokens", m.tokens);
  strings("accessibility", m.accessibility);
  if (Array.isArray(m.tokens) && [...m.tokens].sort().join() !== m.tokens.join()) errors.push(`tokens must be sorted`);
  if (Array.isArray(m.accessibility) && m.accessibility.length === 0) errors.push(`accessibility must list at least one check`);
  const list = (key: string, v: unknown, fields: Record<string, (x: unknown) => boolean>) => {
    if (!Array.isArray(v)) {
      errors.push(`${key} must be a list`);
      return;
    }
    v.forEach((item, i) => {
      if (!isObject(item)) return errors.push(`${key}[${i}] must be an object`);
      for (const [field, ok] of Object.entries(fields)) if (!ok(item[field])) errors.push(`${key}[${i}].${field} is missing or invalid`);
      return undefined;
    });
  };
  const optional = (check: (x: unknown) => boolean) => (x: unknown) => x === undefined || check(x);
  list("props", m.props, {
    name: isText,
    type: isText,
    description: isText,
    required: optional((x) => typeof x === "boolean"),
    default: optional((x) => x === null || ["string", "number", "boolean"].includes(typeof x)),
  });
  list("slots", m.slots, { name: isText, element: isText, description: isText });
  list("states", m.states, { name: isText, variant: isText, description: isText, props: optional(isObject) });
  if (!isObject(m.variants) || Object.values(m.variants).some((values) => !Array.isArray(values) || values.length === 0 || values.some((x) => !isText(x)))) {
    errors.push(`variants must map each variant prop to a non-empty list of values`);
  } else if (Array.isArray(m.props)) {
    for (const key of Object.keys(m.variants)) {
      if (!m.props.some((p) => isObject(p) && p.name === key)) errors.push(`variant "${key}" must also be listed in props`);
    }
  }
  if (!isObject(m.examples) || !isText(m.examples.minimal) || !isText(m.examples.realistic)) errors.push(`examples must name the minimal and the realistic export`);
  return errors;
}

/** The components under `src/components`, sorted by name. */
export function listComponents(root: string): string[] {
  const dir = join(root, "src", "components");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function readManifest(root: string, name: string): Manifest {
  const path = join(root, "src", "components", name, fileName(name, "component.manifest.json"));
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}
