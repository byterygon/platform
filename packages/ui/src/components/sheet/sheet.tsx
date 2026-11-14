import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { createContext, useContext, type ComponentProps, type ReactNode, type Ref } from "react";
import { dialogClasses, ScopeAnchor, useDialogScope, XIcon } from "@/components/dialog/dialog";
import { IconButton } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";
import type { ThemeScope } from "@/lib/theme-scope";

// A panel that slides in from an edge of the window, over a scrim, on Base UI's Dialog: the same
// focus, Escape and outside-press behaviour as Dialog, laid out as a full-height (or full-width)
// sheet with a header, a scrolling body and a footer. Base UI's Drawer (swipe, snap points) is not
// used: DBee runs on desktops, and a sheet there is a modal side panel.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const sheetVariants = {
  /** The edge the sheet slides in from. */
  side: {
    right: "inset-y-0 right-0 h-full w-full border-l data-starting-style:translate-x-full data-ending-style:translate-x-full",
    left: "inset-y-0 left-0 h-full w-full border-r data-starting-style:-translate-x-full data-ending-style:-translate-x-full",
    top: "inset-x-0 top-0 max-h-full max-w-full border-b data-starting-style:-translate-y-full data-ending-style:-translate-y-full",
    bottom: "inset-x-0 bottom-0 max-h-full max-w-full border-t data-starting-style:translate-y-full data-ending-style:translate-y-full",
  },
  /** The width of a left or right sheet, from `size.panel.*`; a top or bottom sheet spans the window. */
  size: {
    sm: "max-w-panel-sm",
    md: "max-w-panel-md",
    lg: "max-w-panel-lg",
  },
} as const;

export type SheetSide = keyof typeof sheetVariants.side;
export type SheetSize = keyof typeof sheetVariants.size;

const popupClasses = [
  "fixed z-[var(--by-z-modal)] flex flex-col gap-stack-md border-border bg-overlay p-inset-lg font-sans text-body text-fg shadow-modal outline-none",
  "transition-transform duration-[var(--by-motion-duration-slow)] ease-emphasized motion-reduce:transition-none",
  "data-ending-style:ease-exit",
];

interface SheetContextValue {
  side: SheetSide;
  size: SheetSize;
  scope: ThemeScope;
  anchorRef: (element: Element | null) => void;
}

const SheetContext = createContext<SheetContextValue>({ side: "right", size: "md", scope: {}, anchorRef: () => {} });

export interface SheetProps extends DialogPrimitive.Root.Props {
  /** The edge the sheet slides in from. */
  side?: SheetSide;
  /** The width of a left or right sheet, from `size.panel.*`. */
  size?: SheetSize;
}

/**
 * A modal side sheet on Base UI's Dialog. It renders no element: put a SheetTrigger (or open it
 * through `open`) and a SheetContent inside.
 */
export function Sheet({ side = "right", size = "md", onOpenChange, ...props }: SheetProps) {
  const { anchorRef, scope, refresh } = useDialogScope(props.open);
  return (
    <SheetContext value={{ side, size, scope, anchorRef }}>
      <DialogPrimitive.Root
        onOpenChange={(open, details) => {
          if (open) refresh();
          onOpenChange?.(open, details);
        }}
        {...props}
      />
    </SheetContext>
  );
}

export interface SheetTriggerProps extends DialogPrimitive.Trigger.Props {
  /** Reaches the trigger element. */
  ref?: Ref<HTMLButtonElement>;
}

/** Opens the sheet. Unstyled: render a Button through `render`. */
export function SheetTrigger(props: SheetTriggerProps) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

export interface SheetBackdropProps extends Omit<DialogPrimitive.Backdrop.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The scrim, as Dialog's. SheetContent renders it. */
export function SheetBackdrop({ className, ...props }: SheetBackdropProps) {
  const { scope } = useContext(SheetContext);
  return <DialogPrimitive.Backdrop {...scope} data-slot="sheet-backdrop" className={cn(dialogClasses.backdrop, className)} {...props} />;
}

export interface SheetContentProps extends Omit<DialogPrimitive.Popup.Props, "className" | "children"> {
  /** Shows the close button in the top corner. */
  showClose?: boolean;
  /** The accessible name of the close button. */
  closeLabel?: string;
  children?: ReactNode;
  /** Extra classes for the popup, merged after the component's own so they win. */
  className?: string;
}

/** The portal with the scrim and the sheet (role="dialog"), sliding in from its side. */
export function SheetContent({ showClose = true, closeLabel = "Close", className, children, ...props }: SheetContentProps) {
  const { side, size, scope, anchorRef } = useContext(SheetContext);
  const sized = side === "left" || side === "right" ? sheetVariants.size[size] : undefined;
  return (
    <>
      <ScopeAnchor anchorRef={anchorRef} />
      <DialogPrimitive.Portal>
        <SheetBackdrop />
        <DialogPrimitive.Popup {...scope} data-slot="sheet-content" data-side={side} data-size={size} className={cn(popupClasses, sheetVariants.side[side], sized, className)} {...props}>
          {children}
          {showClose ? (
            <DialogPrimitive.Close render={<IconButton aria-label={closeLabel} size="sm" />} className={cn(dialogClasses.close)}>
              <XIcon />
            </DialogPrimitive.Close>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </>
  );
}

export interface SheetSectionProps extends Omit<ComponentProps<"div">, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The title and description, stacked; leaves room for the close button. */
export function SheetHeader({ className, ...props }: SheetSectionProps) {
  return <div data-slot="sheet-header" className={cn(dialogClasses.header, "pe-control-md", className)} {...props} />;
}

/** The sheet's content; it takes the free height and scrolls. */
export function SheetBody({ className, ...props }: SheetSectionProps) {
  return <div data-slot="sheet-body" className={cn(dialogClasses.body, className)} {...props} />;
}

/** The actions, pinned under the body, the primary action last. */
export function SheetFooter({ className, ...props }: SheetSectionProps) {
  return <div data-slot="sheet-footer" className={cn(dialogClasses.footer, "mt-auto", className)} {...props} />;
}

export interface SheetTitleProps extends Omit<DialogPrimitive.Title.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The sheet's heading (an `<h2>`), in type.heading-4; it names the sheet. */
export function SheetTitle({ className, ...props }: SheetTitleProps) {
  return <DialogPrimitive.Title data-slot="sheet-title" className={cn(dialogClasses.title, className)} {...props} />;
}

export interface SheetDescriptionProps extends Omit<DialogPrimitive.Description.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A sentence under the title, in color.fg.muted; it describes the sheet. */
export function SheetDescription({ className, ...props }: SheetDescriptionProps) {
  return <DialogPrimitive.Description data-slot="sheet-description" className={cn(dialogClasses.description, className)} {...props} />;
}

export interface SheetCloseProps extends DialogPrimitive.Close.Props {
  /** Reaches the button. */
  ref?: Ref<HTMLButtonElement>;
}

/** Closes the sheet. Unstyled: render a Button through `render`. */
export function SheetClose(props: SheetCloseProps) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />;
}
