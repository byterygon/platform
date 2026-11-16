/**
 * Text roles: Fluent 2's type ramp (`text.caption-2` to `text.display`, TSK-57), Byterygon's
 * `text.code` and `text.code-sm`, and the names of spec section 3 (`text.heading-1..4`,
 * `text.body`, `text.body-strong`, `text.label`, `text.caption`) as aliases.
 *
 * Each role is five tokens, `text.<role>.{family,size,weight,leading,tracking}`, not one DTCG
 * `typography` composite: the engine handles every type it has in all six outputs, Figma has no
 * typography variable (a composite would be skipped there), and Tailwind reads the pieces as
 * `--text-<role>` and `--text-<role>--line-height`. A component sets all five together; the
 * `text-<role>` utilities do that for size, line height, tracking and weight.
 */
import { type RoleDef, ref } from "./authoring.js";

interface TextRole {
  readonly name: string;
  readonly mono?: boolean;
  /** A step of Fluent's ramp (`font.size.<step>`, `font.leading.<step>`). */
  readonly step: string;
  readonly weight: string;
  readonly use: string;
  readonly avoid: string;
}

/**
 * Fluent 2's typography styles, from `@fluentui/tokens` 1.0.0-alpha.24 (`typographyStyles` in
 * lib/global/typographyStyles.js), in the ramp's order, plus Byterygon's two code roles. Fluent's
 * camel-case names are written in kebab case (`body1Strong` -> `body-1-strong`). Fluent has no
 * letter spacing, so every role tracks at `font.tracking.normal`.
 */
const TEXT_ROLES: readonly TextRole[] = [
  { name: "caption-2", step: "100", weight: "regular", use: "the smallest text: a badge count, a keyboard hint, a dense status bar", avoid: "Not for text the user must read to act: use text.caption-1." },
  { name: "caption-2-strong", step: "100", weight: "semibold", use: "the smallest emphasised text: a tiny badge or a tag label", avoid: "Not for running text: use text.caption-1." },
  { name: "caption-1", step: "200", weight: "regular", use: "hints, timestamps, helper and error text under a field, secondary lines", avoid: "Not for anything the user must read first: use text.body-1." },
  { name: "caption-1-strong", step: "200", weight: "semibold", use: "emphasised small text: a section overline, a small label beside a value", avoid: "Not for a form label: use text.body-1." },
  { name: "caption-1-stronger", step: "200", weight: "bold", use: "the strongest small text: a count or a key figure in a caption line", avoid: "Not for headings: use text.subtitle-2." },
  { name: "body-1", step: "300", weight: "regular", use: "running text, descriptions, form labels, menu items, the value inside an input", avoid: "Not for secondary text: use text.caption-1, and not for code: use text.code." },
  { name: "body-1-strong", step: "300", weight: "semibold", use: "emphasis inside running text, button text, key values, selected tab titles, a card title", avoid: "Not for headings: use text.subtitle-2 or a title role." },
  { name: "body-1-stronger", step: "300", weight: "bold", use: "the strongest emphasis at body size: a number that must stand out in a row", avoid: "Not for whole sentences: use text.body-1-strong." },
  { name: "body-2", step: "400", weight: "regular", use: "larger running text: an intro paragraph, an empty state's sentence", avoid: "Not in dense tools' panels: use text.body-1." },
  { name: "subtitle-2", step: "400", weight: "semibold", use: "a subsection title and the heading of a group of fields", avoid: "Not for a form label: use text.body-1." },
  { name: "subtitle-2-stronger", step: "400", weight: "bold", use: "a subsection title that must stand out among others", avoid: "Not instead of a larger step: use text.subtitle-1." },
  { name: "subtitle-1", step: "500", weight: "semibold", use: "a dialog, panel or drawer title", avoid: "Not for a table or grid header: use text.body-1-strong." },
  { name: "title-3", step: "600", weight: "semibold", use: "a major section of a page", avoid: "Not for text that only needs emphasis: use text.body-1-strong." },
  { name: "title-2", step: "700", weight: "semibold", use: "the title of a page or a full-screen view", avoid: "Not more than one per view, and not for a panel title: use text.subtitle-1." },
  { name: "title-1", step: "800", weight: "semibold", use: "the title of a spacious page: a settings home, an overview", avoid: "Not inside a dense tool's panels: use text.title-2 or smaller." },
  { name: "large-title", step: "900", weight: "semibold", use: "a landing or welcome title, a big number on a dashboard", avoid: "Not for page headings inside a tool: use text.title-2." },
  { name: "display", step: "1000", weight: "semibold", use: "the largest text: a hero title or one very large figure", avoid: "Not more than once on a screen, and never inside a tool's panels: use text.large-title or smaller." },
  // Byterygon's code roles (Fluent has none): the monospace family on the ramp's 300 and 200 steps.
  { name: "code", mono: true, step: "300", weight: "regular", use: "code, SQL, identifiers and inline code in text", avoid: "Not for labels or prose: use text.body-1." },
  { name: "code-sm", mono: true, step: "200", weight: "regular", use: "dense code: grid cells, log lines, a result set, a diff", avoid: "Not for the main editor: use text.code." },
];

