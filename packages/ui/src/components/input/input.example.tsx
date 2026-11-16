import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";

/** The smallest useful Input: a labelled text field. */
export function InputMinimal() {
  return <Input aria-label="Table name" placeholder="customers" />;
}

/**
 * A connection form: the four Fluent appearances, the three sizes, a hint, an invalid field with
 * its message, and a disabled field.
 */
export function InputRealistic() {
  return (
    <form className="flex flex-col gap-stack-md">
      <Field>
        <FieldLabel>Host</FieldLabel>
        <Input name="host" defaultValue="db.internal" />
        <FieldDescription>A name or address on your network.</FieldDescription>
      </Field>
      <Field invalid>
        <FieldLabel>Port</FieldLabel>
        <Input name="port" size="small" defaultValue="99999" />
        <FieldError>The port must be between 1 and 65535.</FieldError>
      </Field>
      <Field>
        <FieldLabel>Database</FieldLabel>
        <Input name="database" appearance="underline" placeholder="postgres" />
      </Field>
      <Field>
        <FieldLabel>User</FieldLabel>
        <Input name="user" appearance="filled-darker" defaultValue="analyst" />
      </Field>
      <Field>
        <FieldLabel>Ghi chú</FieldLabel>
        <Input name="note" appearance="filled-lighter" size="large" defaultValue="Kết nối chỉ đọc cho báo cáo" />
      </Field>
      <Field disabled>
        <FieldLabel>Driver</FieldLabel>
        <Input name="driver" defaultValue="postgres" />
      </Field>
    </form>
  );
}
