import { Progress } from "@/components/progress/progress";

/** The smallest useful Progress: a labelled bar at 40 %. */
export function ProgressMinimal() {
  return <Progress value={40} label="Exporting" className="max-w-panel-sm" />;
}

/** DBee's export dialog: running with a row count, indeterminate while counting, the outcomes, and a long label that truncates. */
export function ProgressRealistic() {
  return (
    <div className="flex max-w-panel-md flex-col gap-stack-md">
      <Progress
        value={412_000}
        max={1_000_000}
        label="Exporting orders to orders.csv"
        showValue
        size="md"
        getAriaValueText={(_formatted, value) => `${(value ?? 0).toLocaleString("en")} of 1,000,000 rows`}
      />
      <Progress value={null} label="Counting rows" />
      <Progress value={100} variant="success" label="Export finished" showValue />
      <Progress value={73} variant="warning" label="Memory budget used" showValue />
      <Progress value={18} variant="danger" label="Export failed at row 180,224" showValue />
      <Progress value={55} label="Exporting analytics_warehouse_replica.customer_lifetime_value_by_region_and_month" showValue className="w-panel-xs" />
    </div>
  );
}
