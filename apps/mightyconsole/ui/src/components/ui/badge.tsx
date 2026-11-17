import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";

// A short, non-interactive label for status or a count ("read-only", "plaintext", "3"), on Base
// UI's useRender. Two axes: the tone (`variant`: neutral, accent and the four statuses) and the
// `appearance` (subtle, solid, outline, or dot: a coloured dot before plain text, DBee's
// connection status). Each tone lists its classes for every appearance behind
// data-[appearance=…], so the two props combine without compound variants. Never rely on the
// colour alone: the text says the status.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const badgeVariants = {
  variant: {
    neutral: "data-[appearance=solid]:bg-neutral-solid data-[appearance=solid]:text-neutral-solid-fg data-[appearance=subtle]:bg-neutral-subtle data-[appearance=subtle]:text-neutral-subtle-fg data-[appearance=outline]:border-border data-[appearance=outline]:text-fg [&>[data-slot=badge-dot]]:bg-fg-muted",
    accent: "data-[appearance=solid]:bg-accent-solid data-[appearance=solid]:text-accent-solid-fg data-[appearance=subtle]:bg-accent-subtle data-[appearance=subtle]:text-accent-subtle-fg data-[appearance=outline]:border-accent-solid data-[appearance=outline]:text-accent-subtle-fg [&>[data-slot=badge-dot]]:bg-accent-solid",
    danger: "data-[appearance=solid]:bg-danger data-[appearance=solid]:text-danger-solid-fg data-[appearance=subtle]:bg-danger-subtle data-[appearance=subtle]:text-danger-fg data-[appearance=outline]:border-danger-border data-[appearance=outline]:text-danger-fg [&>[data-slot=badge-dot]]:bg-danger",
    warning: "data-[appearance=solid]:bg-warning data-[appearance=solid]:text-warning-solid-fg data-[appearance=subtle]:bg-warning-subtle data-[appearance=subtle]:text-warning-fg data-[appearance=outline]:border-warning-border data-[appearance=outline]:text-warning-fg [&>[data-slot=badge-dot]]:bg-warning",
    success: "data-[appearance=solid]:bg-success data-[appearance=solid]:text-success-solid-fg data-[appearance=subtle]:bg-success-subtle data-[appearance=subtle]:text-success-fg data-[appearance=outline]:border-success-border data-[appearance=outline]:text-success-fg [&>[data-slot=badge-dot]]:bg-success",
    info: "data-[appearance=solid]:bg-info data-[appearance=solid]:text-info-solid-fg data-[appearance=subtle]:bg-info-subtle data-[appearance=subtle]:text-info-fg data-[appearance=outline]:border-info-border data-[appearance=outline]:text-info-fg [&>[data-slot=badge-dot]]:bg-info",
  },
  appearance: {
    subtle: "",
    solid: "",
    outline: "bg-transparent",
    dot: "bg-transparent px-0 text-fg",
  },
  size: {
    sm: "min-h-control-xs px-inline-xs text-caption",
    md: "min-h-control-sm px-inline-sm text-label",
  },
} as const;

const base = [
  "inline-flex min-w-0 max-w-full select-none items-center gap-inline-xs rounded-full border border-transparent font-sans whitespace-nowrap align-middle",
  "[&_svg]:size-icon-xs [&_svg]:shrink-0",
];

const textClasses = "min-w-0 truncate";
const dotClasses = "size-inline-sm shrink-0 rounded-full";

export interface BadgeProps extends Omit<useRender.ComponentProps<"span">, "className"> {
  /** The tone: neutral, accent, or a status (danger, warning, success, info). */
  variant?: keyof typeof badgeVariants.variant;
  /** subtle (tinted), solid (filled), outline (bordered) or dot (a coloured dot before plain text). */
  appearance?: keyof typeof badgeVariants.appearance;
  /** sm in tables and trees, md beside headings. */
  size?: keyof typeof badgeVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A short status label or count, a `<span>`; long text truncates with an ellipsis. The ref reaches the element. */
export function Badge({ variant = "neutral", appearance = "subtle", size = "sm", className, render, children, ...props }: BadgeProps) {
  return useRender({
    defaultTagName: "span",
    render,
    props: {
      "data-slot": "badge",
      "data-variant": variant,
      "data-appearance": appearance,
      "data-size": size,
      ...props,
      className: cn(base, badgeVariants.variant[variant], badgeVariants.appearance[appearance], badgeVariants.size[size], className),
      children: (
        <>
          {appearance === "dot" ? <span data-slot="badge-dot" aria-hidden="true" className={dotClasses} /> : null}
          <span className={textClasses}>{children}</span>
        </>
      ),
    },
  });
}
