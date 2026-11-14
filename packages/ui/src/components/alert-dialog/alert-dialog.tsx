import { AlertDialog as AlertDialogPrimitive } from "@base-ui/react/alert-dialog";
import { createContext, useContext, type ComponentProps, type ReactNode, type Ref } from "react";
import { Button, type ButtonProps } from "@/components/button/button";
import { dialogClasses, dialogVariants, ScopeAnchor, useDialogScope, type DialogSize } from "@/components/dialog/dialog";
import { cn } from "@/lib/cn";
import type { ThemeScope } from "@/lib/theme-scope";

// A decision the user must make before going on, on Base UI's AlertDialog: like Dialog (and
// styled by the same classes) but role="alertdialog", with no close button, and a click outside
// does not dismiss it. The footer holds AlertDialogCancel (closes, focused first) and
// AlertDialogAction (runs the action; the caller closes the dialog when it is done).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const alertDialogVariants = {
  /** The popup's maximum width, from `size.panel.*`, as Dialog's. */
  size: dialogVariants.size,
} as const;

interface AlertDialogContextValue {
  size: DialogSize;
  scope: ThemeScope;
  anchorRef: (element: Element | null) => void;
}

const AlertDialogContext = createContext<AlertDialogContextValue>({ size: "md", scope: {}, anchorRef: () => {} });

export interface AlertDialogProps extends AlertDialogPrimitive.Root.Props {
  /** The popup's maximum width, from `size.panel.*`. */
  size?: DialogSize;
}

/**
 * An alert dialog on Base UI's AlertDialog. It renders no element: put an AlertDialogTrigger (or
 * open it through `open`) and an AlertDialogContent inside. Only Escape, AlertDialogCancel or the
 * caller close it.
 */
export function AlertDialog({ size = "md", onOpenChange, ...props }: AlertDialogProps) {
  const { anchorRef, scope, refresh } = useDialogScope(props.open);
  return (
    <AlertDialogContext value={{ size, scope, anchorRef }}>
      <AlertDialogPrimitive.Root
        onOpenChange={(open, details) => {
          if (open) refresh();
          onOpenChange?.(open, details);
        }}
        {...props}
      />
    </AlertDialogContext>
  );
}

export interface AlertDialogTriggerProps extends AlertDialogPrimitive.Trigger.Props {
  /** Reaches the trigger element. */
  ref?: Ref<HTMLButtonElement>;
}

/** Opens the alert dialog. Unstyled: render a Button through `render`. */
export function AlertDialogTrigger(props: AlertDialogTriggerProps) {
  return <AlertDialogPrimitive.Trigger data-slot="alert-dialog-trigger" {...props} />;
}

export interface AlertDialogBackdropProps extends Omit<AlertDialogPrimitive.Backdrop.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The scrim, as Dialog's. AlertDialogContent renders it. */
export function AlertDialogBackdrop({ className, ...props }: AlertDialogBackdropProps) {
  const { scope } = useContext(AlertDialogContext);
  return <AlertDialogPrimitive.Backdrop {...scope} data-slot="alert-dialog-backdrop" className={cn(dialogClasses.backdrop, className)} {...props} />;
}

export interface AlertDialogViewportProps extends Omit<AlertDialogPrimitive.Viewport.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The centring layer at z.modal, as Dialog's. AlertDialogContent renders it. */
export function AlertDialogViewport({ className, ...props }: AlertDialogViewportProps) {
  const { scope } = useContext(AlertDialogContext);
  return <AlertDialogPrimitive.Viewport {...scope} data-slot="alert-dialog-viewport" className={cn(dialogClasses.viewport, className)} {...props} />;
}

export interface AlertDialogContentProps extends Omit<AlertDialogPrimitive.Popup.Props, "className" | "children"> {
  children?: ReactNode;
  /** Extra classes for the popup, merged after the component's own so they win. */
  className?: string;
}

/** The portal with the scrim, the viewport and the popup (role="alertdialog"). */
export function AlertDialogContent({ className, children, ...props }: AlertDialogContentProps) {
  const { size, anchorRef } = useContext(AlertDialogContext);
  return (
    <>
      <ScopeAnchor anchorRef={anchorRef} />
      <AlertDialogPrimitive.Portal>
        <AlertDialogBackdrop />
        <AlertDialogViewport>
          <AlertDialogPrimitive.Popup data-slot="alert-dialog-content" data-size={size} className={cn(dialogClasses.popup, alertDialogVariants.size[size], className)} {...props}>
            {children}
          </AlertDialogPrimitive.Popup>
        </AlertDialogViewport>
      </AlertDialogPrimitive.Portal>
    </>
  );
}

export interface AlertDialogSectionProps extends Omit<ComponentProps<"div">, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The title and description, stacked. */
export function AlertDialogHeader({ className, ...props }: AlertDialogSectionProps) {
  return <div data-slot="alert-dialog-header" className={cn(dialogClasses.header, className)} {...props} />;
}

/** What the decision is about (the statement, the target), between header and footer; it scrolls when long. */
export function AlertDialogBody({ className, ...props }: AlertDialogSectionProps) {
  return <div data-slot="alert-dialog-body" className={cn(dialogClasses.body, className)} {...props} />;
}

/** AlertDialogCancel, then AlertDialogAction, at the end of the row. */
export function AlertDialogFooter({ className, ...props }: AlertDialogSectionProps) {
  return <div data-slot="alert-dialog-footer" className={cn(dialogClasses.footer, className)} {...props} />;
}

export interface AlertDialogTitleProps extends Omit<AlertDialogPrimitive.Title.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** The question or the consequence, as an `<h2>` in type.heading-4; it names the dialog. */
export function AlertDialogTitle({ className, ...props }: AlertDialogTitleProps) {
  return <AlertDialogPrimitive.Title data-slot="alert-dialog-title" className={cn(dialogClasses.title, className)} {...props} />;
}

export interface AlertDialogDescriptionProps extends Omit<AlertDialogPrimitive.Description.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** What happens if the user goes on, in color.fg.muted; it describes the dialog. */
export function AlertDialogDescription({ className, ...props }: AlertDialogDescriptionProps) {
  return <AlertDialogPrimitive.Description data-slot="alert-dialog-description" className={cn(dialogClasses.description, className)} {...props} />;
}

export interface AlertDialogCancelProps extends Omit<ButtonProps, "render"> {
  /** Reaches the button. */
  ref?: Ref<HTMLButtonElement>;
}

/** Closes the dialog without acting: a ghost Button by default. Focused when the dialog opens. */
export function AlertDialogCancel({ variant = "ghost", size = "md", loading = false, ...props }: AlertDialogCancelProps) {
  return <AlertDialogPrimitive.Close data-slot="alert-dialog-cancel" render={<Button variant={variant} size={size} loading={loading} />} {...props} />;
}

export interface AlertDialogActionProps extends ButtonProps {
  /** Reaches the button. */
  ref?: Ref<HTMLButtonElement>;
}

/**
 * The action the dialog asks for: a primary Button by default, `variant="danger"` when it destroys
 * data. It does not close the dialog: do the work (show `loading`), then set `open` to false.
 */
export function AlertDialogAction(props: AlertDialogActionProps) {
  return <Button data-slot="alert-dialog-action" {...props} />;
}
