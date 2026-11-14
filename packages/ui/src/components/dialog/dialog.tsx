import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { createContext, useContext, useEffect, type ComponentProps, type ReactNode, type Ref } from "react";
import { IconButton } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";
import { useThemeScope, type ThemeScope } from "@/lib/theme-scope";

// A modal dialog on Base UI's Dialog: `Dialog` is the root (no element of its own) and the parts
// compose it as shadcn's do: DialogTrigger, DialogContent (portal, scrim, centred popup and a
// close button), DialogHeader with DialogTitle and DialogDescription, DialogBody, DialogFooter and
// DialogClose. AlertDialog and Sheet reuse `dialogClasses` and `useDialogScope`.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const dialogVariants = {
  /** The popup's maximum width, from the `size.panel.*` widths; it shrinks on narrow viewports. */
  size: {
    sm: "max-w-panel-sm",
    md: "max-w-panel-md",
    lg: "max-w-panel-lg",
    xl: "max-w-panel-xl",
  },
} as const;

export type DialogSize = keyof typeof dialogVariants.size;

/** The classes Dialog, AlertDialog and Sheet share. */
export const dialogClasses = {
  backdrop: [
    "fixed inset-0 z-[var(--by-z-overlay)] bg-scrim",
    "transition-opacity duration-[var(--by-motion-duration-slow)] ease-standard motion-reduce:transition-none",
    "data-starting-style:opacity-0 data-ending-style:opacity-0",
  ],
  viewport: "fixed inset-0 z-[var(--by-z-modal)] flex items-center justify-center overflow-y-auto p-inset-lg",
  popup: [
    "relative flex max-h-full w-full flex-col gap-stack-md overflow-hidden rounded-lg border border-border bg-overlay p-inset-lg font-sans text-body text-fg shadow-modal outline-none",
    "transition duration-[var(--by-motion-duration-slow)] ease-emphasized motion-reduce:transition-none",
    "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0 data-ending-style:ease-exit",
  ],
  header: "flex flex-col gap-stack-xs",
  title: "text-heading-4 text-fg",
  description: "text-body text-fg-muted",
  body: "-mx-inset-lg flex min-h-0 flex-1 flex-col gap-stack-md overflow-y-auto px-inset-lg",
  footer: "flex flex-wrap items-center justify-end gap-inline-sm",
  close: "absolute top-inset-md right-inset-md",
} as const;

const XIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m4 4 8 8M12 4l-8 8" />
  </svg>
);

/** The close button's icon, shared with Sheet. */
export { XIcon };

interface DialogContextValue {
  size: DialogSize;
  scope: ThemeScope;
  anchorRef: (element: Element | null) => void;
}

const DialogContext = createContext<DialogContextValue>({ size: "md", scope: {}, anchorRef: () => {} });

/**
 * The theme scope of a dialog-like root. A dialog may open without a trigger (a menu item or a
 * shortcut opens it), so the anchor is a hidden element that DialogContent renders where it sits in
 * the JSX: the popup in its portal then takes the theme and density of that region.
 */
export function useDialogScope(open: boolean | undefined) {
  const { ref, scope, refresh } = useThemeScope<Element>();
  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);
  return { anchorRef: ref, scope, refresh };
}

/** The hidden element DialogContent, AlertDialogContent and SheetContent anchor their scope to. */
export function ScopeAnchor({ anchorRef }: { anchorRef: (element: Element | null) => void }) {
  return <span ref={anchorRef} hidden />;
}

export interface DialogProps extends DialogPrimitive.Root.Props {
  /** The popup's maximum width, from `size.panel.*`. */
  size?: DialogSize;
}

/**
 * A modal dialog on Base UI's Dialog. It renders no element: put a DialogTrigger and a
 * DialogContent inside. Focus moves into the popup when it opens, stays there, and returns to the
 * trigger when it closes; Escape and a click on the scrim close it.
 */
export function Dialog({ size = "md", onOpenChange, ...props }: DialogProps) {
  const { anchorRef, scope, refresh } = useDialogScope(props.open);
  return (
    <DialogContext value={{ size, scope, anchorRef }}>
      <DialogPrimitive.Root
        onOpenChange={(open, details) => {
          if (open) refresh();
          onOpenChange?.(open, details);
        }}
        {...props}
      />
    </DialogContext>
  );
}

export interface DialogTriggerProps extends DialogPrimitive.Trigger.Props {
  /** Reaches the trigger element. */
  ref?: Ref<HTMLButtonElement>;
}

