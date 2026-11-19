import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";

// Term/value pairs: the approval dialog's grant summary, a connection's details, About. A <dl>
// of DescriptionListItem (a <div> grouping one dt and its dd's, as HTML allows), DescriptionListTerm and
// DescriptionListDetails, on Base UI's useRender. `inline` puts the term beside its value (terms a
// third of the width); `stacked` puts it above. Gaps come from space.stack/inline roles, so both
// densities apply. Long values (digests, paths) wrap.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const descriptionListVariants = {
  layout: {
    inline: "[&_[data-slot=description-list-item]]:flex-row [&_[data-slot=description-list-term]]:w-1/3 [&_[data-slot=description-list-term]]:shrink-0",
    stacked: "[&_[data-slot=description-list-item]]:flex-col",
    aligned: [
      "table w-full border-collapse",
      "[&_[data-slot=description-list-item]]:table-row [&_[data-slot=description-list-term]]:table-cell [&_[data-slot=description-list-details]]:table-cell",
      "[&_[data-slot=description-list-term]]:w-px [&_[data-slot=description-list-term]]:whitespace-nowrap [&_[data-slot=description-list-term]]:pe-inline-xl",
      "[&_[data-slot=description-list-item]:not(:last-child)>*]:pb-stack-xs",
    ].join(" "),
  },
} as const;

const base = [
  "flex min-w-0 flex-col font-sans text-body-1 not-data-divided:gap-stack-sm",
  "data-divided:[&_[data-slot=description-list-item]]:border-b data-divided:[&_[data-slot=description-list-item]]:border-border-muted data-divided:[&_[data-slot=description-list-item]]:py-inset-xs data-divided:[&_[data-slot=description-list-item]:last-child]:border-b-0",
];

const parts = {
  item: "flex min-w-0 gap-x-inline-md gap-y-stack-xs",
  term: "min-w-0 text-body-1 text-fg-muted wrap-break-word",
  details: "min-w-0 flex-1 text-body-1 text-fg wrap-break-word",
} as const;

export interface DescriptionListProps extends Omit<useRender.ComponentProps<"dl">, "className"> {
  /** inline: the term beside its value; stacked: above it (narrow places); aligned: the terms in one column as wide as the longest. */
  layout?: keyof typeof descriptionListVariants.layout;
  /** Rules between the items. */
  divided?: boolean;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The list, a `<dl>`. The ref reaches it. */
export function DescriptionList({ layout = "inline", divided = false, className, render, ...props }: DescriptionListProps) {
  return useRender({
    defaultTagName: "dl",
    render,
    props: {
      "data-slot": "description-list",
      "data-layout": layout,
      "data-divided": divided ? "" : undefined,
      ...props,
      className: cn(base, descriptionListVariants.layout[layout], className),
    },
  });
}

type DivProps = Omit<useRender.ComponentProps<"div">, "className"> & { className?: string };

/** One term and its value(s), a `<div>` inside the `<dl>`. */
export function DescriptionListItem({ className, render, ...props }: DivProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "description-list-item", ...props, className: cn(parts.item, className) } });
}

export type DescriptionListTermProps = Omit<useRender.ComponentProps<"dt">, "className"> & { className?: string };

/** The term, a `<dt>` in text.label and color.fg.muted. */
export function DescriptionListTerm({ className, render, ...props }: DescriptionListTermProps) {
  return useRender({ defaultTagName: "dt", render, props: { "data-slot": "description-list-term", ...props, className: cn(parts.term, className) } });
}

export type DescriptionListDetailsProps = Omit<useRender.ComponentProps<"dd">, "className"> & { className?: string };

/** The value, a `<dd>`; wraps long values. */
export function DescriptionListDetails({ className, render, ...props }: DescriptionListDetailsProps) {
  return useRender({ defaultTagName: "dd", render, props: { "data-slot": "description-list-details", ...props, className: cn(parts.details, className) } });
}
