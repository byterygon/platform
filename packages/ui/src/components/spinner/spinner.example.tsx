import { Spinner } from "@/components/spinner/spinner";

/** The smallest useful Spinner. */
export function SpinnerMinimal() {
  return <Spinner />;
}

/** Loading states in DBee: a tree node's children, a running query in a tab, sizes and colours. */
export function SpinnerRealistic() {
  return (
    <div className="flex flex-col gap-stack-sm text-body text-fg">
      <div className="flex items-center gap-inline-sm text-fg-muted">
        <Spinner size="sm" label="Loading tables" />
        <span aria-hidden="true">Loading tables…</span>
      </div>
      <div className="flex items-center gap-inline-sm">
        <Spinner variant="accent" label="Query 1 is running" />
        <span>Query 1</span>
      </div>
      <div className="flex items-center gap-inline-md">
        <Spinner size="sm" variant="muted" label={null} />
        <Spinner size="md" variant="muted" label={null} />
        <Spinner size="lg" variant="muted" label="Connecting to orders-prod" />
      </div>
    </div>
  );
}
