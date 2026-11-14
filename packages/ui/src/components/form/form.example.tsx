import { revalidateLogic, useForm } from "@tanstack/react-form";
import { useState } from "react";
import { Button } from "@/components/button/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { Form } from "@/components/form/form";
import { Input } from "@/components/input/input";
import { Textarea } from "@/components/textarea/textarea";

/** The smallest useful Form: one validated field and a submit button. */
export function FormMinimal() {
  const [saved, setSaved] = useState("");
  const form = useForm({
    defaultValues: { table: "orders" },
    onSubmit: ({ value }) => setSaved(value.table),
  });
  return (
    <Form form={form} aria-label="Rename table">
      <form.Field name="table" validators={{ onBlur: ({ value }) => (/^[a-z_][a-z0-9_]*$/.test(value) ? undefined : "Use lowercase letters, digits and underscores.") }}>
        {(field) => (
          <Field field={field}>
            <FieldLabel>New name</FieldLabel>
            <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} />
            <FieldError />
          </Field>
        )}
      </form.Field>
      <div className="flex items-center gap-inline-md">
        <Button type="submit">Rename</Button>
        <p role="status" className="text-caption text-fg-muted">
          {saved && `Renamed to ${saved}.`}
        </p>
      </div>
    </Form>
  );
}

interface Connection {
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  notes: string;
}

/** The checks of the connection form: every message names what to do. */
function validateConnection(value: Connection): Partial<Record<keyof Connection, string>> {
  const errors: Partial<Record<keyof Connection, string>> = {};
  if (!value.name.trim()) errors.name = "Give the connection a name.";
  if (!value.host.trim()) errors.host = "Enter the server's host name or address.";
  else if (/\s/.test(value.host)) errors.host = "A host name has no spaces.";
  const port = Number(value.port);
  if (!/^\d+$/.test(value.port) || port < 1 || port > 65535) errors.port = "Use a port from 1 to 65535.";
  if (!value.database.trim()) errors.database = "Enter the database to open.";
  if (!value.user.trim()) errors.user = "Enter the user to sign in as.";
  if (value.notes.length > 200) errors.notes = `Keep notes to 200 characters (now ${value.notes.length}).`;
  return errors;
}

/**
 * A database connection form: validated on submit, then on every change (revalidateLogic), each
 * error under its field, focus on the first invalid field, and a loading button while saving.
 */
export function FormRealistic() {
  const [saved, setSaved] = useState("");
  const form = useForm({
    defaultValues: { name: "", host: "", port: "5432", database: "", user: "", password: "", notes: "" } satisfies Connection as Connection,
    validationLogic: revalidateLogic({ mode: "submit", modeAfterSubmission: "change" }),
    validators: {
      onDynamic: ({ value }) => {
        const fields = validateConnection(value);
        return Object.keys(fields).length > 0 ? { fields } : undefined;
      },
    },
    onSubmit: async ({ value }) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      setSaved(`Saved ${value.name}.`);
    },
  });
  return (
    <Form form={form} aria-label="New connection" className="w-full">
      <form.Field name="name">
        {(field) => (
          <Field field={field}>
            <FieldLabel>Name</FieldLabel>
            <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} placeholder="Analytics (production)" />
            <FieldError />
          </Field>
        )}
      </form.Field>
      <div className="flex flex-wrap items-start gap-inline-md">
        <form.Field name="host">
          {(field) => (
            <Field field={field} className="flex-1">
              <FieldLabel>Host</FieldLabel>
              <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} placeholder="db.internal" autoComplete="off" spellCheck={false} />
              <FieldDescription>A name or address on your network.</FieldDescription>
              <FieldError />
            </Field>
          )}
        </form.Field>
        <form.Field name="port">
          {(field) => (
            <Field field={field}>
              <FieldLabel>Port</FieldLabel>
              <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} inputMode="numeric" />
              <FieldError />
            </Field>
          )}
        </form.Field>
      </div>
      <form.Field name="database">
        {(field) => (
          <Field field={field}>
            <FieldLabel>Database</FieldLabel>
            <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} placeholder="analytics" spellCheck={false} />
            <FieldError />
          </Field>
        )}
      </form.Field>
      <div className="flex flex-wrap items-start gap-inline-md">
        <form.Field name="user">
          {(field) => (
            <Field field={field} className="flex-1">
              <FieldLabel>User</FieldLabel>
              <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} autoComplete="username" spellCheck={false} />
              <FieldError />
            </Field>
          )}
        </form.Field>
        <form.Field name="password">
          {(field) => (
            <Field field={field} className="flex-1">
              <FieldLabel>Password</FieldLabel>
              <Input type="password" value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} autoComplete="current-password" />
              <FieldDescription>Stored in the system keychain, never in the workspace file.</FieldDescription>
            </Field>
          )}
        </form.Field>
      </div>
      <form.Field name="notes">
        {(field) => (
          <Field field={field}>
            <FieldLabel>Notes</FieldLabel>
            <Textarea value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} rows={2} />
            <FieldDescription>Optional, up to 200 characters.</FieldDescription>
            <FieldError />
          </Field>
        )}
      </form.Field>
      <div className="flex items-center gap-inline-md">
        <form.Subscribe selector={(state) => state.isSubmitting}>{(submitting) => <Button type="submit" loading={submitting}>Save connection</Button>}</form.Subscribe>
        <Button variant="ghost" onClick={() => form.reset()}>
          Reset
        </Button>
        <p role="status" className="text-caption text-fg-muted">
          {saved}
        </p>
      </div>
    </Form>
  );
}
