import { useRender } from "@base-ui/react/use-render";
import type { ReactNode } from "react";
import { Icon } from "@/components/icon/icon";
import { IconButton } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";
import { CheckmarkCircle, Dismiss, ErrorCircle, Info, Warning } from "@/lib/icons";

// A message in the page flow that needs to be read: a query error under the editor, a plaintext
// connection warning in a form, a notice across the top of the app. Alert > AlertTitle,
// AlertDescription, AlertActions, on Base UI's useRender, with a status icon per variant and an
// optional dismiss button. `layout="banner"` spans its container with no radius and a bottom
// border (the app's top banner); `inline` is a bordered box. Danger and warning alerts are
// role="alert" (announced at once), the others role="status" (announced politely): render the
// alert when the condition occurs, not hidden beforehand. Toast is for transient messages.
// Fluent 2's MessageBar: `intent` (Fluent's name; `variant` is the alias kept for one release)
// tints the box and colours the filled Fluent icon (Info, CheckmarkCircle, Warning on orange,
// ErrorCircle); the title is body-1-strong in the default text colour.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const alertVariants = {
  intent: {
    neutral: "border-border-subtle bg-layer [&_[data-slot=alert-icon]]:text-fg-muted",
    info: "border-info-border bg-info-subtle [&_[data-slot=alert-icon]]:text-info-fg",
    success: "border-success-border bg-success-subtle [&_[data-slot=alert-icon]]:text-success-fg",
    warning: "border-warning-border bg-warning-subtle [&_[data-slot=alert-icon]]:text-warning-fg",
    danger: "border-danger-border bg-danger-subtle [&_[data-slot=alert-icon]]:text-danger-fg",
  },
  layout: {
    inline: "rounded-md border p-inset-sm",
    banner: "w-full border-b px-inset-md py-inset-xs",
  },
} as const;

const base = ["flex w-full min-w-0 items-start gap-inline-sm font-sans text-body-1 text-fg"];

const classes = {
  icon: "flex h-lh shrink-0 items-center [&_svg]:size-icon-lg",
  content: "flex min-w-0 flex-1 flex-col gap-stack-xs",
  title: "min-w-0 text-body-1-strong text-fg wrap-break-word",
  description: "min-w-0 text-body-1 text-fg wrap-break-word [&_code]:font-mono [&_code]:text-code",
  actions: "flex flex-wrap items-center gap-inline-sm pt-inset-xs",
  dismiss: "-my-inset-xs -me-inset-xs shrink-0",
} as const;

const icons: Record<keyof typeof alertVariants.intent, ReactNode> = {
  neutral: <Icon icon={Info} />,
  info: <Icon icon={Info} filled />,
  success: <Icon icon={CheckmarkCircle} filled />,
  warning: <Icon icon={Warning} filled />,
  danger: <Icon icon={ErrorCircle} filled />,
};


export interface AlertProps extends Omit<useRender.ComponentProps<"div">, "className"> {
  /** Fluent's intent: neutral, info, success, warning (orange) or danger; sets the colours, the icon and the role. */
  intent?: keyof typeof alertVariants.intent | undefined;
  /**
   * The old name of `intent`.
   * @deprecated Use `intent`. Kept for one release.
   */
  variant?: keyof typeof alertVariants.intent | undefined;
  /** inline: a bordered box in the flow; banner: full width with a bottom border, for the top of the app or a pane. */
  layout?: keyof typeof alertVariants.layout;
  /** Replaces the status icon; false shows none. */
  icon?: ReactNode | false;
  /** Shows a close button that calls this. */
  onDismiss?: () => void;
  /** Accessible name of the close button. */
  dismissLabel?: string;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A message in the flow: icon, then the title, description and actions, then an optional close button. The ref reaches the `<div>`. */
export function Alert({ intent, variant, layout = "inline", icon, onDismiss, dismissLabel = "Dismiss", className, render, children, ...props }: AlertProps) {
  const tone = intent ?? variant ?? "neutral";
  const shownIcon = icon === false ? null : (icon ?? icons[tone]);
  return useRender({
    defaultTagName: "div",
    render,
    props: {
      role: tone === "danger" || tone === "warning" ? "alert" : "status",
      "data-slot": "alert",
      "data-intent": tone,
      "data-layout": layout,
      ...props,
      className: cn(base, alertVariants.intent[tone], alertVariants.layout[layout], className),
      children: (
        <>
          {shownIcon ? (
            <span data-slot="alert-icon" aria-hidden="true" className={classes.icon}>
              {shownIcon}
            </span>
          ) : null}
          <div className={classes.content}>{children}</div>
          {onDismiss ? (
            <IconButton aria-label={dismissLabel} size="small" onClick={onDismiss} className={classes.dismiss}>
              <Icon icon={Dismiss} />
            </IconButton>
          ) : null}
        </>
      ),
    },
  });
}

export type AlertTitleProps = Omit<useRender.ComponentProps<"p">, "className"> & { className?: string };

/** The message in a few words ("Query failed"), in text.body-strong and the status colour. */
export function AlertTitle({ className, render, ...props }: AlertTitleProps) {
  return useRender({ defaultTagName: "p", render, props: { "data-slot": "alert-title", ...props, className: cn(classes.title, className) } });
}

export type AlertDescriptionProps = Omit<useRender.ComponentProps<"div">, "className"> & { className?: string };

/** The detail: what happened and what to do; `<code>` inside is set in the code font. */
export function AlertDescription({ className, render, ...props }: AlertDescriptionProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "alert-description", ...props, className: cn(classes.description, className) } });
}

export type AlertActionsProps = Omit<useRender.ComponentProps<"div">, "className"> & { className?: string };

/** Buttons that act on the message (Retry, Open settings). */
export function AlertActions({ className, render, ...props }: AlertActionsProps) {
  return useRender({ defaultTagName: "div", render, props: { "data-slot": "alert-actions", ...props, className: cn(classes.actions, className) } });
}
