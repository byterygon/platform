import { Accordion as AccordionPrimitive } from "@base-ui/react/accordion";
import { cn } from "@/lib/cn";

// A stack of sections that open one at a time (or several, with `multiple`), on Base UI's
// Accordion: Accordion > AccordionItem > AccordionTrigger + AccordionPanel. Each trigger is a
// full-width button inside a heading (Base UI's Header, an <h3>), with a chevron that turns
// while open. Arrow keys move between triggers. The panel fades in; there is no height
// animation (Base UI's panel height is a run-time variable, not a token).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const accordionVariants = {
  variant: {
    plain: "",
    outline: "rounded-md border border-border bg-surface",
  },
} as const;

const base = ["flex w-full min-w-0 flex-col font-sans text-body text-fg"];

const classes = {
  // The outline variant pads the items inside its frame (in-data-[variant=outline]).
  item: "min-w-0 border-b border-border last:border-b-0 in-data-[variant=outline]:px-inset-sm",
  header: "flex min-w-0",
  trigger: [
    "flex min-h-control-md min-w-0 flex-1 cursor-default items-center justify-between gap-inline-md py-inset-xs text-start text-body-strong text-fg",
    "hover:text-fg-link",
    "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
    "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
    "[&_svg]:size-icon-md [&_svg]:shrink-0",
  ],
  label: "min-w-0 wrap-break-word",
  chevron: "flex shrink-0 text-fg-muted transition-transform duration-[var(--by-motion-duration-fast)] ease-standard motion-reduce:transition-none in-data-panel-open:rotate-180",
  panel: [
    "min-w-0 overflow-hidden text-body text-fg-muted",
    "transition-opacity duration-[var(--by-motion-duration-fast)] ease-standard data-starting-style:opacity-0 data-ending-style:opacity-0",
  ],
  panelInner: "pb-inset-sm",
} as const;

const ChevronIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m4 6 4 4 4-4" />
  </svg>
);

export interface AccordionProps extends Omit<AccordionPrimitive.Root.Props, "className"> {
  /** `plain` separates sections by rules; `outline` puts them in a bordered frame. */
  variant?: keyof typeof accordionVariants.variant;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * The stack of sections. `value`/`defaultValue` are arrays of open item values; `multiple` lets
 * several stay open. The ref reaches the root `<div>`.
 */
export function Accordion({ variant = "plain", className, ...props }: AccordionProps) {
  return <AccordionPrimitive.Root data-slot="accordion" data-variant={variant} className={cn(base, accordionVariants.variant[variant], className)} {...props} />;
}

export interface AccordionItemProps extends Omit<AccordionPrimitive.Item.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** One section; give it a `value` to open it from `value`/`defaultValue`. */
export function AccordionItem({ className, ...props }: AccordionItemProps) {
  return <AccordionPrimitive.Item data-slot="accordion-item" className={cn(classes.item, className)} {...props} />;
}

export interface AccordionTriggerProps extends Omit<AccordionPrimitive.Trigger.Props, "className"> {
  /** Extra classes on the button, merged after the component's own so they win. */
  className?: string;
}

/** The section's heading and toggle: an `<h3>` with a full-width button and a chevron. */
export function AccordionTrigger({ className, children, ...props }: AccordionTriggerProps) {
  return (
    <AccordionPrimitive.Header data-slot="accordion-header" className={classes.header}>
      <AccordionPrimitive.Trigger data-slot="accordion-trigger" className={cn(classes.trigger, className)} {...props}>
        <span className={classes.label}>{children}</span>
        <span data-slot="accordion-chevron" className={cn(classes.chevron)}>
          <ChevronIcon />
        </span>
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
}

export interface AccordionPanelProps extends Omit<AccordionPrimitive.Panel.Props, "className"> {
  /** Extra classes on the panel, merged after the component's own so they win. */
  className?: string;
}

/** The section's content, shown while open. */
export function AccordionPanel({ className, children, ...props }: AccordionPanelProps) {
  return (
    <AccordionPrimitive.Panel data-slot="accordion-panel" className={cn(classes.panel, className)} {...props}>
      <div className={classes.panelInner}>{children}</div>
    </AccordionPrimitive.Panel>
  );
}
