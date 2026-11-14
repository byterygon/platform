/**
 * Text roles (spec section 3): `text.display`, `text.heading-1..4`, `text.body`, `text.body-strong`,
 * `text.label`, `text.caption`, `text.code`, `text.code-sm`.
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
  readonly size: string;
  readonly weight: string;
  readonly leading: string;
  readonly tracking: string;
  readonly use: string;
  readonly avoid: string;
}

const TEXT_ROLES: readonly TextRole[] = [
  {
    name: "display",
    size: "4xl",
    weight: "semibold",
    leading: "tight",
    tracking: "tight",
    use: "the largest text: a landing or empty-state title, a big number on a dashboard",
    avoid: "Not for page headings inside a tool: use text.heading-1.",
  },
  {
    name: "heading-1",
    size: "3xl",
    weight: "semibold",
    leading: "tight",
    tracking: "tight",
    use: "the title of a page or a full-screen view",
    avoid: "Not more than one per view, and not for a panel title: use text.heading-3.",
  },
  {
    name: "heading-2",
    size: "2xl",
    weight: "semibold",
    leading: "snug",
    tracking: "normal",
    use: "a major section of a page, a dialog title in a spacious layout",
    avoid: "Not for text that only needs emphasis: use text.body-strong.",
  },
  {
    name: "heading-3",
    size: "xl",
    weight: "semibold",
    leading: "snug",
    tracking: "normal",
    use: "a panel, card or dialog title",
    avoid: "Not for a table or grid header: use text.label.",
  },
  {
    name: "heading-4",
    size: "lg",
    weight: "semibold",
    leading: "snug",
    tracking: "normal",
    use: "a subsection title and the heading of a group of fields",
    avoid: "Not for a form label: use text.label.",
  },
  {
    name: "body",
    size: "base",
    weight: "regular",
    leading: "normal",
    tracking: "normal",
    use: "running text, descriptions and the value inside an input",
    avoid: "Not for secondary text: use text.caption, and not for code: use text.code.",
  },
  {
    name: "body-strong",
    size: "base",
    weight: "semibold",
    leading: "normal",
    tracking: "normal",
    use: "emphasis inside running text, key values, selected tab titles",
    avoid: "Not for headings: use text.heading-*.",
  },
  {
    name: "label",
    size: "sm",
    weight: "medium",
    leading: "snug",
    tracking: "normal",
    use: "form labels, button text, menu items, table and grid headers",
    avoid: "Not for sentences: use text.body.",
  },
  {
    name: "caption",
    size: "xs",
    weight: "regular",
    leading: "snug",
    tracking: "normal",
    use: "hints, timestamps, helper and error text under a field, status bar text",
    avoid: "Not for anything the user must read first: use text.body.",
  },
  {
    name: "code",
    mono: true,
    size: "sm",
    weight: "regular",
    leading: "normal",
    tracking: "normal",
    use: "code, SQL, identifiers and inline code in text",
    avoid: "Not for labels or prose: use text.body.",
  },
  {
    name: "code-sm",
    mono: true,
    size: "xs",
    weight: "regular",
    leading: "normal",
    tracking: "normal",
    use: "dense code: grid cells, log lines, a result set, a diff",
    avoid: "Not for the main editor: use text.code.",
  },
];

const FIELD_AVOID = "Do not set it alone: set family, size, weight, leading and tracking of the role together.";

export const TEXT_ROLE_DEFS: readonly RoleDef[] = TEXT_ROLES.flatMap((role): RoleDef[] => {
  const base = `text.${role.name}`;
  return [
    {
      path: `${base}.family`,
      type: "fontFamily",
      value: ref(role.mono ? "font.mono" : "font.sans"),
      use: `Font family of the ${role.name} text role: ${role.use}.`,
      avoid: `${FIELD_AVOID} ${role.avoid}`,
    },
    {
      path: `${base}.size`,
      type: "dimension",
      value: ref(`font.size.${role.size}`),
      tailwind: `--text-${role.name}`,
      use: `Font size of the ${role.name} text role: ${role.use}.`,
      avoid: `${FIELD_AVOID} ${role.avoid}`,
    },
    {
      path: `${base}.weight`,
      type: "fontWeight",
      value: ref(`font.weight.${role.weight}`),
      tailwind: `--text-${role.name}--font-weight`,
      use: `Font weight of the ${role.name} text role: ${role.use}.`,
      avoid: `${FIELD_AVOID} ${role.avoid}`,
    },
    {
      path: `${base}.leading`,
      type: "number",
      value: ref(`font.leading.${role.leading}`),
      tailwind: `--text-${role.name}--line-height`,
      use: `Unitless line height of the ${role.name} text role: ${role.use}.`,
      avoid: `${FIELD_AVOID} ${role.avoid}`,
    },
    {
      path: `${base}.tracking`,
      type: "dimension",
      value: ref(`font.tracking.${role.tracking}`),
      tailwind: `--text-${role.name}--letter-spacing`,
      use: `Letter spacing of the ${role.name} text role: ${role.use}.`,
      avoid: `${FIELD_AVOID} ${role.avoid}`,
    },
  ];
});
