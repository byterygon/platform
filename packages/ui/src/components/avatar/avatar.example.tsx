import { Icon } from "@/components/icon/icon";
import { Avatar } from "@/components/avatar/avatar";
import { Database } from "@/lib/icons";

/** The smallest useful Avatar: initials from a name. */
export function AvatarMinimal() {
  return <Avatar name="Uy Son" />;
}

const DbIcon = () => <Icon icon={Database} />;

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
