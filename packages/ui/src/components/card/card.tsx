import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";
import { controlAppearance } from "@/lib/control";

// A bounded surface that groups one subject (a connection, a saved query, a metric): CardHeader
// (CardTitle, CardDescription, CardAction), CardContent and CardFooter, on Base UI's useRender
// (no Base UI part exists). Padding comes from space.inset.*, so density applies. Long titles and
// descriptions wrap inside the card; a CardAction stays at the top end of the header.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const cardVariants = {
  appearance: {
    /** A translucent layer over the backdrop with a hairline and the layer shadow: the default. */
    filled: "border-border-subtle bg-layer shadow-layer",
    /** A lighter layer (color.bg.layer-alt) for a card on a card. */
    "filled-alternative": "border-border-subtle bg-layer-alt",
    /** A hairline only, no fill. */
    outline: "border-border-subtle bg-transparent",
    /** No fill and no edge: a group that only needs the card's padding. */
    subtle: "border-transparent bg-transparent",
  },
} as const;

/** The old variant names and the appearance each stands for. */
const VARIANT_ALIASES = { outline: "outline", raised: "filled", inset: "filled-alternative" } as const;

const base = ["flex min-w-0 flex-col gap-stack-md rounded-lg border py-inset-md font-sans text-body-1 text-fg"];

const parts = {
  // Title and action share the first line (order 1 and 2); the description takes a line of its own.
  header: "flex min-w-0 flex-wrap items-start gap-x-inline-md gap-y-stack-xs px-inset-md",
  title: "order-1 min-w-0 flex-1 text-subtitle-2 text-fg wrap-break-word",
  description: "order-3 min-w-0 basis-full text-caption-1 text-fg-muted wrap-break-word",
  action: "order-2 ms-auto flex shrink-0 items-center gap-inline-xs",
  content: "min-w-0 px-inset-md",
  footer: "flex min-w-0 flex-wrap items-center gap-inline-sm px-inset-md",
} as const;

type DivProps = Omit<useRender.ComponentProps<"div">, "className"> & {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
};

export interface CardProps extends DivProps {
  /** Fluent's card appearance: `filled` (default, a layer over the backdrop), `filled-alternative`, `outline` or `subtle`. */
  appearance?: keyof typeof cardVariants.appearance;
  /**
   * The old name of `appearance`: `outline` is outline, `raised` filled, `inset` filled-alternative.
   * @deprecated Use `appearance`. Kept for one release.
   */
  variant?: keyof typeof VARIANT_ALIASES;
}

/** A bounded surface for one subject; `render` swaps the element (an `<article>`, a `<section>`), the ref reaches it. */
export function Card({ appearance: appearanceProp, variant, className, render, ...props }: CardProps) {
  const appearance = controlAppearance(appearanceProp, variant, VARIANT_ALIASES, "filled");
  return useRender({
    defaultTagName: "div",
    render,
    props: { "data-slot": "card", "data-appearance": appearance, ...props, className: cn(base, cardVariants.appearance[appearance], className) },
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
