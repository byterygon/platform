import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip";
import { createContext, useContext, type ComponentProps, type ReactNode, type Ref, type RefObject } from "react";
import { cn } from "@/lib/cn";
import { tokenPx, useMergedRef, useThemeScope, type ThemeScope } from "@/lib/theme-scope";

// A short label for a control, shown on hover and on keyboard focus, on Base UI's Tooltip:
// `Tooltip` is the root, TooltipTrigger the control, TooltipContent the bubble (neutral solid, at
// z.tooltip). Like Base UI's, the tooltip is visual: the trigger keeps its own accessible name
// (aria-label on an IconButton), so screen readers do not depend on it. TooltipProvider (Base UI's
// Provider) shares the delay across a toolbar so moving between buttons shows the next at once.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const tooltipVariants = {} as const;

const classes = {
  positioner: "z-[var(--by-z-tooltip)] outline-none",
  popup: [
    "flex max-w-panel-xs items-center gap-inline-sm rounded-sm bg-neutral-solid px-inset-sm py-inset-xs font-sans text-caption text-neutral-solid-fg shadow-overlay",
    "transition-opacity duration-[var(--by-motion-duration-base)] ease-enter motion-reduce:transition-none",
    "data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:ease-exit data-instant:transition-none",
  ],
  shortcut: "font-mono text-caption text-neutral-solid-fg",
} as const;

/** The gap between the trigger and the tooltip: space.inline.xs where the trigger is. */
const tooltipOffset = (anchor: Element | null) => tokenPx(anchor, "--by-space-inline-xs", 4);

interface TooltipContextValue {
  anchorRef: (element: Element | null) => void;
  anchor: RefObject<Element | null>;
  scope: ThemeScope;
}

const TooltipContext = createContext<TooltipContextValue>({ anchorRef: () => {}, anchor: { current: null }, scope: {} });

/** Shares the open delay across several tooltips (a toolbar); Base UI's Tooltip.Provider. */
export const TooltipProvider = TooltipPrimitive.Provider;

export type TooltipProps = TooltipPrimitive.Root.Props;

/** A tooltip on Base UI's Tooltip. It renders no element: put a TooltipTrigger and a TooltipContent inside. */
export function Tooltip({ onOpenChange, ...props }: TooltipProps) {
  const { ref, anchor, scope, refresh } = useThemeScope<Element>();
  return (
    <TooltipContext value={{ anchorRef: ref, anchor, scope }}>
      <TooltipPrimitive.Root
        onOpenChange={(open, details) => {
          if (open) refresh();
          onOpenChange?.(open, details);
        }}
        {...props}
      />
    </TooltipContext>
  );
}

export interface TooltipTriggerProps extends TooltipPrimitive.Trigger.Props {
  /** Reaches the trigger element. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The control the tooltip describes; unstyled, render an IconButton or a Button through `render`.
 * `delay` (ms before it opens, 600 by default) and `closeDelay` are set here, as in Base UI.
 */
export function TooltipTrigger({ ref, ...props }: TooltipTriggerProps) {
  const { anchorRef } = useContext(TooltipContext);
  const merged = useMergedRef<HTMLButtonElement>(anchorRef, ref);
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" ref={merged} {...props} />;
}

export interface TooltipContentProps extends Omit<TooltipPrimitive.Popup.Props, "className" | "children"> {
  /** The side of the trigger it opens on. */
  side?: TooltipPrimitive.Positioner.Props["side"];
  /** How it lines up with the trigger along that side. */
  align?: TooltipPrimitive.Positioner.Props["align"];
  /** The gap to the trigger in px; space.inline.xs by default. */
  sideOffset?: number;
  children?: ReactNode;
  /** Extra classes for the bubble, merged after the component's own so they win. */
  className?: string;
}

/** The portal, the positioner (at z.tooltip, with the trigger's theme) and the bubble. */
export function TooltipContent({ side = "top", align = "center", sideOffset, className, children, ...props }: TooltipContentProps) {
  const { anchor, scope } = useContext(TooltipContext);
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner {...scope} data-slot="tooltip-positioner" side={side} align={align} sideOffset={sideOffset ?? (() => tooltipOffset(anchor.current))} className={cn(classes.positioner)}>
        <TooltipPrimitive.Popup data-slot="tooltip-content" className={cn(classes.popup, className)} {...props}>
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export interface TooltipShortcutProps extends Omit<ComponentProps<"kbd">, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The keyboard shortcut of the action, after its name, in the code font. */
export function TooltipShortcut({ className, ...props }: TooltipShortcutProps) {
  return <kbd data-slot="tooltip-shortcut" className={cn(classes.shortcut, className)} {...props} />;
}
