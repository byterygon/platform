import { Button } from "@/components/button/button";
import { Icon } from "@/components/icon/icon";
import { IconButton } from "@/components/icon-button/icon-button";
import { ArrowClockwise, ArrowDownload, CheckmarkCircle, Database, ErrorCircle, Info, Play, Search, Settings, Star, Warning } from "@/lib/icons";

/** The smallest useful Icon: decorative beside text, which already says what it means. */
export function IconMinimal() {
  return (
    <span className="inline-flex items-center gap-inline-xs text-body-1 text-fg">
      <Icon icon={Database} />
      orders_db
    </span>
  );
}

/** Icon where it is really used: every size, the tones, regular and filled, inside a button, and named when it stands alone. */
export function IconRealistic() {
  return (
    <div className="flex flex-col gap-stack-md text-fg">
      <div className="flex items-end gap-inline-md">
        <Icon icon={Settings} size="xs" />
        <Icon icon={Settings} size="sm" />
        <Icon icon={Settings} size="md" />
        <Icon icon={Settings} size="lg" />
        <Icon icon={Settings} size="xl" />
        <Icon icon={Star} size="xl" filled tone="accent" label="Starred" />
      </div>
      <div className="flex items-center gap-inline-md">
        <Icon icon={Search} tone="default" />
        <Icon icon={Search} tone="muted" />
        <Icon icon={Search} tone="subtle" />
        <Icon icon={Info} tone="info" label="Information" />
        <Icon icon={CheckmarkCircle} tone="success" label="Succeeded" />
        <Icon icon={Warning} tone="warning" label="Warning" />
        <Icon icon={ErrorCircle} tone="danger" label="Failed" />
      </div>
      <div className="flex items-center gap-inline-sm">
        <Button>
          <Icon icon={Play} filled />
          Run
        </Button>
        <Button variant="secondary">
          <Icon icon={ArrowDownload} />
          Export
        </Button>
        <IconButton aria-label="Refresh">
          <Icon icon={ArrowClockwise} />
        </IconButton>
      </div>
    </div>
  );
}
