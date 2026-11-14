import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card";
import { createContext, useContext, type ReactNode, type Ref, type RefObject } from "react";
import { popoverClasses, popoverOffset, popoverStyle } from "@/components/popover/popover";
import { cn } from "@/lib/cn";
import { useMergedRef, useThemeScope, type ThemeScope } from "@/lib/theme-scope";

// A preview of what a link points to, shown while the pointer rests on it or the link has
// keyboard focus, on Base UI's PreviewCard: `HoverCard` is the root, HoverCardTrigger the link and
// HoverCardContent the card, styled as a Popover. It adds to the link and never replaces it: the
// link works without the card.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const hoverCardVariants = {} as const;

interface HoverCardContextValue {
  anchorRef: (element: Element | null) => void;
  anchor: RefObject<Element | null>;
  scope: ThemeScope;
}

const HoverCardContext = createContext<HoverCardContextValue>({ anchorRef: () => {}, anchor: { current: null }, scope: {} });

export type HoverCardProps = PreviewCardPrimitive.Root.Props;

/** A hover card on Base UI's PreviewCard. It renders no element: put a HoverCardTrigger and a HoverCardContent inside. */
export function HoverCard({ onOpenChange, ...props }: HoverCardProps) {
  const { ref, anchor, scope, refresh } = useThemeScope<Element>();
  return (
    <HoverCardContext value={{ anchorRef: ref, anchor, scope }}>
      <PreviewCardPrimitive.Root
        onOpenChange={(open, details) => {
          if (open) refresh();
          onOpenChange?.(open, details);
        }}
        {...props}
      />
    </HoverCardContext>
  );
}

export interface HoverCardTriggerProps extends PreviewCardPrimitive.Trigger.Props {
  /** Reaches the link. */
  ref?: Ref<HTMLAnchorElement>;
}

/**
 * The link the card previews (an `<a>`; style it as the page's links). `delay` (ms before it opens,
 * 600 by default) and `closeDelay` are set here, as in Base UI.
 */
export function HoverCardTrigger({ ref, ...props }: HoverCardTriggerProps) {
  const { anchorRef } = useContext(HoverCardContext);
  const merged = useMergedRef<HTMLAnchorElement>(anchorRef, ref);
  return <PreviewCardPrimitive.Trigger data-slot="hover-card-trigger" ref={merged} {...props} />;
}

export interface HoverCardContentProps extends Omit<PreviewCardPrimitive.Popup.Props, "className" | "children"> {
  /** The side of the link the card opens on. */
  side?: PreviewCardPrimitive.Positioner.Props["side"];
  /** How the card lines up with the link. */
  align?: PreviewCardPrimitive.Positioner.Props["align"];
  /** The gap to the link in px; space.inline.xs by default. */
  sideOffset?: number;
  children?: ReactNode;
  /** Extra classes for the card, merged after the component's own so they win. */
  className?: string;
}

/** The portal, the positioner (z.popover, the link's theme) and the card. */
export function HoverCardContent({ side = "bottom", align = "start", sideOffset, className, style, children, ...props }: HoverCardContentProps) {
  const { anchor, scope } = useContext(HoverCardContext);
  return (
    <PreviewCardPrimitive.Portal>
      <PreviewCardPrimitive.Positioner {...scope} data-slot="hover-card-positioner" side={side} align={align} sideOffset={sideOffset ?? (() => popoverOffset(anchor.current))} className={cn(popoverClasses.positioner)}>
        <PreviewCardPrimitive.Popup data-slot="hover-card-content" style={{ ...popoverStyle, ...style }} className={cn(popoverClasses.popup, "w-panel-sm", className)} {...props}>
          {children}
        </PreviewCardPrimitive.Popup>
      </PreviewCardPrimitive.Positioner>
    </PreviewCardPrimitive.Portal>
  );
}
