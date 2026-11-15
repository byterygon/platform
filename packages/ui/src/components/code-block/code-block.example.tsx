import { CodeBlock } from "@/components/code-block/code-block";

/** The smallest useful CodeBlock: one highlighted statement. */
export function CodeBlockMinimal() {
  return <CodeBlock language="sql" code="select id, status from orders where status = 'open';" className="max-w-panel-md" />;
}

const ddl = `-- public.orders, as created on 14 Nov 2026
create table public.orders (
  id          bigint generated always as identity primary key,
  customer_id bigint not null references public.customers (id),
  status      text not null default 'open' check (status in ('open', 'paid', 'shipped')),
  total       numeric(12, 2),
  created_at  timestamptz not null default now()
);
create index orders_status_idx on public.orders (status) where status <> 'shipped';`;

const manifest = `{
  "name": "db-driver-postgres",
  "version": "0.1.0",
  "firstParty": true,
  "grants": [{ "host": "db.internal", "port": 5432, "tls": "verify-full" }],
  "digest": null
}`;

const history = Array.from({ length: 5000 }, (_, i) => `select * from events where id = ${i + 1}; -- run ${i + 1}`).join("\n");

/** A table's DDL with a title and a highlighted line, a JSON manifest that wraps, and 5,000 lines of history virtualized. */
export function CodeBlockRealistic() {
  return (
    <div className="flex w-full min-w-0 max-w-panel-xl flex-col gap-stack-md">
      <CodeBlock title="public.orders.sql" language="sql" code={ddl} highlightLines={[5]} />
      <CodeBlock title="plugin.json" language="json" code={manifest} wrap className="max-w-panel-sm" />
      <CodeBlock title="History (5,000 statements)" language="sql" code={history} className="h-panel-sm" />
    </div>
  );
}
