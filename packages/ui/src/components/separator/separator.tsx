import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";
import { cn } from "@/lib/cn";

// A thin rule between groups of content, on Base UI's Separator (role="separator" with
// aria-orientation). Its thickness is border.width.1 and its colour a border role, so it matches
// the borders around it in every theme. A purely visual rule inside a list of controls (a
// toolbar, a menu) should be this component too: screen readers announce the grouping.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const separatorVariants = {
  variant: {
    default: "bg-border",
    muted: "bg-border-muted",
    strong: "bg-border-strong",
  },
} as const;

const base = [
  "shrink-0 self-stretch",
  "data-[orientation=horizontal]:h-[var(--by-border-width-1)] data-[orientation=horizontal]:w-full",
  "data-[orientation=vertical]:w-[var(--by-border-width-1)] data-[orientation=vertical]:h-auto",
];

export interface SeparatorProps extends Omit<SeparatorPrimitive.Props, "className"> {
  /** The border role it takes: `default` between sections, `muted` inside a dense list, `strong` to divide panes. */
  variant?: keyof typeof separatorVariants.variant;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A rule between groups of content: horizontal by default, `orientation="vertical"` inside a row
 * (a toolbar, a status bar). Wraps Base UI's Separator; the ref reaches the `<div role="separator">`.
 */
export function Separator({ variant = "default", orientation = "horizontal", className, ...props }: SeparatorProps) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      data-variant={variant}
      orientation={orientation}
      className={cn(base, separatorVariants.variant[variant], className)}
      {...props}
    />
  );
}
