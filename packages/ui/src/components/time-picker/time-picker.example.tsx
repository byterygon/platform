import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { TimePicker } from "@/components/time-picker/time-picker";

/** The smallest useful TimePicker: a labelled time on the 24-hour clock. */
export function TimePickerMinimal() {
  return (
    <Field className="w-full">
      <FieldLabel>Backup at</FieldLabel>
      <TimePicker defaultValue="02:30" />
    </Field>
  );
}

/**
 * A maintenance window: a start with seconds, an end on the 12-hour clock that nobody has set
 * yet (invalid), a time the policy fixes, and the small size in 15-minute steps.
 */
export function TimePickerRealistic() {
  return (
    <div className="flex w-full flex-col gap-stack-md">
      <Field name="window-start">
        <FieldLabel>Window starts</FieldLabel>
        <TimePicker defaultValue="23:00:00" seconds />
        <FieldDescription>Server time, 24-hour clock.</FieldDescription>
      </Field>
      <Field name="window-end" invalid>
        <FieldLabel>Window ends</FieldLabel>
        <TimePicker hourCycle={12} />
        <FieldError>Set when the window ends.</FieldError>
      </Field>
      <Field name="vacuum" disabled>
        <FieldLabel>Vacuum at</FieldLabel>
        <TimePicker defaultValue="04:00" />
        <FieldDescription>Set by the workspace administrator.</FieldDescription>
      </Field>
      <Field name="report">
        <FieldLabel>Daily report</FieldLabel>
        <TimePicker defaultValue="08:15" size="sm" minuteStep={15} />
      </Field>
    </div>
  );
}
