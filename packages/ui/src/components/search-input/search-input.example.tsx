import { useState } from "react";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { SearchInput } from "@/components/search-input/search-input";

/** The smallest useful SearchInput: a named search box. */
export function SearchInputMinimal() {
  return <SearchInput aria-label="Search tables" placeholder="Search tables" />;
}

const tables = ["customers", "customer_addresses", "orders", "order_items", "invoices"];

/**
 * A schema browser filter: the list narrows as you type and a status line counts the matches. Also
 * a small toolbar search with text already in it, a large one, and a disabled one.
 */
export function SearchInputRealistic() {
  const [query, setQuery] = useState("");
  const matches = tables.filter((table) => table.includes(query.trim().toLowerCase()));
  return (
    <div className="flex flex-col gap-stack-md">
      <Field>
        <FieldLabel>Filter tables</FieldLabel>
        <SearchInput value={query} onValueChange={setQuery} placeholder="Name contains…" />
        <FieldDescription>Escape clears the filter.</FieldDescription>
      </Field>
      <p role="status" className="text-caption text-fg-muted">
        {matches.length} of {tables.length} tables
      </p>
      <ul className="flex flex-col gap-stack-xs text-body text-fg">
        {matches.map((table) => (
          <li key={table} className="font-mono text-code">
            {table}
          </li>
        ))}
      </ul>
      <SearchInput aria-label="Search the result" size="sm" defaultValue="timeout" />
      <SearchInput aria-label="Search all workspaces" size="lg" placeholder="Search all workspaces" />
      <SearchInput aria-label="Search history" disabled placeholder="History is off" />
    </div>
  );
}
