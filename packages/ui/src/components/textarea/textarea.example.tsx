import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { Textarea } from "@/components/textarea/textarea";

/** The smallest useful Textarea: a labelled multi-line field. */
export function TextareaMinimal() {
  return <Textarea aria-label="Notes" placeholder="What this connection is for" />;
}

/** A saved query's description in a Field, an invalid filter, and a read-only disabled one. */
export function TextareaRealistic() {
  return (
    <div className="flex flex-col gap-stack-md">
      <Field>
        <FieldLabel>Description</FieldLabel>
        <Textarea rows={4} defaultValue="Daily active users per region, for the Monday report." />
        <FieldDescription>Shown in the query library. Markdown is not rendered.</FieldDescription>
      </Field>
      <Field invalid>
        <FieldLabel>Filter</FieldLabel>
        <Textarea size="sm" rows={2} defaultValue="region = 'emea' AND" className="font-mono" />
        <FieldError>The filter ends with AND; add a condition or remove it.</FieldError>
      </Field>
      <Field disabled>
        <FieldLabel>Generated SQL</FieldLabel>
        <Textarea size="lg" rows={2} defaultValue="SELECT region, count(*) FROM sessions GROUP BY region;" />
      </Field>
    </div>
  );
}
