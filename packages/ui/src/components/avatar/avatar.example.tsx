import { Avatar } from "@/components/avatar/avatar";

/** The smallest useful Avatar: initials from a name. */
export function AvatarMinimal() {
  return <Avatar name="Uy Son" />;
}

const DbIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-icon-sm">
    <ellipse cx="8" cy="4" rx="5" ry="2" />
    <path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />
  </svg>
);

/** People and connections in DBee: the three sizes, a square service avatar with an icon, a long name. */
export function AvatarRealistic() {
  return (
    <div className="flex flex-col gap-stack-sm text-body text-fg">
      <div className="flex items-center gap-inline-sm">
        <Avatar name="Uy Son" size="sm" />
        <Avatar name="Analyst Two" size="md" />
        <Avatar name="Database Administrator" size="lg" />
      </div>
      <div className="flex items-center gap-inline-sm">
        <Avatar name="orders-prod" shape="square" />
        <Avatar name="analytics warehouse" shape="square" fallback={<DbIcon />} />
        <span className="truncate">analytics_warehouse_replica_eu_central_1</span>
      </div>
    </div>
  );
}
