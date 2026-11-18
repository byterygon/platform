import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { tokenMs, useLoopAnimation } from "@/lib/motion";

// A bar that shows how far a task has got (an export, a large fetch), on Base UI's Progress:
// role="progressbar" with aria-valuenow and a formatted aria-valuetext. Pass `value` from 0 to
// `max`, or null for an indeterminate task: then a third of the track slides across through the
// Web Animations API (@/lib/motion), and stands still under prefers-reduced-motion. `label` and
// `showValue` put the name and the formatted value on a line above the track.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const progressVariants = {
  variant: {
    accent: "[&_[data-slot=progress-indicator]]:bg-accent-compound",
    success: "[&_[data-slot=progress-indicator]]:bg-success",
    warning: "[&_[data-slot=progress-indicator]]:bg-warning",
    danger: "[&_[data-slot=progress-indicator]]:bg-danger",
  },
  size: {
    sm: "[&_[data-slot=progress-track]]:h-track",
    md: "[&_[data-slot=progress-track]]:h-inline-sm",
  },
} as const;

const base = ["flex w-full min-w-0 flex-wrap items-center justify-between gap-x-inline-md gap-y-stack-xs font-sans"];

const classes = {
  label: "min-w-0 truncate text-body-1 text-fg",
  value: "ms-auto shrink-0 text-caption-1 text-fg-muted tabular-nums",
  track: "relative basis-full overflow-hidden rounded-full bg-inset",
  indicator: [
    "h-full rounded-full transition-all duration-[var(--by-motion-duration-normal)] ease-easy-ease motion-reduce:transition-none",
    "data-indeterminate:w-1/3",
  ],
} as const;

export interface ProgressProps extends Omit<ProgressPrimitive.Root.Props, "className" | "children"> {
  /** The task's name, shown above the track and used as the bar's accessible name. */
  label?: ReactNode;
  /** Shows the formatted value (`format`, a percentage by default) at the end of the label line. */
  showValue?: boolean;
  /** accent while running; success, warning or danger for the outcome. */
  variant?: keyof typeof progressVariants.variant;
  /** Track height: size.track (sm) or space.inline.sm (md). */
  size?: keyof typeof progressVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * Progress of one task, 0 to `max` (100), or `value={null}` while unknown. Name it with `label`
 * or aria-label. The ref reaches the root `<div role="progressbar">`.
 */
export function Progress({ label, showValue = false, variant = "accent", size = "sm", value, className, ...props }: ProgressProps) {
  const indicator = useRef<HTMLDivElement>(null);
  const indeterminate = value === null || value === undefined;
  useLoopAnimation(indicator, [{ transform: "translateX(-100%)" }, { transform: "translateX(300%)" }], {
    enabled: indeterminate,
    easing: "ease-in-out",
    duration: (element) => tokenMs(element, "--by-motion-duration-slow", 6, 1440),
  });
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      data-variant={variant}
      data-size={size}
      value={value ?? null}
      className={cn(base, progressVariants.variant[variant], progressVariants.size[size], className)}
      {...props}
    >
      {label !== undefined ? <ProgressLabel>{label}</ProgressLabel> : null}
      {showValue ? <ProgressValue /> : null}
      <ProgressPrimitive.Track data-slot="progress-track" className={classes.track}>
        <ProgressPrimitive.Indicator ref={indicator} data-slot="progress-indicator" className={cn(classes.indicator)} />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export interface ProgressLabelProps extends Omit<ProgressPrimitive.Label.Props, "className"> {
  className?: string;
}

/** The task's name above the track; Progress renders it from `label`. */
export function ProgressLabel({ className, ...props }: ProgressLabelProps) {
  return <ProgressPrimitive.Label data-slot="progress-label" className={cn(classes.label, className)} {...props} />;
}

export interface ProgressValueProps extends Omit<ProgressPrimitive.Value.Props, "className"> {
  className?: string;
}

/** The formatted value at the end of the label line; Progress renders it with `showValue`. */
export function ProgressValue({ className, ...props }: ProgressValueProps) {
  return <ProgressPrimitive.Value data-slot="progress-value" className={cn(classes.value, className)} {...props} />;
}
