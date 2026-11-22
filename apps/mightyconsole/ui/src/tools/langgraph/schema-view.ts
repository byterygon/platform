// An assistant's schemas read for people (DOC-21 §11.2.1, the TSK-91 mockup's
// langgraph-assistant-schemas, TSK-96): the properties of a JSON Schema with their type, whether
// they are required, their default and description; a one-line summary for the list; and an
// example input made from the schema (required properties, defaults, the first enum value, an
// empty human message for `messages`). `$ref`s to `$defs` (pydantic's) are followed.

type Schema = Record<string, unknown>;
const isObject = (v: unknown): v is Schema => typeof v === "object" && v !== null && !Array.isArray(v);

/** A `$ref` to `#/$defs/X` or `#/definitions/X` in `root`, followed (once per level, no cycles). */
export function resolve(node: unknown, root: unknown, seen: ReadonlySet<string> = new Set()): Schema {
  if (!isObject(node)) return {};
  const ref = node["$ref"];
  if (typeof ref !== "string" || seen.has(ref)) return node;
  const path = ref.replace(/^#\//, "").split("/");
  let at: unknown = root;
  for (const part of path) at = isObject(at) ? at[part] : undefined;
  return isObject(at) ? resolve({ ...at, ...Object.fromEntries(Object.entries(node).filter(([k]) => k !== "$ref")) }, root, new Set([...seen, ref])) : node;
}

const refName = (node: unknown): string | null => (isObject(node) && typeof node["$ref"] === "string" ? node["$ref"].split("/").pop()! : null);

/** `string`, `"email" | "chat"`, `array of Message`, `integer | null`. */
export function typeText(node: unknown, root: unknown): string {
  const named = refName(node);
  const s = resolve(node, root);
  if (Array.isArray(s["enum"])) return s["enum"].map((v) => JSON.stringify(v)).join(" | ");
  if ("const" in s) return JSON.stringify(s["const"]);
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(s[key])) return s[key].map((x: unknown) => typeText(x, root)).join(" | ");
  }
  const type = s["type"];
  if (type === "array") return `array of ${s["items"] ? typeText(s["items"], root) : "any"}`;
  if (Array.isArray(type)) return type.join(" | ");
  if (typeof type === "string") return type === "object" && named ? named : type;
  return named ?? (typeof s["title"] === "string" ? s["title"] : "any");
}

export interface SchemaProperty {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/** The top-level properties, in the schema's order. */
export function schemaProperties(schema: unknown): SchemaProperty[] {
  const s = resolve(schema, schema);
  const props = isObject(s["properties"]) ? s["properties"] : {};
  const required = new Set(Array.isArray(s["required"]) ? s["required"].filter((x): x is string => typeof x === "string") : []);
  return Object.entries(props).map(([name, node]) => {
    const p = resolve(node, schema);
    const parts = [typeof p["description"] === "string" ? p["description"] : ""];
    if ("default" in p) parts.push(`Default ${JSON.stringify(p["default"])}`);
    return { name, type: typeText(node, schema), required: required.has(name), description: parts.filter(Boolean).join(". ") };
  });
}

/** The list's line under a schema: its property names, "8 keys" past three, or "—". */
export function schemaSummary(schema: unknown): string {
  const names = schemaProperties(schema).map((p) => p.name);
  if (names.length === 0) return "—";
  return names.length > 3 ? `${names.length} keys` : names.join(", ");
}

/** "JSON Schema draft 2020-12 · 3 properties, 2 required". */
export function schemaFacts(schema: unknown): string {
  const s = isObject(schema) ? schema : {};
  const props = schemaProperties(schema);
  const draft = typeof s["$schema"] === "string" ? (/draft[/-]?(\d{4}-\d{2}|\d+)/.exec(s["$schema"])?.[1] ?? null) : null;
  const required = props.filter((p) => p.required).length;
  return [draft ? `JSON Schema draft ${draft}` : "JSON Schema", `${props.length} propert${props.length === 1 ? "y" : "ies"}${required > 0 ? `, ${required} required` : ""}`].join(" · ");
}

/** A value that fits a schema: its default, its first enum value, or an empty one of its type. */
function sample(node: unknown, root: unknown, name: string, depth: number): unknown {
  const s = resolve(node, root);
  if ("default" in s) return s["default"];
  if (Array.isArray(s["enum"]) && s["enum"].length > 0) return s["enum"][0];
  if ("const" in s) return s["const"];
  if (name === "messages") return [{ type: "human", content: "" }];
  for (const key of ["anyOf", "oneOf"]) {
    if (Array.isArray(s[key])) {
      const first = s[key].find((x: unknown) => resolve(x, root)["type"] !== "null") ?? s[key][0];
      return sample(first, root, name, depth);
    }
  }
  const type = Array.isArray(s["type"]) ? s["type"].find((t) => t !== "null") : s["type"];
  if (type === "string") return "";
  if (type === "integer" || type === "number") return typeof s["minimum"] === "number" ? s["minimum"] : 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object" || isObject(s["properties"])) return depth > 3 ? {} : example(s, root, depth + 1);
  return null;
}

/** An example input: the required properties and those with a default. */
export function example(schema: unknown, root: unknown = schema, depth = 0): Record<string, unknown> {
  const s = resolve(schema, root);
  const props = isObject(s["properties"]) ? s["properties"] : {};
  const required = new Set(Array.isArray(s["required"]) ? s["required"] : []);
  const out: Record<string, unknown> = {};
  for (const [name, node] of Object.entries(props)) {
    const p = resolve(node, root);
    if (required.has(name) || "default" in p || name === "messages") out[name] = sample(node, root, name, depth);
  }
  return out;
}
