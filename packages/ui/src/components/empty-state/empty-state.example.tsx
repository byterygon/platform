import { Icon } from "@/components/icon/icon";
import { Button } from "@/components/button/button";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/empty-state/empty-state";
import { Database } from "@/lib/icons";

const DbIcon = () => <Icon icon={Database} />;

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
          <Button appearance="subtle">Import from file</Button>
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