/**
 * The role names from before TSK-57 (spec section 3), kept as aliases of the Fluent role with the
 * same job so the components keep working until they move to the Fluent names (TSK-53/55).
 * Headings map one step up Fluent's ramp from their old size; label takes Fluent's Label (body 1).
 */
const ALIASES: readonly (readonly [name: string, target: string])[] = [
  ["heading-1", "title-2"],
  ["heading-2", "title-3"],
  ["heading-3", "subtitle-1"],
  ["heading-4", "subtitle-2"],
  ["body", "body-1"],
  ["body-strong", "body-1-strong"],
  ["label", "body-1"],
  ["caption", "caption-1"],
];

export const TEXT_ROLE_NAMES: readonly string[] = TEXT_ROLES.map((role) => role.name);
export const TEXT_ROLE_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(ALIASES);

const FIELD_AVOID = "Do not set it alone: set family, size, weight, leading and tracking of the role together.";

type Field = "family" | "size" | "weight" | "leading" | "tracking";
const FIELDS: readonly { field: Field; type: RoleDef["type"]; tailwind?: (name: string) => string; what: string }[] = [
  { field: "family", type: "fontFamily", what: "Font family" },
  { field: "size", type: "dimension", tailwind: (name) => `--text-${name}`, what: "Font size" },
  { field: "weight", type: "fontWeight", tailwind: (name) => `--text-${name}--font-weight`, what: "Font weight" },
  { field: "leading", type: "number", tailwind: (name) => `--text-${name}--line-height`, what: "Unitless line height" },
  { field: "tracking", type: "dimension", tailwind: (name) => `--text-${name}--letter-spacing`, what: "Letter spacing" },
];

function scaleOf(role: TextRole, field: Field): string {
  switch (field) {
    case "family":
      return role.mono ? "font.mono" : "font.sans";
    case "size":
      return `font.size.${role.step}`;
    case "weight":
      return `font.weight.${role.weight}`;
    case "leading":
      return `font.leading.${role.step}`;
    case "tracking":
      return "font.tracking.normal";
  }
}

const roleDefs: RoleDef[] = TEXT_ROLES.flatMap((role): RoleDef[] =>
  FIELDS.map(({ field, type, tailwind, what }): RoleDef => ({
    path: `text.${role.name}.${field}`,
    type,
    value: ref(scaleOf(role, field)),
    ...(tailwind ? { tailwind: tailwind(role.name) } : {}),
    use: `${what} of the ${role.name} text role: ${role.use}.`,
    avoid: `${FIELD_AVOID} ${role.avoid}`,
  })),
);

const aliasDefs: RoleDef[] = ALIASES.flatMap(([name, target]): RoleDef[] =>
  FIELDS.map(({ field, type, tailwind, what }): RoleDef => ({
    path: `text.${name}.${field}`,
    type,
    value: ref(`text.${target}.${field}`),
    ...(tailwind ? { tailwind: tailwind(name) } : {}),
    use: `${what} of the ${name} text role, an alias of text.${target} kept from before Fluent's ramp (TSK-57).`,
    avoid: `${FIELD_AVOID} Not in new code: use text.${target}.`,
  })),
);

export const TEXT_ROLE_DEFS: readonly RoleDef[] = [...roleDefs, ...aliasDefs];
