import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/cn";
import { controlSize, focusRing, type ControlSizeProp } from "@/lib/control";

// An on/off switch on Base UI's Switch: a focusable <span role="switch"> with a hidden <input>
// for forms, and a thumb inside. The track's end padding is one thumb wide, so the thumb slides
// by its own width (translate-x-full) with no computed lengths. The group's classes style the
// thumb (`*:`), the only child. Fluent 2's Switch: off, an outlined track (the accessible stroke)
// with a thumb of the same colour; on, the accent track with a thumb in its foreground.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const switchVariants = {
  size: {
    small: "pe-[var(--by-size-icon-xs)] *:size-icon-xs",
    medium: "pe-[var(--by-size-icon-sm)] *:size-icon-sm",
    large: "pe-[var(--by-size-icon-md)] *:size-icon-md",
  },
} as const;

const base = [
  "inline-flex shrink-0 items-center rounded-full border border-border-strong bg-transparent p-px",
  "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease",
  "hover:bg-hover",
  "data-checked:border-transparent data-checked:bg-accent-compound data-checked:hover:bg-accent-compound-hover data-checked:active:bg-accent-compound-active",
  focusRing,
  "data-invalid:data-unchecked:border-danger-border aria-invalid:data-unchecked:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:border-border-disabled data-disabled:bg-transparent data-disabled:data-checked:bg-disabled",
  "*:rounded-full *:bg-fg-muted data-checked:*:bg-accent-compound-fg data-disabled:*:bg-fg-disabled",
  "*:transition-transform *:duration-[var(--by-motion-duration-fast)] *:ease-easy-ease motion-reduce:*:transition-none",
  "data-checked:*:translate-x-full rtl:data-checked:*:-translate-x-full",
];

export interface SwitchProps extends Omit<SwitchPrimitive.Root.Props, "className" | "children"> {
  /** Thumb size: small 12, medium 14 (Fluent's), large 16 px; the track is two thumbs wide (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A setting that is on or off and takes effect at once ("Read-only connection"), on Base UI's
 * Switch. Use `checked` and `onCheckedChange`, or `defaultChecked`. Wrap it in a FieldLabel with
 * its text. The ref reaches the `<span role="switch">`.
 */
export function Switch({ size, className, ...props }: SwitchProps) {
  const thumb = controlSize(size);
  return (
    <SwitchPrimitive.Root data-slot="switch" data-size={thumb} className={cn(base, switchVariants.size[thumb], className)} {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}
