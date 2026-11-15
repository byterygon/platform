import { Stat, StatDelta, StatDescription, StatLabel, StatValue } from "@/components/stat/stat";

/** The smallest useful Stat: a label and a number. */
export function StatMinimal() {
  return (
    <Stat>
      <StatLabel>Rows returned</StatLabel>
      <StatValue>1,204</StatValue>
    </Stat>
  );
}

/** A query's run summary: time up (bad), rows down (neutral), size flat, and small stats in a dense row. */
export function StatRealistic() {
  return (
    <div className="flex flex-col gap-stack-lg">
      <div className="flex flex-wrap gap-gap-xl">
        <Stat>
          <StatLabel>Query time</StatLabel>
          <StatValue>38 ms</StatValue>
          <StatDelta trend="up" intent="negative">
            12 %
          </StatDelta>
          <StatDescription>since the previous run</StatDescription>
        </Stat>
        <Stat>
          <StatLabel>Rows returned</StatLabel>
          <StatValue>1,204</StatValue>
          <StatDelta trend="down" intent="neutral">
            96
          </StatDelta>
        </Stat>
        <Stat>
          <StatLabel>Table size</StatLabel>
          <StatValue>2.4 GB</StatValue>
          <StatDelta trend="flat">0 %</StatDelta>
        </Stat>
        <Stat>
          <StatLabel>Cache hit ratio</StatLabel>
          <StatValue>99.2 %</StatValue>
          <StatDelta trend="up">0.4 pt</StatDelta>
        </Stat>
      </div>
      <div className="flex w-panel-sm flex-wrap gap-gap-lg">
        <Stat size="sm">
          <StatLabel>Connections in use by the analytics warehouse replica</StatLabel>
          <StatValue>18 / 100</StatValue>
        </Stat>
        <Stat size="sm">
          <StatLabel>Locks</StatLabel>
          <StatValue>3</StatValue>
        </Stat>
      </div>
    </div>
  );
}
