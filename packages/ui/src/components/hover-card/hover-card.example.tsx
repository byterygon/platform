import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/hover-card/hover-card";

const link = "rounded-xs text-fg-link underline underline-offset-4 outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring";

/** The smallest useful HoverCard: a table name in a message previews the table. */
export function HoverCardMinimal() {
  return (
    <p className="text-body text-fg">
      Rows were read from{" "}
      <HoverCard>
        <HoverCardTrigger href="#public.orders" className={link}>
          public.orders
        </HoverCardTrigger>
        <HoverCardContent>
          <p className="text-body-strong text-fg">public.orders</p>
          <p className="text-body text-fg-muted">Table, 1,204,331 rows, 12 columns.</p>
        </HoverCardContent>
      </HoverCard>
      .
    </p>
  );
}

const columns = [
  ["id", "bigint", "not null"],
  ["customer_id", "bigint", "not null"],
  ["status", "text", "null"],
  ["created_at", "timestamptz", "not null"],
];

/** A foreign key in a column list previews the referenced table's columns (open from the start, so the gallery shows it). */
export function HoverCardRealistic() {
  return (
    <p className="text-body text-fg">
      customer_id references{" "}
      <HoverCard defaultOpen>
        <HoverCardTrigger href="#public.customers" delay={300} className={link}>
          public.customers
        </HoverCardTrigger>
        <HoverCardContent side="right">
          <div className="flex flex-col gap-stack-xs">
            <p className="text-body-strong text-fg">public.customers</p>
            <p className="text-caption text-fg-muted">Table in orders-prod, 88,410 rows</p>
          </div>
          <ul className="flex flex-col gap-stack-xs">
            {columns.map(([name, type, nullable]) => (
              <li key={name} className="flex items-center gap-inline-sm text-body">
                <span className="font-mono text-code text-fg">{name}</span>
                <span className="text-caption text-fg-muted">{type}</span>
                <span className="ms-auto text-caption text-fg-subtle">{nullable}</span>
              </li>
            ))}
          </ul>
        </HoverCardContent>
      </HoverCard>
      .
    </p>
  );
}
