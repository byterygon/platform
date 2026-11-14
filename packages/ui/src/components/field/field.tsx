import { Field as FieldPrimitive } from "@base-ui/react/field";
import { Fieldset as FieldsetPrimitive } from "@base-ui/react/fieldset";
import { createContext, use } from "react";
import { cn } from "@/lib/cn";

// Field groups a label, a control, a description and an error on Base UI's Field parts. Base UI
// links them (the label's htmlFor, the control's aria-describedby and aria-invalid) and sets
// data-invalid, data-touched, data-dirty, data-disabled on every part. Form state comes from
// TanStack Form: pass the render argument of `form.Field` as `field`, and Field maps its meta to
// Base UI's controlled `invalid`, `touched` and `dirty`, and FieldError shows its errors.
// A group of options (RadioGroup, CheckboxGroup) is one Field: FieldLegend names the group and
// each option is a FieldItem whose FieldLabel wraps the control. FieldSet groups whole Fields
// under a FieldLegend.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const fieldVariants = {} as const;

const base = ["flex min-w-0 flex-col gap-stack-xs font-sans"];

const labelClasses = [
  "inline-flex w-fit items-center gap-inline-sm text-label text-fg",
  // An option of a group keeps its colour; the group says it is invalid through FieldLegend.
  "not-in-data-[slot=field-item]:data-invalid:text-danger-fg",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

const descriptionClasses = ["text-caption text-fg-muted"];

const itemClasses = ["flex min-w-0 flex-col gap-stack-xs"];

const setClasses = ["flex min-w-0 flex-col gap-stack-md"];

const legendClasses = [
  "text-label text-fg",
  "in-data-invalid:text-danger-fg",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

const errorClasses = ["text-caption text-danger-fg"];

/**
 * What Field reads from a TanStack Form field, the argument of `form.Field`'s render function.
 * Structural, so any form state with the same shape works too.
 */
export interface FieldState {
  readonly name: string;
  readonly state: {
    readonly meta: {
      readonly isTouched: boolean;
      readonly isDirty: boolean;
      readonly isValid: boolean;
      /** Validation errors: strings, or objects with a `message` (Standard Schema issues). */
      readonly errors: readonly unknown[];
    };
  };
}

// Base UI's Field.Error follows its own validity, which a controlled `invalid` does not set, so
// Field tells FieldError whether it is invalid (undefined: leave it to Base UI's validation).
const FieldErrorsContext = createContext<{ invalid: boolean | undefined; errors: readonly unknown[] } | null>(null);

/** The messages of a list of validation errors: strings as they are, objects by their `message`. */
export function errorMessages(errors: readonly unknown[]): string[] {
  const messages = errors.flatMap((error) => {
    if (typeof error === "string") return [error];
    if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return [error.message];
    return [];
  });
  return [...new Set(messages.filter((message) => message.trim()))];
}

export interface FieldProps extends Omit<FieldPrimitive.Root.Props, "className"> {
  /**
   * A TanStack Form field (`{(field) => <Field field={field}>…</Field>}`). Sets `name`, `touched`
   * and `dirty` from it, and `invalid` once the field is touched and has errors (TanStack Form
   * marks every field touched on submit). Explicit `name`, `invalid`, `touched`, `dirty` win.
   */
  field?: FieldState;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A form field on Base UI's Field.Root: a column of FieldLabel, the control (Input, Textarea,
 * InputGroup), FieldDescription and FieldError. The ref reaches the `<div>`.
 */
export function Field({ field, name, invalid, touched, dirty, className, ...props }: FieldProps) {
  const meta = field?.state.meta;
  const shown = invalid ?? (meta ? meta.isTouched && !meta.isValid : undefined);
  return (
    <FieldErrorsContext value={{ invalid: shown, errors: meta?.errors ?? [] }}>
      <FieldPrimitive.Root
        data-slot="field"
        name={name ?? field?.name}
        invalid={shown}
        touched={touched ?? meta?.isTouched}
        dirty={dirty ?? meta?.isDirty}
        className={cn(base, className)}
        {...props}
      />
    </FieldErrorsContext>
  );
}

export interface FieldLabelProps extends Omit<FieldPrimitive.Label.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * The field's visible label, a `<label>` tied to the control. Turns danger-coloured when the field
 * is invalid. Wrap a Checkbox, Radio or Switch in it to label it: the control and the text sit in
 * a row, and clicking the text toggles the control.
 */
export function FieldLabel({ className, ...props }: FieldLabelProps) {
  return <FieldPrimitive.Label data-slot="field-label" className={cn(labelClasses, className)} {...props} />;
}

export interface FieldDescriptionProps extends Omit<FieldPrimitive.Description.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/** A hint under the control, a `<p>` the control names in aria-describedby. */
export function FieldDescription({ className, ...props }: FieldDescriptionProps) {
  return <FieldPrimitive.Description data-slot="field-description" className={cn(descriptionClasses, className)} {...props} />;
}

export interface FieldErrorProps extends Omit<FieldPrimitive.Error.Props, "className"> {
  /** Errors to show instead of the field's (strings or objects with `message`); children win over both. */
  errors?: readonly unknown[];
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * The validation message, shown only while the field is invalid and named by the control's
 * aria-describedby. Inside a Field with `field`, it shows that field's errors, one per line;
 * otherwise its children, or Base UI's native validation message.
 */
export function FieldError({ errors, match, children, className, ...props }: FieldErrorProps) {
  const context = use(FieldErrorsContext);
  const messages = errorMessages(errors ?? context?.errors ?? []);
  const content = children ?? (messages.length > 1 ? messages.map((message) => <span key={message} className="block">{message}</span>) : messages[0]);
  return <FieldPrimitive.Error data-slot="field-error" match={match ?? context?.invalid} className={cn(errorClasses, className)} {...props}>{content}</FieldPrimitive.Error>;
}

export interface FieldItemProps extends Omit<FieldPrimitive.Item.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * One option of a group inside a Field (a radio, a checkbox of a CheckboxGroup): a column of its
 * FieldLabel, which wraps the control, and an optional FieldDescription tied to that option.
 */
export function FieldItem({ className, ...props }: FieldItemProps) {
  return <FieldPrimitive.Item data-slot="field-item" className={cn(itemClasses, className)} {...props} />;
}

export interface FieldSetProps extends Omit<FieldsetPrimitive.Root.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A `<fieldset>` that groups related Fields under a FieldLegend ("Connection", "Authentication");
 * `disabled` disables every control inside. RadioGroup and CheckboxGroup are fieldsets themselves.
 */
export function FieldSet({ className, ...props }: FieldSetProps) {
  return <FieldsetPrimitive.Root data-slot="field-set" className={cn(setClasses, className)} {...props} />;
}

export interface FieldLegendProps extends Omit<FieldsetPrimitive.Legend.Props, "className"> {
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * The name of a FieldSet, RadioGroup or CheckboxGroup, placed first inside it; the group's
 * aria-labelledby points to it. Only valid inside one of those.
 */
export function FieldLegend({ className, ...props }: FieldLegendProps) {
  return <FieldsetPrimitive.Legend data-slot="field-legend" className={cn(legendClasses, className)} {...props} />;
}
