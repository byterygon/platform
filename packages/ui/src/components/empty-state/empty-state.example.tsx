import { Button } from "@/components/button/button";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/empty-state/empty-state";

const DbIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
  </svg>
);

/** The smallest useful EmptyState: a title and a sentence. */
export function EmptyStateMinimal() {
  return (
    <EmptyState>
      <EmptyStateTitle>No rows</EmptyStateTitle>
      <EmptyStateDescription>The query ran and returned nothing.</EmptyStateDescription>
    </EmptyState>
  );
}

/** DBee's first run (centered, with actions) and a filter with no matches in the tree (inline, long text). */
export function EmptyStateRealistic() {
  return (
    <div className="flex flex-col gap-stack-lg">
      <EmptyState className="rounded-lg border border-border">
        <EmptyStateIcon>
          <DbIcon />
        </EmptyStateIcon>
        <EmptyStateTitle>No connections yet</EmptyStateTitle>
        <EmptyStateDescription>Add a PostgreSQL connection. You approve what it may reach before it is created.</EmptyStateDescription>
        <EmptyStateActions>
          <Button>Add connection</Button>
          <Button variant="ghost">Import from file</Button>
        </EmptyStateActions>
      </EmptyState>
      <EmptyState variant="inline" className="w-panel-xs rounded-md bg-inset">
        <EmptyStateIcon>
          <DbIcon />
        </EmptyStateIcon>
        <EmptyStateTitle render={<p />}>No matches</EmptyStateTitle>
        <EmptyStateDescription>No table in orders-prod matches customer_lifetime_value_by_region_and_month_v2.</EmptyStateDescription>
      </EmptyState>
    </div>
  );
}
