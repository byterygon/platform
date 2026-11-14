import { Separator } from "@/components/separator/separator";

/** The smallest useful Separator: a rule between two blocks of text. */
export function SeparatorMinimal() {
  return (
    <div className="flex flex-col gap-stack-sm text-body text-fg">
      <p>Connection details</p>
      <Separator />
      <p>Access grant</p>
    </div>
  );
}

/** Separators in a connection summary: sections, a vertical rule between inline facts, and the three weights. */
export function SeparatorRealistic() {
  return (
    <div className="flex max-w-panel-md flex-col gap-stack-sm text-body text-fg">
      <div className="flex flex-col gap-stack-xs">
        <p className="text-body-strong">orders-prod</p>
        <div className="flex h-control-xs items-center gap-inline-md text-caption text-fg-muted">
          <span>PostgreSQL 17</span>
          <Separator orientation="vertical" />
          <span>db.internal:5432</span>
          <Separator orientation="vertical" />
          <span>TLS verified</span>
        </div>
      </div>
      <Separator />
      <p className="text-caption text-fg-muted">Muted, inside a dense list</p>
      <Separator variant="muted" />
      <p className="text-caption text-fg-muted">Strong, between panes</p>
      <Separator variant="strong" />
    </div>
  );
}
