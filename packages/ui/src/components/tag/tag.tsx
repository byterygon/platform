import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon/icon";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { Dismiss } from "@/lib/icons";

// A label the user applied and can remove (a saved query's labels, a filter chip), on Base UI's
// useRender with a Base UI Button for removal. `swatch` adds a categorical colour dot from the
// colour-blind-safe chart.cat.1..8 roles, so tags can be told apart beyond their text. TagGroup
// lays tags out in a wrapping row. Long labels truncate; the full label stays the accessible name.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const tagVariants = {
  variant: {
    neutral: "border-border bg-neutral-subtle text-neutral-subtle-fg",
    accent: "border-transparent bg-accent-subtle text-accent-subtle-fg",
    /** A label that warns (an expiring grant, a deprecated driver): the orange warning tone. */
    warning: "border-warning-border bg-warning-subtle text-warning-fg",
  },
  size: {
    sm: "h-control-xs ps-inline-sm text-caption",
    md: "h-control-sm ps-inline-md text-label",
  },
} as const;

const base = [
  "inline-flex max-w-full min-w-0 shrink-0 items-center gap-inline-xs rounded-sm border pe-inline-sm font-sans whitespace-nowrap",
  "has-data-[slot=tag-remove]:pe-0",
  "data-disabled:opacity-[var(--by-opacity-disabled)]",
];

/** The swatch colours, written out so Tailwind finds them: chart.cat.1..8. */
const swatchClasses = {
  1: "bg-chart-1",
  2: "bg-chart-2",
  3: "bg-chart-3",
  4: "bg-chart-4",
  5: "bg-chart-5",
  6: "bg-chart-6",
  7: "bg-chart-7",
  8: "bg-chart-8",
} as const;

const classes = {
  label: "min-w-0 truncate",
  swatch: "size-inline-sm shrink-0 rounded-full",
  remove: [
    "inline-flex aspect-square h-full shrink-0 cursor-default items-center justify-center rounded-e-sm text-fg-muted",
    "hover:bg-hover hover:text-fg",
    focusRing,
    "data-disabled:pointer-events-none",
    "[&_svg]:size-icon-xs",
  ],
  group: "flex min-w-0 flex-wrap items-center gap-inline-xs",
} as const;


export interface TagProps extends Omit<useRender.ComponentProps<"span">, "className" | "children"> {
  /** The tag's text. */
  children?: ReactNode;
  /** neutral (default), accent, or warning (orange). */
  variant?: keyof typeof tagVariants.variant;
  /** sm in dense lists, md in forms. */
  size?: keyof typeof tagVariants.size;
  /** A categorical colour dot, chart.cat.1..8. */
  swatch?: keyof typeof swatchClasses;
  /** Shows a remove button that calls this. */
  onRemove?: () => void;
  /** Accessible name of the remove button; defaults to "Remove" and the label when it is a string. */
  removeLabel?: string;
  /** Dims the tag and disables its remove button. */
  disabled?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** One tag: a `<span>` with the label, an optional swatch and an optional remove button. The ref reaches the span. */
export function Tag({ variant = "neutral", size = "sm", swatch, onRemove, removeLabel, disabled = false, className, render, children, ...props }: TagProps) {
  const name = removeLabel ?? (typeof children === "string" ? `Remove ${children}` : "Remove");
  return useRender({
    defaultTagName: "span",
    render,
    props: {
      "data-slot": "tag",
      "data-variant": variant,
      "data-size": size,
      "data-disabled": disabled ? "" : undefined,
      ...props,
      className: cn(base, tagVariants.variant[variant], tagVariants.size[size], className),
      children: (
        <>
          {swatch ? <span data-slot="tag-swatch" aria-hidden="true" className={cn(classes.swatch, swatchClasses[swatch])} /> : null}
          <span className={classes.label} title={typeof children === "string" ? children : undefined}>
            {children}
          </span>
          {onRemove ? (
            <ButtonPrimitive data-slot="tag-remove" type="button" aria-label={name} disabled={disabled} onClick={onRemove} className={cn(classes.remove)}>
              <Icon icon={Dismiss} />
            </ButtonPrimitive>
          ) : null}
        </>
      ),
    },
  });
}

export interface TagGroupProps extends Omit<useRender.ComponentProps<"div">, "className"> {
  className?: string;
}

/** Tags in a wrapping row, a `role="list"`; put each Tag in a `role="listitem"` or render it as one (`render={<span role="listitem" />}`). */
export function TagGroup({ className, render, ...props }: TagGroupProps) {
  return useRender({ defaultTagName: "div", render, props: { role: "list", "data-slot": "tag-group", ...props, className: cn(classes.group, className) } });
}
