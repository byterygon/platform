import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { createContext, useContext, type ReactNode, type Ref, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { tokenPx, useMergedRef, useThemeScope, type ThemeScope } from "@/lib/theme-scope";

// A small non-modal panel attached to a control, on Base UI's Popover: `Popover` is the root, the
// parts are PopoverTrigger, PopoverContent (portal, positioner and popup), PopoverTitle,
// PopoverDescription and PopoverClose. The popup takes the trigger's theme and density.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const popoverVariants = {} as const;

/** The classes Popover shares with HoverCard. */
export const popoverClasses = {
  positioner: "z-[var(--by-z-popover)] outline-none",
  popup: [
    "flex max-w-panel-sm flex-col gap-stack-sm rounded-md border border-border bg-overlay p-inset-md font-sans text-body text-fg shadow-overlay outline-none",
    "transition duration-[var(--by-motion-duration-base)] ease-enter motion-reduce:transition-none",
    "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:ease-exit",
  ],
  title: "text-body-strong text-fg",
  description: "text-body text-fg-muted",
} as const;

/** Base UI's run-time variables for the popup: they are not tokens, so they go in `style`. */
export const popoverStyle = {
  transformOrigin: "var(--transform-origin)",
  maxHeight: "var(--available-height)",
} as const;

/** The gap between the trigger and the popup: space.inline.xs where the trigger is. */
export const popoverOffset = (anchor: Element | null) => tokenPx(anchor, "--by-space-inline-xs", 4);

interface PopoverContextValue {
  anchorRef: (element: Element | null) => void;
  anchor: RefObject<Element | null>;
  scope: ThemeScope;
}

const PopoverContext = createContext<PopoverContextValue>({ anchorRef: () => {}, anchor: { current: null }, scope: {} });

export type PopoverProps = PopoverPrimitive.Root.Props;

/**
 * A popover on Base UI's Popover. It renders no element: put a PopoverTrigger and a PopoverContent
 * inside. It is not modal: focus moves into the popup, Tab leaves it, Escape and a click outside
 * close it, and focus returns to the trigger.
 */
export function Popover({ onOpenChange, ...props }: PopoverProps) {
  const { ref, anchor, scope, refresh } = useThemeScope<Element>();
  return (
    <PopoverContext value={{ anchorRef: ref, anchor, scope }}>
      <PopoverPrimitive.Root
        onOpenChange={(open, details) => {
          if (open) refresh();
          onOpenChange?.(open, details);
        }}
        {...props}
      />
    </PopoverContext>
  );
}

export interface PopoverTriggerProps extends PopoverPrimitive.Trigger.Props {
  /** Reaches the trigger element. */
  ref?: Ref<HTMLButtonElement>;
}

/** Opens and closes the popover. Unstyled: render a Button or an IconButton through `render`. */
export function PopoverTrigger({ ref, ...props }: PopoverTriggerProps) {
  const { anchorRef } = useContext(PopoverContext);
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" ref={useMergedRef<HTMLButtonElement>(anchorRef, ref)} {...props} />;
}

export interface PopoverContentProps extends Omit<PopoverPrimitive.Popup.Props, "className" | "children"> {
  /** The side of the trigger the popup opens on. */
  side?: PopoverPrimitive.Positioner.Props["side"];
  /** How the popup lines up with the trigger along that side. */
  align?: PopoverPrimitive.Positioner.Props["align"];
  /** The gap to the trigger in px; space.inline.xs by default. */
  sideOffset?: number;
  children?: ReactNode;
  /** Extra classes for the popup, merged after the component's own so they win. */
  className?: string;
}

/** The portal, the positioner (at z.popover, with the trigger's theme) and the popup. */
export function PopoverContent({ side = "bottom", align = "center", sideOffset, className, style, children, ...props }: PopoverContentProps) {
  const { anchor, scope } = useContext(PopoverContext);
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner {...scope} data-slot="popover-positioner" side={side} align={align} sideOffset={sideOffset ?? (() => popoverOffset(anchor.current))} className={cn(popoverClasses.positioner)}>
        <PopoverPrimitive.Popup data-slot="popover-content" style={{ ...popoverStyle, ...style }} className={cn(popoverClasses.popup, className)} {...props}>
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  );
}

export interface PopoverTitleProps extends Omit<PopoverPrimitive.Title.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The popover's heading (an `<h2>`), in type.body-strong; it names the popup. */
export function PopoverTitle({ className, ...props }: PopoverTitleProps) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={cn(popoverClasses.title, className)} {...props} />;
}

export interface PopoverDescriptionProps extends Omit<PopoverPrimitive.Description.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A sentence in color.fg.muted; it describes the popup. */
export function PopoverDescription({ className, ...props }: PopoverDescriptionProps) {
  return <PopoverPrimitive.Description data-slot="popover-description" className={cn(popoverClasses.description, className)} {...props} />;
}

export interface PopoverCloseProps extends PopoverPrimitive.Close.Props {
  /** Reaches the button. */
  ref?: Ref<HTMLButtonElement>;
}

/** Closes the popover. Unstyled: render a Button through `render`. */
export function PopoverClose(props: PopoverCloseProps) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />;
}
