import { addDays, startOfDay } from "date-fns";
import { DatePicker } from "@/components/date-picker/date-picker";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";

/** The smallest useful DatePicker: a labelled day, typed or picked. */
export function DatePickerMinimal() {
  return (
    <Field className="w-full">
      <FieldLabel>Restore to</FieldLabel>
      <DatePicker defaultValue={startOfDay(new Date())} />
    </Field>
  );
}

/**
 * A query-history filter: a range over the last thirty days, a snapshot date with weekends
 * closed and nothing chosen yet (invalid), a retention date the policy fixes, and the small size.
 */
export function DatePickerRealistic() {
  const today = startOfDay(new Date());
  return (
    <div className="flex w-full flex-col gap-stack-md">
      <Field name="history">
        <FieldLabel>Query history</FieldLabel>
        <DatePicker mode="range" defaultValue={{ from: addDays(today, -6), to: today }} min={addDays(today, -30)} max={today} />
        <FieldDescription>Up to thirty days back, as yyyy-MM-dd – yyyy-MM-dd.</FieldDescription>
      </Field>
      <Field name="snapshot" invalid>
        <FieldLabel>Snapshot date</FieldLabel>
        <DatePicker disabledDays={{ dayOfWeek: [0, 6] }} weekStartsOn={1} />
        <FieldError>Choose a weekday for the snapshot.</FieldError>
      </Field>
      <Field name="retention" disabled>
        <FieldLabel>Keep backups until</FieldLabel>
        <DatePicker defaultValue={addDays(today, 90)} />
        <FieldDescription>Set by the workspace administrator.</FieldDescription>
      </Field>
      <Field name="since">
        <FieldLabel>Changed since</FieldLabel>
        <DatePicker size="sm" format="dd/MM/yyyy" max={today} />
      </Field>
    </div>
  );
}
