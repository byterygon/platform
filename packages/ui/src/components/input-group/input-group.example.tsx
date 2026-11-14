import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/input-group/input-group";

function SearchIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3 3" />
    </svg>
  );
}

/** The smallest useful InputGroup: a search field with an icon. */
export function InputGroupMinimal() {
  return (
    <InputGroup>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput aria-label="Search tables" placeholder="Search tables" />
    </InputGroup>
  );
}

/** Connection settings: a scheme prefix with a Test button, an invalid value with a unit and a Reset button, a disabled path. */
export function InputGroupRealistic() {
  return (
    <div className="flex flex-col gap-stack-md">
      <Field>
        <FieldLabel>Server</FieldLabel>
        <InputGroup>
          <InputGroupAddon>postgres://</InputGroupAddon>
          <InputGroupInput defaultValue="db.internal:5432/analytics" />
          <InputGroupButton>Test</InputGroupButton>
        </InputGroup>
        <FieldDescription>Host, port and database.</FieldDescription>
      </Field>
      <Field invalid>
        <FieldLabel>Statement timeout</FieldLabel>
        <InputGroup size="sm">
          <InputGroupInput defaultValue="-5" inputMode="numeric" />
          <InputGroupAddon>ms</InputGroupAddon>
          <InputGroupButton>Reset</InputGroupButton>
        </InputGroup>
        <FieldError>Use 0 (no limit) or a positive number.</FieldError>
      </Field>
      <Field disabled>
        <FieldLabel>Socket directory</FieldLabel>
        <InputGroup size="lg">
          <InputGroupAddon>unix:</InputGroupAddon>
          <InputGroupInput defaultValue="/var/run/postgresql" />
        </InputGroup>
      </Field>
    </div>
  );
}
