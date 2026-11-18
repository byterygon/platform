import { createCn } from "cn/config";

/**
 * The Tailwind names of the design-token roles, which the `cn` package (what shadcn/ui's Base UI
 * styles use) does not know by default. Without them `cn("text-body", "text-fg-muted")` drops the
 * type role as if both were colours. A test fails when the tokens add a name missing here.
 */
export const roleNames = {
  /** `text-<role>`: the type roles (size, weight, leading, tracking together). */
  text: [
    // Fluent 2's type ramp (TSK-57) and the code roles.
    "caption-2",
    "caption-2-strong",
    "caption-1",
    "caption-1-strong",
    "caption-1-stronger",
    "body-1",
    "body-1-strong",
    "body-1-stronger",
    "body-2",
    "subtitle-2",
    "subtitle-2-stronger",
    "subtitle-1",
    "title-3",
    "title-2",
    "title-1",
    "large-title",
    "display",
    "code",
    "code-sm",
    // The names from before, aliases of the Fluent roles.
    "heading-1",
    "heading-2",
    "heading-3",
    "heading-4",
    "body",
    "body-strong",
    "label",
    "caption",
  ],
  /** `h-<role>`, `p-<role>`, `gap-<role>`, `size-<role>`: the density-aware size and space roles. */
  spacing: [
    "icon-xs", "icon-sm", "icon-md", "icon-lg", "icon-xl", "track", "scrollbar",
    "panel-xs", "panel-sm", "panel-md", "panel-lg", "panel-xl",
    "control-xs", "control-sm", "control-md", "control-lg", "control-x",
    "inline-xs", "inline-sm", "inline-md", "inline-lg", "inline-xl",
    "stack-xs", "stack-sm", "stack-md", "stack-lg", "stack-xl",
    "inset-xs", "inset-sm", "inset-md", "inset-lg", "inset-xl",
    "gap-xs", "gap-sm", "gap-md", "gap-lg", "gap-xl",
    "grid-row", "grid-cell-x", "table-row", "table-row-sm", "table-row-xs", "table-cell-x",
  ],
  /** `shadow-<role>`: elevation, and the focus underline of a field. */
  shadow: ["raised", "overlay", "modal", "focus-underline", "layer", "flyout", "dialog"],
  /** `blur-<role>`, `backdrop-blur-<role>`: the blur behind translucent layers. */
  blur: ["acrylic"],
  /** `ease-<role>`: motion curves. */
  ease: [
    // Fluent 2's curves (TSK-57); linear is Tailwind's own ease-linear.
    "accelerate-max",
    "accelerate-mid",
    "accelerate-min",
    "decelerate-max",
    "decelerate-mid",
    "decelerate-min",
    "easy-ease-max",
    "easy-ease",
    // The names from before, aliases of the Fluent curves.
    "standard",
    "enter",
    "exit",
    "emphasized",
  ],
} as const;

/** Joins class names (strings, arrays, objects, falsy values) and lets later Tailwind classes win. */
export const cn = createCn({
  extend: {
    theme: {
      text: [...roleNames.text],
      spacing: [...roleNames.spacing],
      shadow: [...roleNames.shadow],
      blur: [...roleNames.blur],
      ease: [...roleNames.ease],
    },
  },
});
