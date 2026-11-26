// The states every screen implements (Mightyconsole spec §3.5): Disconnected, Loading, Empty,
// Error and Live, as shared components the shell and the tools use.
import type { ReactNode } from "react";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { PlugDisconnected } from "@/lib/icons";
import type { DescribedError, LiveState } from "@/tools/types";
import { AccessNotice, useRefusals } from "./access-ui";
import { formatCount, remedyOf } from "./messages";

/** "Connect to orders-dev": the tab's content is dimmed and nothing is fetched. */
export function DisconnectedState({ name, onConnect, busy = false }: { name: string; onConnect: () => void; busy?: boolean }) {
  return (
    <EmptyState className="m-auto">
      <EmptyStateIcon>
        <Icon icon={PlugDisconnected} />
      </EmptyStateIcon>
      <EmptyStateTitle render={<p />}>Connect to {name}</EmptyStateTitle>
      <EmptyStateDescription>This tab shows nothing until the profile is connected.</EmptyStateDescription>
      <EmptyStateActions>
        <Button appearance="primary" onClick={onConnect} loading={busy}>
          Connect
        </Button>
      </EmptyStateActions>
    </EmptyState>
  );
}

/** Three skeleton rows in a list. */
export function LoadingRows({ label }: { label: string }) {
  return (
    <div aria-busy="true" aria-label={label} className="flex flex-col gap-stack-sm p-inset-sm">
      <Skeleton variant="text" />
      <Skeleton variant="text" />
      <Skeleton variant="text" />
    </div>
  );
}

/** One line of empty text with the action that fills the list. */
export function EmptyLine({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <p className="flex items-center gap-inline-sm p-inset-sm text-body-1 text-fg-muted">
      {children}
      {action}
    </p>
  );
}

/** The ToolError in place of the content, with its remote code, Details and remedy (spec §2.6). */
export function ErrorState({ error, onRetry, onEditProfile, onRefresh, onTrust }: { error: DescribedError; onRetry?: () => void; onEditProfile?: () => void; onRefresh?: () => void; onTrust?: () => void }) {
  const remedy = remedyOf(error);
  const refuse = useRefusals();
  const refusal = error.denied ? refuse(error.denied) : null;
  if (refusal) return <AccessNotice refusal={refusal} className="m-inset-md" />;
  return (
    <Alert intent="danger" className="m-inset-md">
      <AlertTitle>{error.title}</AlertTitle>
      <AlertDescription>
        {error.description ? <span>{error.description} </span> : null}
        {error.remoteCode ? (
          <span>
            Code <Code>{error.remoteCode}</Code>.{" "}
          </span>
        ) : null}
        {error.correlationId ? (
          <details>
            <summary>Details</summary>
            {error.code ? <span>{error.code} · </span> : null}
            correlation id <Code>{error.correlationId}</Code>
          </details>
        ) : null}
      </AlertDescription>
      <AlertActions>
        {remedy === "retry" && onRetry ? (
          <Button size="small" onClick={onRetry}>
            Retry
          </Button>
        ) : null}
        {(remedy === "editProfile" || remedy === "retry") && onEditProfile ? (
          <Button size="small" appearance="secondary" onClick={onEditProfile}>
            Edit profile
          </Button>
        ) : null}
        {remedy === "trust" && onTrust ? (
          <Button size="small" onClick={onTrust}>
            Review the host key
          </Button>
        ) : null}
        {remedy === "refresh" && onRefresh ? (
          <Button size="small" onClick={onRefresh}>
            Refresh
          </Button>
        ) : null}
      </AlertActions>
    </Alert>
  );
}

/** The text of a live state: "Live · 1,240 msg/s · 3 dropped", "Paused · 10,000 buffered". */
export function liveText(live: LiveState, unit = "msg/s"): string {
  switch (live.status) {
    case "live":
      return ["Live", live.ratePerSec !== undefined ? `${formatCount(live.ratePerSec)} ${unit}` : null, live.dropped ? `${formatCount(live.dropped)} dropped` : null].filter(Boolean).join(" · ");
    case "paused":
      return `Paused · ${formatCount(live.buffered ?? 0)} buffered`;
    case "ended":
      return `Ended: ${live.reason ?? "stopped"}`;
  }
}

/** The Live badge of a live view. */
export function LiveBadge({ live, unit }: { live: LiveState; unit?: string }) {
  const variant = live.status === "live" ? "success" : live.status === "paused" ? "warning" : "neutral";
  return (
    <Badge appearance="tint" variant={variant} role="status" aria-live="polite">
      {liveText(live, unit)}
    </Badge>
  );
}
