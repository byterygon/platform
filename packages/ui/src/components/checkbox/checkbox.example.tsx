import { useState } from "react";
import { Checkbox, CheckboxGroup } from "@/components/checkbox/checkbox";
import { Field, FieldDescription, FieldError, FieldItem, FieldLabel, FieldLegend } from "@/components/field/field";

/** The smallest useful Checkbox: one choice with its label. */
export function CheckboxMinimal() {
  return (
    <Field>
      <FieldLabel>
        <Checkbox defaultChecked />
        Include column headers
      </FieldLabel>
    </Field>
  );
}

const tables = ["customers", "orders", "invoices"];

/**
 * Export options: a "select all" parent over a group of tables (mixed while some are ticked), a
 * table that cannot be exported, an error when none is chosen, and the three sizes.
 */
export function CheckboxRealistic() {
  const [selected, setSelected] = useState(["customers"]);
  return (
    <div className="flex flex-col gap-stack-md">
      <Field name="tables" invalid={selected.length === 0}>
        <CheckboxGroup value={selected} onValueChange={setSelected} allValues={tables}>
          <FieldLegend>Tables to export</FieldLegend>
          <FieldItem>
            <FieldLabel>
              <Checkbox parent />
              All tables
            </FieldLabel>
          </FieldItem>
          {tables.map((table) => (
            <FieldItem key={table} className="ps-inset-lg">
              <FieldLabel>
                <Checkbox value={table} />
                {table}
              </FieldLabel>
            </FieldItem>
          ))}
          <FieldItem className="ps-inset-lg" disabled>
            <FieldLabel>
              <Checkbox value="audit_log" />
              audit_log
            </FieldLabel>
            <FieldDescription>Only administrators can export the audit log.</FieldDescription>
          </FieldItem>
        </CheckboxGroup>
        <FieldError>Choose at least one table.</FieldError>
      </Field>
      <Field>
        <FieldLabel className="text-caption">
          <Checkbox size="sm" defaultChecked />
          Quote every value
        </FieldLabel>
      </Field>
      <Field>
        <FieldLabel className="text-body">
          <Checkbox size="lg" />
          Compress the file
        </FieldLabel>
      </Field>
    </div>
  );
}
