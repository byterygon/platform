import { useState } from "react";
import { RelativeTime } from "@/components/relative-time/relative-time";

/** The smallest useful RelativeTime: a moment a few minutes ago. */
export function RelativeTimeMinimal() {
  const [at] = useState(() => Date.now() - 3 * 60_000);
  return <RelativeTime date={at} />;
}

/** A grant's live countdown, the last run in the status line, styles, UTC, a plain one without a tooltip. */
export function RelativeTimeRealistic() {
  const [now] = useState(() => Date.now());
  return (
    <ul className="flex flex-col gap-stack-xs text-body text-fg">
      <li>
        Access expires <RelativeTime date={now + 14 * 60_000 + 20_000} timeZone="UTC" />
      </li>
      <li className="text-caption text-fg-muted">
        Last run <RelativeTime date={now - 42_000} style="narrow" />
      </li>
      <li>
        Created <RelativeTime date={now - 3 * 24 * 3600_000} style="long" />
      </li>
      <li>
        Approved <RelativeTime date={now - 26 * 3600_000} tooltip={false} />
      </li>
    </ul>
  );
}
