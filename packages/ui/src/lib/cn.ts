import { createCn } from "cn/config";

/**
 * The Tailwind names of the design-token roles, which the `cn` package (what shadcn/ui's Base UI
 * styles use) does not know by default. Without them `cn("text-body", "text-fg-muted")` drops the
 * type role as if both were colours. A test fails when the tokens add a name missing here.
 */
export const roleNames = {
  /** `text-<role>`: the type roles (size, weight, leading, tracking together). */
  text: ["display", "heading-1", "heading-2", "heading-3", "heading-4", "body", "body-strong", "label", "caption", "code", "code-sm"],
  /** `h-<role>`, `p-<role>`, `gap-<role>`, `size-<role>`: the density-aware size and space roles. */
  spacing: [
    "icon-xs", "icon-sm", "icon-md", "icon-lg", "track",
    "control-xs", "control-sm", "control-md", "control-lg", "control-x",
    "inline-xs", "inline-sm", "inline-md", "inline-lg", "inline-xl",
    "stack-xs", "stack-sm", "stack-md", "stack-lg", "stack-xl",
    "inset-xs", "inset-sm", "inset-md", "inset-lg", "inset-xl",
    "gap-xs", "gap-sm", "gap-md", "gap-lg", "gap-xl",
    "grid-row", "grid-cell-x",
  ],
  /** `shadow-<role>`: elevation. */
  shadow: ["raised", "overlay", "modal"],
  /** `ease-<role>`: motion curves. */
  ease: ["standard", "enter", "exit", "emphasized"],
} as const;

/** Joins class names (strings, arrays, objects, falsy values) and lets later Tailwind classes win. */
export const cn = createCn({
  extend: {
    theme: {
      text: [...roleNames.text],
      spacing: [...roleNames.spacing],
      shadow: [...roleNames.shadow],
      ease: [...roleNames.ease],
    },
  },
});