/** Opens the dialog. Unstyled: render a Button through `render` (`render={<Button />}`). */
export function DialogTrigger(props: DialogTriggerProps) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

export interface DialogBackdropProps extends Omit<DialogPrimitive.Backdrop.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The scrim behind the popup, color.bg.scrim at z.overlay. DialogContent renders it. */
export function DialogBackdrop({ className, ...props }: DialogBackdropProps) {
  const { scope } = useContext(DialogContext);
  return <DialogPrimitive.Backdrop {...scope} data-slot="dialog-backdrop" className={cn(dialogClasses.backdrop, className)} {...props} />;
}

export interface DialogViewportProps extends Omit<DialogPrimitive.Viewport.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The fixed, scrollable layer at z.modal that centres the popup. DialogContent renders it. */
export function DialogViewport({ className, ...props }: DialogViewportProps) {
  const { scope } = useContext(DialogContext);
  return <DialogPrimitive.Viewport {...scope} data-slot="dialog-viewport" className={cn(dialogClasses.viewport, className)} {...props} />;
}

export interface DialogContentProps extends Omit<DialogPrimitive.Popup.Props, "className" | "children"> {
  /** Shows the close button in the top corner. On by default; the footer can hold a DialogClose instead. */
  showClose?: boolean;
  /** The accessible name of the close button. */
  closeLabel?: string;
  children?: ReactNode;
  /** Extra classes for the popup, merged after the component's own so they win. */
  className?: string;
}

/**
 * The dialog itself: a portal with the scrim, the viewport and the popup (role="dialog", named by
 * its DialogTitle and described by its DialogDescription; the page behind is made inert).
 */
export function DialogContent({ showClose = true, closeLabel = "Close", className, children, ...props }: DialogContentProps) {
  const { size, anchorRef } = useContext(DialogContext);
  return (
    <>
      <ScopeAnchor anchorRef={anchorRef} />
      <DialogPrimitive.Portal>
        <DialogBackdrop />
        <DialogViewport>
          <DialogPrimitive.Popup data-slot="dialog-content" data-size={size} className={cn(dialogClasses.popup, dialogVariants.size[size], className)} {...props}>
            {children}
            {showClose ? (
              <DialogPrimitive.Close render={<IconButton aria-label={closeLabel} size="sm" />} className={cn(dialogClasses.close)}>
                <XIcon />
              </DialogPrimitive.Close>
            ) : null}
          </DialogPrimitive.Popup>
        </DialogViewport>
      </DialogPrimitive.Portal>
    </>
  );
}

export interface DialogSectionProps extends Omit<ComponentProps<"div">, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The title and description, stacked; leaves room for the close button. */
export function DialogHeader({ className, ...props }: DialogSectionProps) {
  return <div data-slot="dialog-header" className={cn(dialogClasses.header, "pe-control-md", className)} {...props} />;
}

/** The content between the header and the footer; it scrolls when the dialog is taller than the viewport. */
export function DialogBody({ className, ...props }: DialogSectionProps) {
  return <div data-slot="dialog-body" className={cn(dialogClasses.body, className)} {...props} />;
}

/** The actions, at the end of the row: the primary action last. */
export function DialogFooter({ className, ...props }: DialogSectionProps) {
  return <div data-slot="dialog-footer" className={cn(dialogClasses.footer, className)} {...props} />;
}

export interface DialogTitleProps extends Omit<DialogPrimitive.Title.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The dialog's heading (an `<h2>`), in type.heading-4; it names the dialog. */
export function DialogTitle({ className, ...props }: DialogTitleProps) {
  return <DialogPrimitive.Title data-slot="dialog-title" className={cn(dialogClasses.title, className)} {...props} />;
}

export interface DialogDescriptionProps extends Omit<DialogPrimitive.Description.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A sentence under the title, in color.fg.muted; it describes the dialog. */
export function DialogDescription({ className, ...props }: DialogDescriptionProps) {
  return <DialogPrimitive.Description data-slot="dialog-description" className={cn(dialogClasses.description, className)} {...props} />;
}

export interface DialogCloseProps extends DialogPrimitive.Close.Props {
  /** Reaches the button. */
  ref?: Ref<HTMLButtonElement>;
}

/** Closes the dialog. Unstyled: render a Button through `render` (`render={<Button variant="ghost" />}`). */
export function DialogClose(props: DialogCloseProps) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}
