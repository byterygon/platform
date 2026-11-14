import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";

// A key or a shortcut, as text: a styled <kbd> on Base UI's useRender (no Base UI part exists).
// KbdGroup lines up the keys of a combination; put the separator ("+", "then") between them as
// text so screen readers read it.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const kbdVariants = {} as const;

const base = [
  "inline-flex h-control-xs min-w-control-xs shrink-0 select-none items-center justify-center gap-inline-xs",
  "rounded-sm border border-border bg-inset px-inline-sm font-mono text-code text-fg-muted",
  "[&_svg]:size-icon-xs [&_svg]:shrink-0",
];

const groupClasses = ["inline-flex items-center gap-inline-xs font-sans text-caption text-fg-muted"];

export interface KbdProps extends Omit<useRender.ComponentProps<"kbd">, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * One key (`Esc`, `⌘`, `Enter`), rendered as a `<kbd>`; `render` swaps the element, the ref
 * reaches it. Give a symbol a name screen readers read (a `<kbd>` takes no aria-label):
 * `<Kbd title="Command"><span aria-hidden="true">⌘</span><span className="sr-only">Command</span></Kbd>`.
 */
export function Kbd({ className, render, ...props }: KbdProps) {
  return useRender({
    defaultTagName: "kbd",
    render,
    props: { "data-slot": "kbd", ...props, className: cn(base, className) },
  });
}

export interface KbdGroupProps extends Omit<useRender.ComponentProps<"kbd">, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The keys of one shortcut side by side, an outer `<kbd>` as HTML nests them: `<KbdGroup><Kbd>Ctrl</Kbd>+<Kbd>K</Kbd></KbdGroup>`. */
export function KbdGroup({ className, render, ...props }: KbdGroupProps) {
  return useRender({
    defaultTagName: "kbd",
    render,
    props: { "data-slot": "kbd-group", ...props, className: cn(groupClasses, className) },
  });
}
