import { Collapsible as CollapsiblePrimitive } from "@base-ui/react/collapsible";
import { cn } from "@/lib/cn";

// A section that shows and hides its panel, on Base UI's Collapsible: Collapsible > CollapsibleTrigger
// + CollapsiblePanel. The trigger is a quiet text button with a chevron that turns when open (DBee's
// "3 notices" under a result); render a Button through `render` for another look. The panel fades
// in and out. Base UI's panel height is a run-time variable, not a token, so there is no height
// animation; with reduced motion nothing moves at all.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const collapsibleVariants = {} as const;

const classes = {
  root: "flex min-w-0 flex-col",
  trigger: [
    "inline-flex min-h-control-sm max-w-full cursor-default items-center gap-inline-xs self-start rounded-sm px-inline-xs font-sans text-label text-fg-muted",
    "hover:text-fg data-panel-open:text-fg",
    "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
    "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
    "[&_svg]:size-icon-sm [&_svg]:shrink-0",
  ],
  chevron: "flex shrink-0 transition-transform duration-[var(--by-motion-duration-fast)] ease-standard motion-reduce:transition-none in-data-panel-open:rotate-90 rtl:rotate-180 rtl:in-data-panel-open:rotate-90",
  label: "min-w-0 text-start wrap-break-word",
  panel: [
    "min-w-0 overflow-hidden",
    "transition-opacity duration-[var(--by-motion-duration-fast)] ease-standard data-starting-style:opacity-0 data-ending-style:opacity-0",
  ],
} as const;

const ChevronIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="m6 4 4 4-4 4" />
  </svg>
);

export interface CollapsibleProps extends Omit<CollapsiblePrimitive.Root.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The section. Open it with `open` and `onOpenChange`, or `defaultOpen`. The ref reaches the root `<div>`. */
export function Collapsible({ className, ...props }: CollapsibleProps) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" className={cn(classes.root, className)} {...props} />;
}

export interface CollapsibleTriggerProps extends Omit<CollapsiblePrimitive.Trigger.Props, "className"> {
  /** Draws the chevron before the label (default true). */
  chevron?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The button that opens and closes the panel (aria-expanded, aria-controls). */
export function CollapsibleTrigger({ chevron = true, className, children, ...props }: CollapsibleTriggerProps) {
  return (
    <CollapsiblePrimitive.Trigger data-slot="collapsible-trigger" className={cn(classes.trigger, className)} {...props}>
      {chevron ? (
        <span data-slot="collapsible-chevron" className={cn(classes.chevron)}>
          <ChevronIcon />
        </span>
      ) : null}
      <span className={classes.label}>{children}</span>
    </CollapsiblePrimitive.Trigger>
  );
}

export interface CollapsiblePanelProps extends Omit<CollapsiblePrimitive.Panel.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The content shown while open. `keepMounted` keeps it in the DOM while closed (hidden). */
export function CollapsiblePanel({ className, ...props }: CollapsiblePanelProps) {
  return <CollapsiblePrimitive.Panel data-slot="collapsible-panel" className={cn(classes.panel, className)} {...props} />;
}
