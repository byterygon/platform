import { useRender } from "@base-ui/react/use-render";
import { useRef } from "react";
import { cn } from "@/lib/cn";
import { tokenMs, useLoopAnimation } from "@/lib/motion";

// A placeholder in the shape of content that is loading (tree rows, a card, a line of text), on
// Base UI's useRender. It pulses through the Web Animations API (@/lib/motion), slowly (eight
// motion.duration.slow per beat), and stands still under prefers-reduced-motion. Skeletons are
// aria-hidden: mark the region that is loading aria-busy and give it a name or a Spinner with a
// label, so screen readers hear "loading" once rather than a row of blanks.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const skeletonVariants = {
  variant: {
    text: "h-[var(--by-text-body-size)] w-full rounded-sm",
    block: "rounded-md",
    circle: "aspect-square rounded-full",
  },
} as const;

const base = ["block shrink-0 bg-inset"];

export interface SkeletonProps extends Omit<useRender.ComponentProps<"span">, "className" | "children"> {
  /** text: a line of body text; block: a rectangle (size it with classes); circle: an avatar (give it a size). */
  variant?: keyof typeof skeletonVariants.variant;
  /** Pulse while motion is allowed (default true). */
  animated?: boolean;
  /** Extra classes (the size: h-control-sm w-panel-xs, size-control-md), merged after the component's own. */
  className?: string;
}

/** A shaped, aria-hidden placeholder that pulses; a `<span>` (display block). The ref reaches it. */
export function Skeleton({ variant = "block", animated = true, className, render, ...props }: SkeletonProps) {
  const own = useRef<HTMLElement>(null);
  useLoopAnimation(own, [{ opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }], {
    enabled: animated,
    easing: "ease-in-out",
    duration: (element) => tokenMs(element, "--by-motion-duration-slow", 8, 1920),
  });
  return useRender({
    defaultTagName: "span",
    render,
    ref: own,
    props: { "data-slot": "skeleton", "data-variant": variant, "aria-hidden": true, ...props, className: cn(base, skeletonVariants.variant[variant], className) },
  });
}
