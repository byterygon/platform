// Classes an app on Byterygon UI writes: roles, layout keywords, fractions, token variables.
import { cva } from "class-variance-authority";

declare function cn(...inputs: unknown[]): string;

const cardClass = "rounded-md border border-border-subtle bg-layer p-inset-md shadow-layer";

export const badgeVariants = cva("inline-flex items-center gap-inline-xs rounded-sm px-inset-xs text-caption-1", {
  variants: {
    appearance: { tint: "bg-accent-subtle text-accent-subtle-fg", filled: "bg-accent-solid text-accent-solid-fg" },
    size: { small: "h-control-sm", medium: "h-control-md" },
  },
  defaultVariants: { appearance: "tint", size: "medium" },
});

export function Card({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <section className={cn(cardClass, open && "ring-2 ring-ring", { "opacity-50": !open })}>
      <header className="flex w-full items-center justify-between gap-gap-md border-b border-border pb-stack-sm">
        <h2 className="text-subtitle-2 text-fg">Title</h2>
        <span className={`size-icon-md text-fg-muted ${open ? "rotate-180" : ""}`} />
      </header>
      <div className="grid w-1/2 grid-cols-2 gap-gap-sm data-[state=open]:bg-hover hover:bg-hover/50">{children}</div>
      <div className="h-[calc(var(--by-size-control-md)*2)] w-24 bg-(--by-color-bg-raised) duration-[var(--by-motion-duration-fast)]" />
      <div style={{ color: "var(--by-color-fg-muted)", inset: 0 }} className="absolute inset-0 -mt-px p-px" />
    </section>
  );
}
