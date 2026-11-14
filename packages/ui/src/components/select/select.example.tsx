import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectSeparator } from "@/components/select/select";

const sslModes = [
  { value: "disable", label: "Disable" },
  { value: "prefer", label: "Prefer" },
  { value: "require", label: "Require" },
  { value: "verify-full", label: "Verify full" },
];

/** The smallest useful Select: a labelled choice with a default. */
export function SelectMinimal() {
  return (
    <Field className="w-full">
      <FieldLabel>SSL mode</FieldLabel>
      <Select items={sslModes} defaultValue="prefer">
        {sslModes.map((mode) => (
          <SelectItem key={mode.value} value={mode.value}>
            {mode.label}
          </SelectItem>
        ))}
      </Select>
    </Field>
  );
}

const engines = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  clickhouse: "ClickHouse",
  duckdb: "DuckDB",
  oracle: "Oracle",
};

/**
 * A new connection: the engine in groups with a separator and an option the licence does not
 * cover, an encoding nobody has chosen yet (invalid), a schema the policy fixes, and the small
 * and large sizes.
 */
export function SelectRealistic() {
  return (
    <div className="flex w-full flex-col gap-stack-md">
      <Field name="engine">
        <FieldLabel>Engine</FieldLabel>
        <Select items={engines} defaultValue="postgres">
          <SelectGroup>
            <SelectGroupLabel>Transactional</SelectGroupLabel>
            <SelectItem value="postgres">PostgreSQL</SelectItem>
            <SelectItem value="mysql">MySQL</SelectItem>
            <SelectItem value="sqlite">SQLite</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectGroupLabel>Analytical</SelectGroupLabel>
            <SelectItem value="clickhouse">ClickHouse</SelectItem>
            <SelectItem value="duckdb">DuckDB</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectItem value="oracle" disabled>
            Oracle (not in this licence)
          </SelectItem>
        </Select>
        <FieldDescription>The driver is bundled; nothing is downloaded.</FieldDescription>
      </Field>
      <Field name="encoding" invalid>
        <FieldLabel>Client encoding</FieldLabel>
        <Select items={{ utf8: "UTF-8", latin1: "LATIN1" }} placeholder="Choose an encoding" size="sm">
          <SelectItem value="utf8">UTF-8</SelectItem>
          <SelectItem value="latin1">LATIN1</SelectItem>
        </Select>
        <FieldError>Choose the encoding the server expects.</FieldError>
      </Field>
      <Field name="schema" disabled>
        <FieldLabel>Default schema</FieldLabel>
        <Select items={{ public: "public" }} defaultValue="public">
          <SelectItem value="public">public</SelectItem>
        </Select>
        <FieldDescription>Set by the workspace administrator.</FieldDescription>
      </Field>
      <Field name="isolation">
        <FieldLabel>Isolation level</FieldLabel>
        <Select items={{ "read-committed": "Read committed", "repeatable-read": "Repeatable read", serializable: "Serializable" }} defaultValue="read-committed" size="lg">
          <SelectItem value="read-committed">Read committed</SelectItem>
          <SelectItem value="repeatable-read">Repeatable read</SelectItem>
          <SelectItem value="serializable">Serializable</SelectItem>
        </Select>
      </Field>
    </div>
  );
}
