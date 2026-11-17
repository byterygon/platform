import { useRender } from "@base-ui/react/use-render";
import { useRef, type ReactNode } from "react";
import { cn } from "@/lib/cn";
import { tokenMs, useLoopAnimation } from "@/lib/motion";

// An indeterminate activity indicator: a ring with a turning arc, sized by size.icon.* and
// coloured by `currentColor` (or a role). It turns through the Web Animations API (@/lib/motion),
// once per three motion.duration.slow, and stands still under prefers-reduced-motion (the arc
// still shows that something is happening). With a `label` it is a polite status region that
// says what is loading; inside a control that already says so (a loading Button), pass
// label={null} and it is hidden from assistive technology.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const spinnerVariants = {
  variant: {
    current: "text-current",
    accent: "text-accent-solid",
    muted: "text-fg-muted",
  },
  size: {
    sm: "[&_svg]:size-icon-sm",
    md: "[&_svg]:size-icon-md",
    lg: "[&_svg]:size-icon-lg",
  },
} as const;

const base = ["inline-flex shrink-0 items-center gap-inline-xs align-middle [&_svg]:shrink-0"];

const classes = {
  track: "opacity-[var(--by-opacity-overlay)] stroke-border",
  label: "sr-only",
} as const;

export interface SpinnerProps extends Omit<useRender.ComponentProps<"span">, "className" | "children"> {
  /** What is loading, for screen readers ("Loading tables"); null hides the spinner from them. */
  label?: ReactNode;
  /** currentColor (inherits the text colour), accent, or muted. */
  variant?: keyof typeof spinnerVariants.variant;
  /** size.icon.sm, md or lg. */
  size?: keyof typeof spinnerVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A turning ring; a `<span role="status">` with hidden text when labelled. The ref reaches the span. */
export function Spinner({ label = "Loading", variant = "current", size = "md", className, render, ...props }: SpinnerProps) {
  const arc = useRef<SVGSVGElement>(null);
  useLoopAnimation(arc, [{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], {
    duration: (element) => tokenMs(element, "--by-motion-duration-slow", 3, 720),
  });
  const hidden = label === null;
  return useRender({
    defaultTagName: "span",
    render,
    props: {
      "data-slot": "spinner",
      "data-variant": variant,
      "data-size": size,
      ...(hidden ? { "aria-hidden": true } : { role: "status" }),
      ...props,
      className: cn(base, spinnerVariants.variant[variant], spinnerVariants.size[size], className),
      children: (
        <>
          <svg ref={arc} aria-hidden="true" viewBox="0 0 16 16" fill="none" strokeWidth="2" strokeLinecap="round">
            <circle cx="8" cy="8" r="6" className={classes.track} />
            <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" />
          </svg>
          {hidden ? null : <span className={classes.label}>{label}</span>}
        </>
      ),
    },
  });
}
