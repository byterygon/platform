// Small parts the NATS screens share: a fact of a DescriptionList and a usage bar against a limit
// (the Server's JetStream account, a stream's limits).
import type { ReactNode } from "react";
import { DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Progress } from "@/components/ui/progress";

export function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails>{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

/** One usage bar: "Storage 1.9 GiB / 10 GiB"; unlimited shows the use alone. */
export function Usage({ label, used, limit, format }: { label: string; used: number; limit: number | undefined; format: (n: number) => string }) {
  const limited = limit !== undefined && limit > 0;
  const pct = limited ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div className="flex flex-col gap-stack-xs">
      <div className="flex items-baseline justify-between gap-inline-md text-body-1">
        <span className="text-fg">{label}</span>
        <span className="tabular-nums text-fg-muted">{limited ? `${format(used)} / ${format(limit)}` : `${format(used)} · no limit`}</span>
      </div>
      <Progress aria-label={label} value={limited ? pct : 0} variant={pct >= 90 ? "danger" : pct >= 75 ? "warning" : "accent"} />
    </div>
  );
}
