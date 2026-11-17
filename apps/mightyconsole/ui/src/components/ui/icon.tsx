import { useRender } from "@base-ui/react/use-render";
import { cn } from "@/lib/cn";
import type { IconDefinition, IconSize } from "@/lib/icons";

// A Fluent UI System Icon (vendored in packages/ui/icons, MIT) as an inline <svg> on Base UI's
// useRender. The artwork comes from @/lib/icons, one export per icon (`ChevronDown`), so an app
// bundles only the icons it imports. The edge follows size.icon.*, the colour is currentColor:
// the text colour of where the icon sits, or a token role through `tone`.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const iconVariants = {
  size: {
    xs: "size-icon-xs",
    sm: "size-icon-sm",
    md: "size-icon-md",
    lg: "size-icon-lg",
    xl: "size-icon-xl",
  },
  tone: {
    inherit: "",
    default: "text-fg",
    muted: "text-fg-muted",
    subtle: "text-fg-subtle",
    accent: "text-accent-subtle-fg",
    danger: "text-danger-fg",
    warning: "text-warning-fg",
    success: "text-success-fg",
    info: "text-info-fg",
  },
} as const;

const base = ["inline-block shrink-0 select-none"];

/**
 * The Fluent drawing each size uses: the smallest artwork at least as large as the edge (Fluent
 * draws 16, 20 and 24 px; 12 and 14 px scale the 16 px drawing down).
 */
export const iconArtworkSize: Record<keyof typeof iconVariants.size, IconSize> = { xs: 16, sm: 16, md: 16, lg: 20, xl: 24 };

const DRAWN: readonly IconSize[] = [16, 20, 24];

/** The artwork of `icon` for `size` in a style, or the nearest drawn size when Fluent has no drawing at that one. */
export function iconArtwork(icon: IconDefinition, size: IconSize, filled: boolean): { size: IconSize; paths: readonly string[] } {
  const styles = filled ? [icon.filled, icon.regular] : [icon.regular, icon.filled];
  for (const art of styles) {
    const exact = art[size];
    if (exact) return { size, paths: exact };
    const nearest = [...DRAWN].filter((drawn) => art[drawn]).sort((a, b) => Math.abs(a - size) - Math.abs(b - size) || b - a)[0];
    if (nearest) return { size: nearest, paths: art[nearest]! };
  }
  throw new Error(`Icon ${icon.name} has no artwork`);
}

export interface IconProps extends Omit<useRender.ComponentProps<"svg">, "className" | "children"> {
  /** The icon, an export of `@/lib/icons` (`ChevronDown`, `Database`). */
  icon: IconDefinition;
  /** Edge from size.icon.* (12, 14, 16, 20, 24 px). */
  size?: keyof typeof iconVariants.size;
  /** Colour from a text role; `inherit` (the default) keeps the surrounding text colour. */
  tone?: keyof typeof iconVariants.tone;
  /** Fluent's filled style, for a selected or active state; regular (outline) otherwise. */
  filled?: boolean;
  /** Names the icon for screen readers (role="img"). Without it the icon is decorative and hidden. */
  label?: string;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A Fluent UI System Icon: `<Icon icon={ChevronDown} />`. Decorative unless `label` names it.
 * Built on Base UI's useRender: `render` swaps the element, the ref reaches it.
 */
export function Icon({ icon, size = "md", tone = "inherit", filled = false, label, className, render, ...props }: IconProps) {
  // Without an icon (a value still loading) it keeps its box, empty, rather than throwing.
  const art = icon ? iconArtwork(icon, iconArtworkSize[size], filled) : { size: iconArtworkSize[size], paths: [] };
  const name = label ?? props["aria-label"];
  return useRender({
    defaultTagName: "svg",
    render,
    props: {
      "data-slot": "icon",
      "data-icon": icon?.name,
      "data-size": size,
      "data-tone": tone,
      "data-filled": filled ? "" : undefined,
      viewBox: `0 0 ${art.size} ${art.size}`,
      fill: "currentColor",
      focusable: "false",
      ...props,
      ...(name ? { role: "img", "aria-label": name } : { "aria-hidden": true }),
      className: cn(base, iconVariants.size[size], iconVariants.tone[tone], className),
      children: art.paths.map((d) => <path key={d} d={d} />),
    },
  });
}
