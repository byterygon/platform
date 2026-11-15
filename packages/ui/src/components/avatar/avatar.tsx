import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

// A person's or a service's picture, with initials while it loads or when there is none, on Base
// UI's Avatar. The image only shows once it has loaded; until then (and if it fails) the fallback
// shows. Air-gapped apps pass a local or data: URL for `src`, never a remote service; most of the
// time there is no picture and the initials are the avatar. Squares (`shape="square"`) suit
// services and connections, circles people.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const avatarVariants = {
  size: {
    sm: "size-control-xs text-caption",
    md: "size-control-sm text-label",
    lg: "size-control-lg text-body-strong",
  },
  shape: {
    circle: "rounded-full",
    square: "rounded-md",
  },
} as const;

const base = ["relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden bg-neutral-subtle align-middle font-sans text-neutral-subtle-fg"];

const classes = {
  image: "size-full object-cover",
  fallback: "flex size-full items-center justify-center uppercase",
} as const;

/** Up to two initials from a name: "Uy Son" → "US", "orders-prod" → "OP". */
export function initials(name: string | undefined): string {
  const words = (name ?? "").trim().split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? [words[0]![0], words[words.length - 1]![0]] : [...(words[0] ?? "")].slice(0, 2);
  return letters.join("").toUpperCase();
}

export interface AvatarProps extends Omit<AvatarPrimitive.Root.Props, "className" | "children"> {
  /** Who or what it shows; the accessible name (alt) and the source of the initials. */
  name: string;
  /** A local or data: URL of the picture. */
  src?: string;
  /** Replaces the initials (an icon, a different text). */
  fallback?: ReactNode;
  /** size.control.xs, sm or lg. */
  size?: keyof typeof avatarVariants.size;
  /** circle for people, square for services and connections. */
  shape?: keyof typeof avatarVariants.shape;
  /** Wait this many ms before showing the fallback, so a fast image does not flash initials. */
  fallbackDelay?: number;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The avatar: the picture once loaded, the initials otherwise. role="img" named by `name`. The ref reaches the root `<span>`. */
export function Avatar({ name, src, fallback, size = "md", shape = "circle", fallbackDelay, className, ...props }: AvatarProps) {
  return (
    <AvatarPrimitive.Root role="img" aria-label={name} data-slot="avatar" data-size={size} data-shape={shape} className={cn(base, avatarVariants.size[size], avatarVariants.shape[shape], className)} {...props}>
      {src ? <AvatarPrimitive.Image data-slot="avatar-image" src={src} alt="" className={classes.image} /> : null}
      <AvatarPrimitive.Fallback data-slot="avatar-fallback" delay={fallbackDelay} aria-hidden="true" className={classes.fallback}>
        {fallback ?? initials(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}
