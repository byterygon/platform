import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";

/** The smallest useful Field: a label and an input, tied together. */
export function FieldMinimal() {
  return (
    <Field>
      <FieldLabel>Database</FieldLabel>
      <Input placeholder="analytics" />
    </Field>
  );
}

/**
 * Connection details: a hint, an invalid port with its message, and a disabled driver. Field
 * state set by hand here; the Form example drives the same parts from TanStack Form.
 */
export function FieldRealistic() {
  return (
    <div className="flex flex-col gap-stack-md">
      <Field name="host">
        <FieldLabel>Host</FieldLabel>
        <Input defaultValue="db.internal" />
        <FieldDescription>A name or address on your network.</FieldDescription>
      </Field>
      <Field name="port" invalid>
        <FieldLabel>Port</FieldLabel>
        <Input size="sm" defaultValue="99999" inputMode="numeric" />
        <FieldError>The port must be between 1 and 65535.</FieldError>
      </Field>
      <Field name="driver" disabled>
        <FieldLabel>Driver</FieldLabel>
        <Input defaultValue="postgres" />
        <FieldDescription>Set by the workspace administrator.</FieldDescription>
      </Field>
    </div>
  );
}
