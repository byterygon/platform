import { useState } from "react";
import { SqlEditor, type SqlMarker, type SqlRun } from "@/components/sql-editor/sql-editor";

/** The smallest useful SqlEditor: a bordered editor with a query in it. */
export function SqlEditorMinimal() {
  return <SqlEditor aria-label="Query" defaultValue={"select id, email\nfrom users\nwhere created_at > now() - interval '7 days';\n"} />;
}

const QUERY = `-- Orders per region this week
select region, count(*) as orders, sum(total) as revenue
from orders
where placed_at >= date_trunc('week', now())
group by region
order by revenue desc;

select * from order_lines where order_id = $1;
`;

/**
 * A query tab: Ctrl+Enter reports the statement under the cursor, an error from the server is
 * underlined at its position, and the last result's SQL is shown read-only below.
 */
export function SqlEditorRealistic() {
  const [sql, setSql] = useState(QUERY);
  const [last, setLast] = useState<SqlRun | null>(null);
  const position = sql.indexOf("$1");
  const markers: SqlMarker[] = position >= 0 ? [{ start: position, end: position + 2, message: "there is no parameter $1", severity: "error" }] : [];
  return (
    <div className="flex flex-col gap-stack-md">
      <SqlEditor aria-label="Query 1" value={sql} onValueChange={setSql} onRun={setLast} markers={markers} placeholder="Write a query, then press Ctrl+Enter" />
      <p className="text-caption text-fg-muted" aria-live="polite">
        {last ? `Would run ${last.source === "selection" ? "the selection" : "the statement"} at ${last.start}–${last.end} (${last.statements.length} statement${last.statements.length === 1 ? "" : "s"}).` : "Press Ctrl+Enter in the editor to run the statement under the cursor."}
      </p>
      <SqlEditor aria-label="Last run statement" readOnly lineNumbers={false} className="h-control-lg" value={last?.text ?? "select 1;"} />
    </div>
  );
}
