import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";

// Inline code in running text: a SQLSTATE (42P01), an identifier (public.orders), a digest or a
// fingerprint, as a <code> in the code-sm type role, like Kbd for keys. Long unbroken values
// (digests) may break anywhere so they never overflow their container. For several lines use
// CodeBlock; for keys use Kbd.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const codeVariants = {
  variant: {
    default: "rounded-xs bg-inset px-inline-xs text-fg",
    plain: "text-fg",
  },
} as const;

const base = ["font-mono text-code-sm break-all"];

export interface CodeProps extends Omit<useRender.ComponentProps<"code">, "className"> {
  /** default on a subtle inset background; plain without one (inside a table cell or a CodeBlock-like surface). */
  variant?: keyof typeof codeVariants.variant;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** An inline `<code>`; `render` swaps the element (a `<samp>` for program output). The ref reaches it. */
export function Code({ variant = "default", className, render, ...props }: CodeProps) {
  return useRender({
    defaultTagName: "code",
    render,
    props: { "data-slot": "code", "data-variant": variant, ...props, className: cn(base, codeVariants.variant[variant], className) },
  });
}
