import { TypeBadge, typeGlyphs } from "@/components/type-badge/type-badge";

/** The smallest useful TypeBadge. */
export function TypeBadgeMinimal() {
  return <TypeBadge type="integer" />;
}

/** Every type family, real PostgreSQL type names, icon-only in a narrow grid header, a long name that truncates. */
export function TypeBadgeRealistic() {
  return (
    <div className="flex flex-col gap-stack-sm text-body text-fg">
      <div className="flex flex-wrap items-center gap-inline-md">
        {(Object.keys(typeGlyphs) as (keyof typeof typeGlyphs)[]).map((type) => (
          <TypeBadge key={type} type={type} />
        ))}
      </div>
      <ul className="flex flex-col gap-stack-xs">
        <li className="flex items-center gap-inline-sm">
          <span className="min-w-0 flex-1 truncate">total</span>
          <TypeBadge type="decimal" label="numeric(12,2)" />
        </li>
        <li className="flex items-center gap-inline-sm">
          <span className="min-w-0 flex-1 truncate">created_at</span>
          <TypeBadge type="datetime" label="timestamptz" />
        </li>
        <li className="flex items-center gap-inline-sm">
          <span className="min-w-0 flex-1 truncate">payload</span>
          <TypeBadge type="json" label="jsonb" />
        </li>
      </ul>
      <div className="flex w-panel-xs items-center gap-inline-sm">
        <span className="truncate">customer_id</span>
        <TypeBadge type="integer" iconOnly />
        <TypeBadge type="text" label="character varying(255) collate &quot;en_US&quot;" className="min-w-0" />
      </div>
    </div>
  );
}
