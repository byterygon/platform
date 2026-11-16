import type { ComponentProps, ReactNode } from "react";
import { Icon } from "@/components/icon/icon";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { Checkmark, ErrorCircle } from "@/lib/icons";

// The steps of a task done in order (add a connection, then approve access, then connect): an
// ordered list of numbered steps that shows which are done, which is current and which failed.
// Data-driven: `steps`, `value` (the current index). With `onValueChange` the steps already done
// become buttons, so the user can go back. No Base UI part exists for it.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const stepperVariants = {
  /** A row of steps joined by lines, or a column (for a side panel). */
  orientation: {
    horizontal: "flex-row items-start gap-inline-sm",
    vertical: "flex-col",
  },
} as const;

export type StepStatus = "complete" | "current" | "upcoming" | "error";

const classes = {
  root: "flex w-full font-sans",
  item: "flex min-w-0 gap-inline-sm data-[orientation=horizontal]:flex-1 data-[orientation=horizontal]:items-center",
  marker: "flex shrink-0 flex-col items-center",
  indicator: [
    "flex size-control-sm shrink-0 items-center justify-center rounded-full border text-body-1-strong [&_svg]:size-icon-md",
    "data-[status=complete]:border-accent-solid data-[status=complete]:bg-accent-solid data-[status=complete]:text-accent-solid-fg",
    "data-[status=current]:border-accent-solid data-[status=current]:bg-layer data-[status=current]:text-fg",
    "data-[status=upcoming]:border-border-strong data-[status=upcoming]:bg-layer data-[status=upcoming]:text-fg-muted",
    "data-[status=error]:border-danger-border data-[status=error]:bg-danger-subtle data-[status=error]:text-danger-fg",
  ],
  text: "flex min-w-0 flex-col pb-stack-md data-[orientation=horizontal]:pb-0",
  title: "truncate text-body-1-strong text-fg data-[status=upcoming]:text-fg-muted data-[status=error]:text-danger-fg",
  description: "text-caption-1 text-fg-muted",
  connector: [
    "shrink-0 bg-border-strong data-[status=complete]:bg-accent-solid",
    "data-[orientation=horizontal]:h-px data-[orientation=horizontal]:min-w-control-sm data-[orientation=horizontal]:flex-1",
    "data-[orientation=vertical]:min-h-stack-md data-[orientation=vertical]:w-px data-[orientation=vertical]:flex-1",
  ],
  button: [
    "flex min-w-0 items-center gap-inline-sm rounded-md text-start data-[orientation=vertical]:items-start",
    "transition-colors duration-[var(--by-motion-duration-faster)] ease-easy-ease hover:bg-hover active:bg-pressed",
    focusRing,
  ],
} as const;

export interface Step {
  /** The step's name. */
  title: ReactNode;
  /** A line under the title. */
  description?: ReactNode;
  /** Marks a step that failed (it shows an error even if it is done or current). */
  error?: boolean;
}

/** The status of step `index` when step `value` is current. */
export function stepStatus(steps: readonly Step[], index: number, value: number): StepStatus {
  if (steps[index]?.error) return "error";
  if (index < value) return "complete";
  return index === value ? "current" : "upcoming";
}

const STATUS_TEXT: Record<StepStatus, string> = { complete: "completed", current: "current step", upcoming: "not started", error: "failed" };

export interface StepperItemProps {
  /** The step. */
  step: Step;
  /** Its position, from 0 (shown as index + 1). */
  index: number;
  /** Its status (stepStatus). */
  status: StepStatus;
  /** The Stepper's orientation. */
  orientation: keyof typeof stepperVariants.orientation;
  /** The last step has no connector. */
  last: boolean;
  /** When given and the step is complete, the step is a button calling it. */
  onSelect?: (() => void) | undefined;
}

/** One step: its indicator, title, description and connector. Stepper renders one per step. */
export function StepperItem({ step, index, status, orientation, last, onSelect }: StepperItemProps) {
  const indicator = (
    <span data-slot="stepper-indicator" data-status={status} aria-hidden="true" className={cn(classes.indicator)}>
      {status === "error" ? <Icon icon={ErrorCircle} /> : status === "complete" ? <Icon icon={Checkmark} /> : index + 1}
    </span>
  );
  const text = (
    <span data-slot="stepper-text" data-orientation={orientation} className={cn(classes.text)}>
      <span data-slot="stepper-title" data-status={status} className={cn(classes.title)}>
        {step.title}
      </span>
      {step.description ? (
        <span data-slot="stepper-description" className={cn(classes.description)}>
          {step.description}
        </span>
      ) : null}
      <span className="sr-only">, {STATUS_TEXT[status]}</span>
    </span>
  );
  const connector = last ? null : <span data-slot="stepper-connector" data-status={status} data-orientation={orientation} aria-hidden="true" className={cn(classes.connector)} />;
  const body = (
    <>
      {orientation === "vertical" ? (
        <span className={classes.marker}>
          {indicator}
          {connector}
        </span>
      ) : (
        indicator
      )}
      {text}
    </>
  );
  return (
    <li data-slot="stepper-item" data-status={status} data-orientation={orientation} aria-current={status === "current" ? "step" : undefined} className={cn(classes.item)}>
      {onSelect && status === "complete" ? (
        <button type="button" data-slot="stepper-button" data-orientation={orientation} onClick={onSelect} className={cn(classes.button)}>
          {body}
        </button>
      ) : (
        body
      )}
      {orientation === "horizontal" ? connector : null}
    </li>
  );
}

export interface StepperProps extends Omit<ComponentProps<"ol">, "className" | "onChange"> {
  /** The steps, in order. */
  steps: readonly Step[];
  /** The current step's index, from 0; steps.length when all are done. */
  value: number;
  /** Lets the user go back: the completed steps become buttons calling this with their index. */
  onValueChange?: (index: number) => void;
  /** A row (default) or a column. */
  orientation?: keyof typeof stepperVariants.orientation;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** Numbered steps joined by lines: done (accent, check), current, upcoming, failed. */
export function Stepper({ steps = [], value, onValueChange, orientation = "horizontal", className, "aria-label": label = "Progress", ...props }: StepperProps) {
  return (
    <ol data-slot="stepper" data-orientation={orientation} aria-label={label} className={cn(classes.root, stepperVariants.orientation[orientation], className)} {...props}>
      {steps.map((step, index) => (
        <StepperItem
          key={index}
          step={step}
          index={index}
          status={stepStatus(steps, index, value)}
          orientation={orientation}
          last={index === steps.length - 1}
          onSelect={onValueChange ? () => onValueChange(index) : undefined}
        />
      ))}
    </ol>
  );
}
