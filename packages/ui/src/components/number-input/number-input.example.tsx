import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { NumberInput } from "@/components/number-input/number-input";

/** The smallest useful NumberInput: a labelled number with steppers. */
export function NumberInputMinimal() {
  return (
    <Field>
      <FieldLabel>Port</FieldLabel>
      <NumberInput defaultValue={5432} min={1} max={65535} />
    </Field>
  );
}

/**
 * Connection limits: a pool size with bounds, a timeout in seconds with a unit format, a port out
 * of range, a fetch size the policy fixes, and the small and large sizes.
 */
export function NumberInputRealistic() {
  return (
    <div className="flex flex-col gap-stack-md">
      <Field name="pool">
        <FieldLabel>Pool size</FieldLabel>
        <NumberInput defaultValue={10} min={1} max={100} />
        <FieldDescription>Between 1 and 100 connections.</FieldDescription>
      </Field>
      <Field name="timeout">
        <FieldLabel>Statement timeout</FieldLabel>
        <NumberInput defaultValue={30} min={0} step={5} largeStep={60} format={{ style: "unit", unit: "second", unitDisplay: "long" }} />
        <FieldDescription>0 waits forever. Shift+arrow steps by a minute.</FieldDescription>
      </Field>
      <Field name="port" invalid>
        <FieldLabel>Port</FieldLabel>
        <NumberInput size="sm" defaultValue={70000} allowOutOfRange />
        <FieldError>The port must be between 1 and 65535.</FieldError>
      </Field>
      <Field name="fetch" disabled>
        <FieldLabel>Fetch size</FieldLabel>
        <NumberInput defaultValue={1000} />
        <FieldDescription>Set by the workspace administrator.</FieldDescription>
      </Field>
      <Field name="rows">
        <FieldLabel>Row limit</FieldLabel>
        <NumberInput size="lg" placeholder="No limit" min={1} />
      </Field>
    </div>
  );
}
