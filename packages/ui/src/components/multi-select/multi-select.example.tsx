import { ComboboxItem } from "@/components/combobox/combobox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { MultiSelect } from "@/components/multi-select/multi-select";

const columns = ["id", "customer_id", "status", "total", "created_at", "updated_at"];

/** The smallest useful MultiSelect: labelled columns, two already chosen. */
export function MultiSelectMinimal() {
  return (
    <Field className="w-full">
      <FieldLabel>Columns</FieldLabel>
      <MultiSelect items={columns} defaultValue={["id", "status"]} placeholder="Search columns">
        {(column: string) => (
          <ComboboxItem key={column} value={column}>
            {column}
          </ComboboxItem>
        )}
      </MultiSelect>
    </Field>
  );
}

interface Privilege {
  value: string;
  label: string;
}

const privileges: Privilege[] = [
  { value: "select", label: "SELECT" },
  { value: "insert", label: "INSERT" },
  { value: "update", label: "UPDATE" },
  { value: "delete", label: "DELETE" },
  { value: "truncate", label: "TRUNCATE" },
];

const schemas = ["public", "analytics", "audit", "billing", "inventory"];

/**
 * A grant: privileges as `{ value, label }` objects, schemas with an empty-state message, tags
 * nobody has added yet (invalid), owners the policy fixes, and the small and large sizes.
 */
export function MultiSelectRealistic() {
  return (
    <div className="flex w-full flex-col gap-stack-md">
      <Field name="privileges">
        <FieldLabel>Privileges</FieldLabel>
        <MultiSelect items={privileges} defaultValue={[privileges[0]!, privileges[1]!]} placeholder="Add privileges">
          {(privilege: Privilege) => (
            <ComboboxItem key={privilege.value} value={privilege}>
              {privilege.label}
            </ComboboxItem>
          )}
        </MultiSelect>
        <FieldDescription>Backspace removes the last one.</FieldDescription>
      </Field>
      <Field name="schemas">
        <FieldLabel>Schemas</FieldLabel>
        <MultiSelect items={schemas} placeholder="Search schemas" emptyMessage="No schema matches." size="sm">
          {(schema: string) => (
            <ComboboxItem key={schema} value={schema}>
              {schema}
            </ComboboxItem>
          )}
        </MultiSelect>
      </Field>
      <Field name="tags" invalid>
        <FieldLabel>Tags</FieldLabel>
        <MultiSelect items={["production", "pii", "reporting"]} placeholder="Add tags">
          {(tag: string) => (
            <ComboboxItem key={tag} value={tag}>
              {tag}
            </ComboboxItem>
          )}
        </MultiSelect>
        <FieldError>Add at least one tag.</FieldError>
      </Field>
      <Field name="owners" disabled>
        <FieldLabel>Owners</FieldLabel>
        <MultiSelect items={["dba", "platform"]} defaultValue={["dba"]}>
          {(owner: string) => (
            <ComboboxItem key={owner} value={owner}>
              {owner}
            </ComboboxItem>
          )}
        </MultiSelect>
        <FieldDescription>Set by the workspace administrator.</FieldDescription>
      </Field>
      <Field name="notify">
        <FieldLabel>Notify</FieldLabel>
        <MultiSelect items={["on-call", "data-team", "security"]} defaultValue={["on-call"]} size="lg">
          {(team: string) => (
            <ComboboxItem key={team} value={team}>
              {team}
            </ComboboxItem>
          )}
        </MultiSelect>
      </Field>
    </div>
  );
}
