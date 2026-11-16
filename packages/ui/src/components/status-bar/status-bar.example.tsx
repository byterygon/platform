import { Icon } from "@/components/icon/icon";
import { StatusBar, StatusBarButton, StatusBarItem, StatusBarSpacer } from "@/components/status-bar/status-bar";
import { Database } from "@/lib/icons";

const DbIcon = () => <Icon icon={Database} />;

/** The smallest useful StatusBar: one item. */
export function StatusBarMinimal() {
  return (
    <StatusBar aria-label="Status">
      <StatusBarItem>Ready</StatusBarItem>
    </StatusBar>
  );
}

/** DBee's status line: connection button, a live row count, the cursor at the end; a narrow accent bar that truncates. */
export function StatusBarRealistic() {
  return (
    <div className="flex max-w-panel-lg flex-col gap-stack-md">
      <StatusBar aria-label="Status">
        <StatusBarButton>
          <DbIcon />
          <span>orders-prod (read-only)</span>
        </StatusBarButton>
        <StatusBarItem live>
          <span>1,204 rows in 38 ms</span>
        </StatusBarItem>
        <StatusBarSpacer />
        <StatusBarItem>
          <span>Ln 3, Col 18</span>
        </StatusBarItem>
        <StatusBarItem>
          <span>UTF-8</span>
        </StatusBarItem>
      </StatusBar>
      <StatusBar aria-label="Remote session status" variant="accent" className="w-panel-sm">
        <StatusBarButton>
          <DbIcon />
          <span>analytics_warehouse_replica_eu_central_1 via bastion.internal</span>
        </StatusBarButton>
        <StatusBarSpacer />
        <StatusBarItem title="Grant expires in 52 minutes">
          <span>Expires in 52 min</span>
        </StatusBarItem>
      </StatusBar>
    </div>
  );
}
