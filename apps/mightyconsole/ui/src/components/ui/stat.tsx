import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { ArrowDown, ArrowUp, Subtract } from "@/lib/icons";

// One number that matters, with its label and change: rows returned, query time, a table's size.
// Stat > StatLabel, StatValue, StatDelta, StatDescription, on Base UI's useRender. StatValue
// uses tabular figures so numbers line up across stats. StatDelta shows the trend with an arrow
// and says it in words for screen readers; its colour follows `intent`, because up is not always
// good (query time up is bad), and is never the only cue.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const statVariants = {
  size: {
    sm: "[&_[data-slot=stat-value]]:text-subtitle-1",
    md: "[&_[data-slot=stat-value]]:text-title-2",
  },
} as const;

const base = ["flex min-w-0 flex-col gap-stack-xs font-sans"];

const parts = {
  label: "min-w-0 truncate text-body-1 text-fg-muted",
  value: "min-w-0 truncate text-fg tabular-nums",
  delta: [
    "inline-flex items-center gap-inline-xs text-body-1-strong tabular-nums",
    "data-[intent=positive]:text-success-fg data-[intent=negative]:text-danger-fg data-[intent=neutral]:text-fg-muted",
    "[&_svg]:size-icon-xs [&_svg]:shrink-0",
  ],
  description: "min-w-0 text-caption-1 text-fg-muted wrap-break-word",
} as const;

type DivProps = Omit<useRender.ComponentProps<"div">, "className"> & { className?: string };

export interface StatProps extends DivProps {
  /** The value's size: text.heading-2 (md) or text.heading-4 (sm, in dense rows). */
  size?: keyof typeof statVariants.size;
}

/** The stat; the ref reaches its `<div>`. */
export function Stat({ size = "md", className, render, ...props }: StatProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "stat", "data-size": size, ...props, className: cn(base, statVariants.size[size], className) } });
}

/** What the number is ("Rows returned"). */
export function StatLabel({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "stat-label", ...props, className: cn(parts.label, className) } });
}

/** The number, formatted by the app ("1,204", "38 ms"), in tabular figures. */
export function StatValue({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "stat-value", ...props, className: cn(parts.value, className) } });
}

const Arrow = ({ trend }: { trend: StatDeltaProps["trend"] }) => <Icon icon={trend === "up" ? ArrowUp : trend === "down" ? ArrowDown : Subtract} />;

export interface StatDeltaProps extends Omit<useRender.ComponentProps<"span">, "className"> {
  /** Which way the number moved. */
  trend: "up" | "down" | "flat";
  /** Whether that is good: positive (success colour), negative (danger) or neutral. Defaults: up positive, down negative. */
  intent?: "positive" | "negative" | "neutral";
  /** The words screen readers hear before the change; defaults to "Up", "Down" or "No change". */
  trendLabel?: ReactNode;
  className?: string;
}

/** The change since the last value ("12 %", "4 ms"), with an arrow and the trend in words for screen readers. */
export function StatDelta({ trend, intent, trendLabel, className, render, children, ...props }: StatDeltaProps) {
  const tone = intent ?? (trend === "up" ? "positive" : trend === "down" ? "negative" : "neutral");
  const words = trendLabel ?? (trend === "up" ? "Up" : trend === "down" ? "Down" : "No change");
  return useRender({
    defaultTagName: "span",
    render,
    props: {
      "data-slot": "stat-delta",
      "data-trend": trend,
      "data-intent": tone,
      ...props,
      className: cn(parts.delta, className),
      children: (
        <>
          <Arrow trend={trend} />
          <span className="sr-only">{words} </span>
          {children}
        </>
      ),
    },
  });
}

export type StatDescriptionProps = Omit<useRender.ComponentProps<"p">, "className"> & { className?: string };

/** Context for the number ("since the previous run"). */
export function StatDescription({ className, render, ...props }: StatDescriptionProps) {
  return useRender({ defaultTagName: "p", render, props: { "data-slot": "stat-description", ...props, className: cn(parts.description, className) } });
}
