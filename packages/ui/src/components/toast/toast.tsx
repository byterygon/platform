import { Toast as ToastPrimitive } from "@base-ui/react/toast";
import { useEffect, type ReactNode } from "react";
import { Button } from "@/components/button/button";
import { ScopeAnchor } from "@/components/dialog/dialog";
import { IconButton } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";
import { useThemeScope } from "@/lib/theme-scope";

// Notifications on Base UI's Toast. `Toast` is the region: put one near the root of the app. Add
// toasts with `useToast().add({ title, description, type, timeout, priority, actionProps })` inside
// it, or from anywhere with a manager from `createToastManager()` passed as `toastManager`.
// `type` picks the tone (info, success, warning, danger); `timeout: 0` keeps a toast until it is
// dismissed (sticky); `priority: "high"` announces it at once. Nothing leaves the page.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const toastVariants = {
  /** Where the region sits: a corner of the window, or in the page flow (previews, docs, tests). */
  placement: {
    "bottom-end": "fixed right-0 bottom-0 z-[var(--by-z-toast)] p-inset-lg",
    "top-end": "fixed top-0 right-0 z-[var(--by-z-toast)] p-inset-lg",
    "bottom-center": "fixed bottom-0 left-1/2 z-[var(--by-z-toast)] -translate-x-1/2 p-inset-lg",
    static: "relative",
  },
} as const;

export type ToastPlacement = keyof typeof toastVariants.placement;

const classes = {
  viewport: "flex w-panel-sm max-w-full flex-col gap-stack-sm outline-none",
  root: [
    "relative flex w-full items-start gap-inline-sm rounded-md border border-s-2 border-border bg-overlay p-inset-md font-sans text-body text-fg shadow-overlay outline-none",
    "data-[type=info]:border-s-info-border data-[type=success]:border-s-success-border data-[type=warning]:border-s-warning-border data-[type=danger]:border-s-danger-border",
    "transition duration-[var(--by-motion-duration-base)] ease-enter motion-reduce:transition-none",
    "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:opacity-0 data-ending-style:ease-exit",
    "data-limited:hidden",
    "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  ],
  content: "flex min-w-0 flex-1 flex-col gap-stack-xs",
  title: "text-body-strong text-fg",
  description: "text-body text-fg-muted",
  actions: "flex shrink-0 items-center gap-inline-xs",
} as const;

const XIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m4.5 4.5 7 7m0-7-7 7" />
  </svg>
);

/** Adds, updates and closes toasts from inside a Toast region (Base UI's useToastManager). */
export const useToast = ToastPrimitive.useToastManager;
/** A toast manager usable outside React (an error handler, a store); pass it to Toast as `toastManager`. */
export const createToastManager = ToastPrimitive.createToastManager;

export interface ToastProps {
  /** A manager from createToastManager, to add toasts from outside React. */
  toastManager?: ToastPrimitive.Provider.Props["toastManager"];
  /** Toasts shown at once; older ones wait (data-limited). */
  limit?: number;
  /** Default ms before a toast closes; 0 keeps them until dismissed. */
  timeout?: number;
  /** Where the region sits. */
  placement?: ToastPlacement;
  /** The accessible name of each toast's close button. */
  closeLabel?: string;
  /** The region's accessible name. */
  "aria-label"?: string;
  /** App content that calls useToast. */
  children?: ReactNode;
  /** Extra classes for the region, merged after the component's own so they win. */
  className?: string;
}

export interface ToastItemProps {
  /** The toast object from useToast().toasts. */
  toast: ToastPrimitive.Root.ToastObject;
  /** The accessible name of the close button. */
  closeLabel?: string;
}

/** One toast: its title and description, its action as a Button, and a close IconButton. Toast renders one per toast. */
export function ToastItem({ toast, closeLabel = "Dismiss" }: ToastItemProps) {
  return (
    <ToastPrimitive.Root toast={toast} data-slot="toast-item" className={cn(classes.root)}>
      <ToastPrimitive.Content data-slot="toast-content" className={cn(classes.content)}>
        <ToastPrimitive.Title data-slot="toast-title" className={cn(classes.title)} />
        <ToastPrimitive.Description data-slot="toast-description" className={cn(classes.description)} />
      </ToastPrimitive.Content>
      <div data-slot="toast-actions" className={cn(classes.actions)}>
        {toast.actionProps ? <ToastPrimitive.Action render={<Button variant="secondary" size="sm" />} /> : null}
        <ToastPrimitive.Close render={<IconButton aria-label={closeLabel} size="sm" />}>
          <XIcon />
        </ToastPrimitive.Close>
      </div>
    </ToastPrimitive.Root>
  );
}

function ToastList({ closeLabel }: { closeLabel: string }) {
  const { toasts } = ToastPrimitive.useToastManager();
  return toasts.map((toast) => <ToastItem key={toast.id} toast={toast} closeLabel={closeLabel} />);
}

function Region({ placement, closeLabel, label, className }: { placement: ToastPlacement; closeLabel: string; label: string; className?: string | undefined }) {
  const { ref, scope, refresh } = useThemeScope<Element>();
  const { toasts } = ToastPrimitive.useToastManager();
  useEffect(() => {
    if (toasts.length > 0) refresh();
  }, [toasts.length, refresh]);
  const viewport = (
    <ToastPrimitive.Viewport {...scope} data-slot="toast" data-placement={placement} aria-label={label} className={cn(toastVariants.placement[placement], classes.viewport, className)}>
      <ToastList closeLabel={closeLabel} />
    </ToastPrimitive.Viewport>
  );
  return (
    <>
      <ScopeAnchor anchorRef={ref} />
      {placement === "static" ? viewport : <ToastPrimitive.Portal>{viewport}</ToastPrimitive.Portal>}
    </>
  );
}

/** The notification region on Base UI's Toast; children can call useToast. */
export function Toast({ toastManager, limit = 3, timeout = 5000, placement = "bottom-end", closeLabel = "Dismiss", "aria-label": label = "Notifications", children, className }: ToastProps) {
  return (
    <ToastPrimitive.Provider limit={limit} timeout={timeout} {...(toastManager ? { toastManager } : {})}>
      {children}
      <Region placement={placement} closeLabel={closeLabel} label={label} className={className} />
    </ToastPrimitive.Provider>
  );
}
