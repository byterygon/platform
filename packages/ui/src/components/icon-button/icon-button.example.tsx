import { Icon } from "@/components/icon/icon";
import { IconButton } from "@/components/icon-button/icon-button";
import { ArrowClockwise, Copy, Delete, MoreHorizontal, Play } from "@/lib/icons";

/** The smallest useful IconButton: an icon and the label a screen reader announces. */
export function IconButtonMinimal() {
  return (
    <IconButton aria-label="Copy connection string">
      <Icon icon={Copy} />
    </IconButton>
  );
}

/** A query editor's toolbar: run, refresh while loading, a disabled delete, more actions, in every appearance and size. */
export function IconButtonRealistic() {
  return (
    <div className="flex flex-col gap-stack-sm">
      <div role="toolbar" aria-label="Query" className="flex items-center gap-inline-xs">
        <IconButton appearance="primary" aria-label="Run query">
          <Icon icon={Play} />
        </IconButton>
        <IconButton aria-label="Refresh results" loading>
          <Icon icon={ArrowClockwise} />
        </IconButton>
        <IconButton appearance="danger" aria-label="Delete query" disabled>
          <Icon icon={Delete} />
        </IconButton>
        <IconButton appearance="secondary" aria-label="More actions">
          <Icon icon={MoreHorizontal} />
        </IconButton>
        <IconButton appearance="outline" aria-label="Copy query">
          <Icon icon={Copy} />
        </IconButton>
        <IconButton appearance="transparent" aria-label="Copy result">
          <Icon icon={Copy} />
        </IconButton>
      </div>
      <div className="flex items-center gap-inline-xs">
        <IconButton size="small" aria-label="Copy, small">
          <Icon icon={Copy} />
        </IconButton>
        <IconButton size="medium" aria-label="Copy, medium">
          <Icon icon={Copy} />
        </IconButton>
        <IconButton size="large" aria-label="Copy, large">
          <Icon icon={Copy} />
        </IconButton>
      </div>
    </div>
  );
}
