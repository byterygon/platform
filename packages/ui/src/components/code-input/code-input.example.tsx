import { useState } from "react";
import { CodeInput } from "@/components/code-input/code-input";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";

/** The smallest useful CodeInput: a one-line SQL expression. */
export function CodeInputMinimal() {
  return <CodeInput aria-label="Filter" language="sql" defaultValue="status = 'active' and created_at > now() - interval '1 day'" />;
}

/**
 * A results filter that applies on Enter, a JSON column value in a Field with an error, and the
 * read-only pretty viewer for a cell value.
 */
export function CodeInputRealistic() {
  const [filter, setFilter] = useState("region = 'emea'");
  const [applied, setApplied] = useState(filter);
  const [settings, setSettings] = useState('{"retries": 3, "timeout": }');
  let settingsError: string | undefined;
  try {
    JSON.parse(settings);
  } catch {
    settingsError = "Not valid JSON: a value is missing after \"timeout\".";
  }
  return (
    <div className="flex w-full flex-col gap-stack-md">
      <Field>
        <FieldLabel>Filter rows</FieldLabel>
        <CodeInput language="sql" size="sm" value={filter} onValueChange={setFilter} onSubmit={setApplied} placeholder="A SQL condition, then Enter" />
        <FieldDescription>Applied: {applied || "nothing"}</FieldDescription>
      </Field>
      <Field invalid={settingsError !== undefined}>
        <FieldLabel>Connection settings</FieldLabel>
        <CodeInput language="json" multiline rows={2} value={settings} onValueChange={setSettings} />
        <FieldError match={settingsError !== undefined}>{settingsError}</FieldError>
      </Field>
      <CodeInput aria-label="Cell value" language="json" pretty value={'{"id":42,"tags":["new","vip"],"address":{"city":"Hanoi","zip":null},"active":true}'} />
      <CodeInput aria-label="Disabled filter" disabled defaultValue="id = 1" />
    </div>
  );
}
