/**
 * Density-aware space roles (spec section 3): `space.inline.*`, `space.stack.*`, `space.inset.*`
 * and `space.gap.*`. Each has five steps and two values, one per density mode, picked from the
 * 4 px scale; compact is one to two scale steps tighter than comfortable.
 *
 * They vary along the density axis only and point at primitives that do not vary, so they never
 * trip the mode-cross-axis rule. Shadows and colours vary by theme and never by density.
 */
import { type RoleDef, byDensity, ref } from "./authoring.js";

const STEPS = ["xs", "sm", "md", "lg", "xl"] as const;

interface Family {
  readonly name: string;
  /** Scale steps (`space.<step>`) as [comfortable, compact] for xs, sm, md, lg, xl. */
  readonly scale: readonly (readonly [string, string])[];
  readonly use: string;
  readonly avoid: string;
}

const FAMILIES: readonly Family[] = [
  {
    name: "inline",
    scale: [
      ["1", "0-5"],
      ["1-5", "1"],
      ["2", "1-5"],
      ["3", "2"],
      ["4", "3"],
    ],
    use: "The space between things on one line: an icon and its label, a badge and its text, buttons in a button group.",
    avoid: "Not for the gap between components in a row or grid (use space.gap.*) or for padding inside a container (use space.inset.*).",
  },
  {
    name: "stack",
    scale: [
      ["1", "0-5"],
      ["2", "1-5"],
      ["4", "3"],
      ["6", "4"],
      ["8", "6"],
    ],
    use: "The vertical space between blocks in a column: fields in a form, paragraphs, sections of a panel.",
    avoid: "Not for padding inside a container (use space.inset.*) or for the space between items on one line (use space.inline.*).",
  },
  {
    name: "inset",
    scale: [
      ["2", "1"],
      ["3", "2"],
      ["4", "3"],
      ["6", "4"],
      ["8", "6"],
    ],
    use: "Padding inside a container: cards, panels, dialogs, popovers, table cells.",
    avoid: "Not for the padding of a control (use space.control.x) or for the space between siblings (use space.stack.* or space.gap.*).",
  },
  {
    name: "gap",
    scale: [
      ["1", "0-5"],
      ["2", "1"],
      ["3", "2"],
      ["4", "3"],
      ["6", "4"],
    ],
    use: "The gap between sibling components in a flex or grid layout: toolbar items, cards in a grid, form columns.",
    avoid: "Not for the space between an icon and its label (use space.inline.*) or for padding (use space.inset.*).",
  },
];

export const SPACE_ROLES: readonly RoleDef[] = FAMILIES.flatMap((family) =>
  STEPS.map((step, index): RoleDef => {
    const [comfortable, compact] = family.scale[index]!;
    return {
      path: `space.${family.name}.${step}`,
      type: "dimension",
      value: byDensity(ref(`space.${comfortable}`), ref(`space.${compact}`)),
      tailwind: `--spacing-${family.name}-${step}`,
      use: `${family.use} Step ${step}: space.${comfortable} in comfortable density, space.${compact} in compact.`,
      avoid: `${family.avoid} Not a fixed pixel value: the density mode changes it.`,
    };
  }),
);
