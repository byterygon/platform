import { ScrollArea as ScrollAreaPrimitive } from "@base-ui/react/scroll-area";
import type { CSSProperties, ReactNode, Ref, UIEvent } from "react";
import { cn } from "@/lib/cn";

// A scroll container with thin overlay scrollbars that match the theme, on Base UI's ScrollArea:
// the viewport scrolls natively (wheel, touch, keyboard once focused), the scrollbars are drawn
// on top and fade in while hovering or scrolling. Give it a height (h-full in a sized panel,
// max-h-panel-sm). The viewport is the element that scrolls: `viewportRef` reaches it, so a
// virtualized list can read its scrollTop and clientHeight.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const scrollAreaVariants = {} as const;

const classes = {
  root: "relative flex min-h-0 min-w-0 flex-col overflow-hidden",
  viewport: [
    "min-h-0 flex-1 overscroll-contain outline-none",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:-outline-offset-[var(--by-ring-width)] focus-visible:outline-ring",
  ],
  content: "min-w-full",
  scrollbar: [
    "pointer-events-none absolute flex touch-none select-none p-[var(--by-border-width-1)] opacity-0",
    "transition-opacity duration-[var(--by-motion-duration-base)] ease-standard",
    "data-hovering:pointer-events-auto data-hovering:opacity-100 data-scrolling:pointer-events-auto data-scrolling:opacity-100",
    "data-[orientation=vertical]:inset-y-0 data-[orientation=vertical]:inset-e-0 data-[orientation=vertical]:w-track",
    "data-[orientation=horizontal]:inset-x-0 data-[orientation=horizontal]:bottom-0 data-[orientation=horizontal]:h-track",
    // Kept mounted; a bar whose axis does not overflow stays invisible.
    "data-[orientation=vertical]:not-data-has-overflow-y:invisible data-[orientation=horizontal]:not-data-has-overflow-x:invisible",
  ],
  thumb: "w-full rounded-full bg-border-strong hover:bg-fg-subtle",
} as const;

// Base UI measures the thumb and publishes its length as a run-time variable; it is not a token.
const thumbStyle: Record<"vertical" | "horizontal", CSSProperties> = {
  vertical: { height: "var(--scroll-area-thumb-height)" },
  horizontal: { width: "var(--scroll-area-thumb-width)", height: "100%" },
};

export interface ScrollAreaProps extends Omit<ScrollAreaPrimitive.Root.Props, "className" | "children"> {
  /** The scrolling content. */
  children?: ReactNode;
  /** Which scrollbars to draw. The viewport scrolls on both axes whenever its content overflows. */
  scrollbars?: "vertical" | "horizontal" | "both";
  /** Reaches the viewport, the element that scrolls (read scrollTop and clientHeight here). */
  viewportRef?: Ref<HTMLDivElement>;
  /** Called when the viewport scrolls. */
  onViewportScroll?: (event: UIEvent<HTMLDivElement>) => void;
  /** Names the scrolling region; the viewport then has role="region". */
  "aria-label"?: string;
  /** Names the scrolling region by another element's id; the viewport then has role="region". */
  "aria-labelledby"?: string;
  /** Extra classes on the root (give it a height), merged after the component's own. */
  className?: string;
}

/**
 * A scroll container with themed overlay scrollbars, on Base UI's ScrollArea. The ref reaches the
 * root; `viewportRef` the viewport that scrolls, which is focusable when its content overflows.
 */
export function ScrollArea({
  children,
  scrollbars = "vertical",
  viewportRef,
  onViewportScroll,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  className,
  ...props
}: ScrollAreaProps) {
  const labelled = ariaLabel !== undefined || ariaLabelledBy !== undefined;
  return (
    <ScrollAreaPrimitive.Root data-slot="scroll-area" className={cn(classes.root, className)} {...props}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        data-slot="scroll-area-viewport"
        role={labelled ? "region" : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onScroll={onViewportScroll}
        className={cn(classes.viewport)}
      >
        <ScrollAreaPrimitive.Content data-slot="scroll-area-content" className={classes.content}>
          {children}
        </ScrollAreaPrimitive.Content>
      </ScrollAreaPrimitive.Viewport>
      {scrollbars !== "horizontal" ? <ScrollAreaScrollbar orientation="vertical" /> : null}
      {scrollbars !== "vertical" ? <ScrollAreaScrollbar orientation="horizontal" /> : null}
    </ScrollAreaPrimitive.Root>
  );
}

export interface ScrollAreaScrollbarProps {
  orientation: "vertical" | "horizontal";
}

/** One overlay scrollbar with its thumb; ScrollArea renders the ones `scrollbars` asks for. */
export function ScrollAreaScrollbar({ orientation }: ScrollAreaScrollbarProps) {
  return (
    <ScrollAreaPrimitive.Scrollbar data-slot="scroll-area-scrollbar" orientation={orientation} keepMounted className={cn(classes.scrollbar)}>
      <ScrollAreaPrimitive.Thumb data-slot="scroll-area-thumb" style={thumbStyle[orientation]} className={cn(classes.thumb)} />
    </ScrollAreaPrimitive.Scrollbar>
  );
}
