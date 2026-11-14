import { Field, FieldDescription, FieldError, FieldItem, FieldLabel, FieldLegend, FieldSet } from "@/components/field/field";
import { Input } from "@/components/input/input";
import { RadioGroup, RadioGroupItem } from "@/components/radio-group/radio-group";

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
 * Connection details in a FieldSet: a hint, an invalid port with its message, a disabled driver,
 * and a group of options (FieldLegend, a FieldItem per option). Field state set by hand here; the
 * Form example drives the same parts from TanStack Form.
 */
export function FieldRealistic() {
  return (
    <FieldSet>
      <FieldLegend>Connection</FieldLegend>
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
      <Field name="auth">
        <RadioGroup defaultValue="password">
          <FieldLegend>Authentication</FieldLegend>
          <FieldItem>
            <FieldLabel>
              <RadioGroupItem value="password" />
              Password
            </FieldLabel>
          </FieldItem>
          <FieldItem>
            <FieldLabel>
              <RadioGroupItem value="certificate" />
              Client certificate
            </FieldLabel>
            <FieldDescription>Uses the certificate in the workspace keychain.</FieldDescription>
          </FieldItem>
        </RadioGroup>
      </Field>
    </FieldSet>
  );
}
