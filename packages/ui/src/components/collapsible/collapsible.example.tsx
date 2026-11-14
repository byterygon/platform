import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/collapsible/collapsible";

/** The smallest useful Collapsible: a trigger and a panel. */
export function CollapsibleMinimal() {
  return (
    <Collapsible>
      <CollapsibleTrigger>Show details</CollapsibleTrigger>
      <CollapsiblePanel>
        <p className="p-inset-xs text-body text-fg">Connected through the Plugin Host broker.</p>
      </CollapsiblePanel>
    </Collapsible>
  );
}

const notices = [
  'NOTICE: table "orders_tmp" does not exist, skipping',
  'NOTICE: relation "orders_status_idx" already exists, skipping',
  "WARNING: there is no transaction in progress",
];

/** Server notices under a query result, open; a disabled section; a long label that wraps. */
export function CollapsibleRealistic() {
  return (
    <div className="flex max-w-panel-md flex-col gap-stack-sm">
      <Collapsible defaultOpen>
        <CollapsibleTrigger>3 notices</CollapsibleTrigger>
        <CollapsiblePanel>
          <ul className="flex flex-col gap-stack-xs rounded-md bg-inset p-inset-sm font-mono text-code text-fg">
            {notices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </CollapsiblePanel>
      </Collapsible>
      <Collapsible disabled>
        <CollapsibleTrigger>Query plan (run EXPLAIN first)</CollapsibleTrigger>
        <CollapsiblePanel>Plan</CollapsiblePanel>
      </Collapsible>
      <Collapsible>
        <CollapsibleTrigger>Statement 2 of 2: insert into analytics.events_partitioned_by_day_with_a_very_long_name select * from staging.events</CollapsibleTrigger>
        <CollapsiblePanel>
          <p className="p-inset-xs text-body text-fg">1,204 rows inserted.</p>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
