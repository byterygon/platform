import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";

// A bounded surface that groups one subject (a connection, a saved query, a metric): CardHeader
// (CardTitle, CardDescription, CardAction), CardContent and CardFooter, on Base UI's useRender
// (no Base UI part exists). Padding comes from space.inset.*, so density applies. Long titles and
// descriptions wrap inside the card; a CardAction stays at the top end of the header.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const cardVariants = {
  variant: {
    outline: "border-border bg-surface",
    raised: "border-border-muted bg-raised shadow-raised",
    inset: "border-transparent bg-inset",
  },
} as const;

const base = ["flex min-w-0 flex-col gap-stack-md rounded-lg border py-inset-md font-sans text-body text-fg"];

const parts = {
  // Title and action share the first line (order 1 and 2); the description takes a line of its own.
  header: "flex min-w-0 flex-wrap items-start gap-x-inline-md gap-y-stack-xs px-inset-md",
  title: "order-1 min-w-0 flex-1 text-heading-4 text-fg wrap-break-word",
  description: "order-3 min-w-0 basis-full text-caption text-fg-muted wrap-break-word",
  action: "order-2 ms-auto flex shrink-0 items-center gap-inline-xs",
  content: "min-w-0 px-inset-md",
  footer: "flex min-w-0 flex-wrap items-center gap-inline-sm px-inset-md",
} as const;

type DivProps = Omit<useRender.ComponentProps<"div">, "className"> & {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
};

export interface CardProps extends DivProps {
  /** `outline` on the page surface (default), `raised` to lift it off a canvas, `inset` for a quiet group inside another surface. */
  variant?: keyof typeof cardVariants.variant;
}

/** A bounded surface for one subject; `render` swaps the element (an `<article>`, a `<section>`), the ref reaches it. */
export function Card({ variant = "outline", className, render, ...props }: CardProps) {
  return useRender({
    defaultTagName: "div",
    render,
    props: { "data-slot": "card", "data-variant": variant, ...props, className: cn(base, cardVariants.variant[variant], className) },
  });
}

/** The top of the card: CardTitle and CardDescription on the start side, CardAction at the end. */
export function CardHeader({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "card-header", ...props, className: cn(parts.header, className) } });
}

export type CardTitleProps = Omit<useRender.ComponentProps<"h3">, "className"> & { className?: string };

/** The card's heading, an `<h3>` by default (`render={<h2 />}` for another level). */
export function CardTitle({ className, render, ...props }: CardTitleProps) {
  return useRender({ defaultTagName: "h3", render, props: { "data-slot": "card-title", ...props, className: cn(parts.title, className) } });
}

export type CardDescriptionProps = Omit<useRender.ComponentProps<"p">, "className"> & { className?: string };

/** One line or two under the title, in text.caption and color.fg.muted. */
export function CardDescription({ className, render, ...props }: CardDescriptionProps) {
  return useRender({ defaultTagName: "p", render, props: { "data-slot": "card-description", ...props, className: cn(parts.description, className) } });
}

/** Buttons or a menu at the top end of the header (Edit, a DropdownMenu trigger). */
export function CardAction({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "card-action", ...props, className: cn(parts.action, className) } });
}

/** The body of the card. */
export function CardContent({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "card-content", ...props, className: cn(parts.content, className) } });
}

/** Actions or facts at the bottom of the card, in a row that wraps. */
export function CardFooter({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "card-footer", ...props, className: cn(parts.footer, className) } });
}
