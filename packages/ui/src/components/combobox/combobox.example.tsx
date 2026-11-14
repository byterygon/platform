import { Combobox, ComboboxCollection, ComboboxGroup, ComboboxGroupLabel, ComboboxItem, ComboboxSeparator } from "@/components/combobox/combobox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";

const schemas = ["public", "analytics", "audit", "billing", "inventory", "staging"];

/** The smallest useful Combobox: a labelled list of strings, filtered as you type. */
export function ComboboxMinimal() {
  return (
    <Field className="w-full">
      <FieldLabel>Schema</FieldLabel>
      <Combobox items={schemas} defaultValue="public" placeholder="Search schemas">
        {(schema: string) => (
          <ComboboxItem key={schema} value={schema}>
            {schema}
          </ComboboxItem>
        )}
      </Combobox>
    </Field>
  );
}

interface Table {
  value: string;
  label: string;
}

const tables: { value: string; items: Table[] }[] = [
  {
    value: "public",
    items: [
      { value: "public.customers", label: "customers" },
      { value: "public.orders", label: "orders" },
      { value: "public.order_items", label: "order_items" },
    ],
  },
  {
    value: "audit",
    items: [
      { value: "audit.events", label: "events" },
      { value: "audit.sessions", label: "sessions" },
    ],
  },
];

const roles = ["dbee_reader", "dbee_writer", "dbee_admin"];

/**
 * Query targets: tables grouped by schema with a separator, a role that is still loading from the
 * server (status line), a time zone nobody has chosen (invalid), a database the connection fixes,
 * and the small and large sizes.
 */
export function ComboboxRealistic() {
  return (
    <div className="flex w-full flex-col gap-stack-md">
      <Field name="table">
        <FieldLabel>Table</FieldLabel>
        <Combobox items={tables} defaultValue={tables[0]!.items[1]!} placeholder="Search tables" emptyMessage="No table matches.">
          {(group: (typeof tables)[number], index: number) => (
            <ComboboxGroup key={group.value} items={group.items}>
              {index > 0 && <ComboboxSeparator />}
              <ComboboxGroupLabel>{group.value}</ComboboxGroupLabel>
              <ComboboxCollection>
                {(table: Table) => (
                  <ComboboxItem key={table.value} value={table}>
                    {table.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </Combobox>
        <FieldDescription>Only tables this connection can read are listed.</FieldDescription>
      </Field>
      <Field name="role">
        <FieldLabel>Run as role</FieldLabel>
        <Combobox items={roles} placeholder="Search roles" status="Loading roles…" size="sm">
          {(role: string) => (
            <ComboboxItem key={role} value={role}>
              {role}
            </ComboboxItem>
          )}
        </Combobox>
      </Field>
      <Field name="timezone" invalid>
        <FieldLabel>Session time zone</FieldLabel>
        <Combobox items={["UTC", "Europe/Berlin", "Asia/Ho_Chi_Minh"]} placeholder="Search time zones">
          {(zone: string) => (
            <ComboboxItem key={zone} value={zone}>
              {zone}
            </ComboboxItem>
          )}
        </Combobox>
        <FieldError>Choose the time zone timestamps are shown in.</FieldError>
      </Field>
      <Field name="database" disabled>
        <FieldLabel>Database</FieldLabel>
        <Combobox items={["warehouse"]} defaultValue="warehouse">
          {(name: string) => (
            <ComboboxItem key={name} value={name}>
              {name}
            </ComboboxItem>
          )}
        </Combobox>
        <FieldDescription>Fixed by the connection.</FieldDescription>
      </Field>
      <Field name="search-path">
        <FieldLabel>Search path</FieldLabel>
        <Combobox items={schemas} defaultValue="analytics" size="lg">
          {(schema: string) => (
            <ComboboxItem key={schema} value={schema}>
              {schema}
            </ComboboxItem>
          )}
        </Combobox>
      </Field>
    </div>
  );
}
