import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// A column's data type at a glance: a glyph and a short name in the data.type.* colour (grid
// headers, the schema tree's column nodes, the value viewer). The glyph and the name carry the
// type, so the colour is never the only cue. `label` replaces the short name with the real type
// ("numeric(12,2)", "int8"); `iconOnly` keeps the glyph and moves the name to hidden text.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const typeBadgeVariants = {
  type: {
    integer: "text-type-integer",
    decimal: "text-type-decimal",
    text: "text-type-text",
    boolean: "text-type-boolean",
    datetime: "text-type-datetime",
    json: "text-type-json",
    binary: "text-type-binary",
    uuid: "text-type-uuid",
  },
} as const;

type DataType = keyof typeof typeBadgeVariants.type;

const base = ["inline-flex min-w-0 max-w-full items-center gap-inline-xs font-mono text-code-sm whitespace-nowrap align-middle"];

const classes = {
  glyph: "inline-flex min-w-icon-md shrink-0 items-center justify-center rounded-xs border border-current px-inline-xs leading-none",
  label: "min-w-0 truncate text-fg-muted",
  hidden: "sr-only",
} as const;

/** The glyph and the short name of each type. */
export const typeGlyphs: Record<DataType, { glyph: string; name: string }> = {
  integer: { glyph: "#", name: "int" },
  decimal: { glyph: "#.#", name: "dec" },
  text: { glyph: "Aa", name: "text" },
  boolean: { glyph: "T/F", name: "bool" },
  datetime: { glyph: "◷", name: "time" },
  json: { glyph: "{}", name: "json" },
  binary: { glyph: "01", name: "bin" },
  uuid: { glyph: "id", name: "uuid" },
};

export interface TypeBadgeProps extends Omit<useRender.ComponentProps<"span">, "className" | "children"> {
  /** The data type family, from the data.type.* roles. */
  type: DataType;
  /** The text after the glyph; defaults to the short name ("int"). Pass the real type ("numeric(12,2)"). */
  label?: ReactNode;
  /** Only the glyph; the name becomes hidden text for screen readers. */
  iconOnly?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A data type as a glyph and a name, a `<span>`. The ref reaches it. */
export function TypeBadge({ type, label, iconOnly = false, className, render, ...props }: TypeBadgeProps) {
  const { glyph, name } = typeGlyphs[type] ?? typeGlyphs.text;
  const text = label ?? name;
  return useRender({
    defaultTagName: "span",
    render,
    props: {
      "data-slot": "type-badge",
      "data-type": type,
      ...props,
      className: cn(base, typeBadgeVariants.type[type] ?? typeBadgeVariants.type.text, className),
      children: (
        <>
          <span data-slot="type-badge-glyph" aria-hidden="true" className={classes.glyph}>
            {glyph}
          </span>
          <span className={iconOnly ? classes.hidden : classes.label}>{text}</span>
        </>
      ),
    },
  });
}
