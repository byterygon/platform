// The pane beside the Timeline (Mightyconsole spec §9.3, TSK-100; the mockup frame
// `temporal-timeline`): a click or Enter on a bar, diamond or pin shows here what it stands for,
// with no trip to History. Its kind and state, the times with the waits, the worker, the retry
// policy, the failure with Copy, and its own events, each unfolding to its attributes with the
// payloads decoded. The facts come from `itemDetail` (timeline-detail.ts).
import type { LinkEvent } from "../types";
import { useContext, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import { JsonView } from "@/app/json-view";
import { CopyButton, NoticeContext } from "@/app/page";
import { EmptyLine } from "@/app/states";
import { cn } from "@/lib/cn";
import type { HistoryEvent } from "@/gen/api";
import { ArrowImport, CheckmarkCircle, ChevronDown, ChevronRight, Clock, Copy, ErrorCircle, Flash, Link, List, Pin, Play, SplitVertical, Window, type IconDefinition } from "@/lib/icons";
import { focusRing } from "@/lib/control";
import { clockText, eventMs, type ItemInfo, type ItemStatus, type LaneKind } from "./history";
import { EventIcon, payloadLabel } from "./HistoryPanel";
import { itemDetail } from "./timeline-detail";

/** The Timeline's lane icons, by kind. */
export const KIND_ICON: Record<LaneKind, IconDefinition> = { workflow: Link, workflowTask: List, activity: Flash, timer: Clock, child: SplitVertical, signal: Play, update: ArrowImport, marker: Pin };
const ITEM_BADGE: Record<ItemStatus, "accent" | "success" | "danger" | "warning" | "info" | "neutral"> = { running: "info", success: "success", danger: "danger", warning: "warning", info: "info", neutral: "neutral" };

/** The icon before the title: the outcome when there is one, else the kind's. */
function ItemIcon({ info }: { info: ItemInfo }) {
  if (info.status === "danger") return <Icon icon={ErrorCircle} className="shrink-0 text-danger-fg" />;
  if (info.status === "success" && info.kind !== "workflowTask") return <Icon icon={CheckmarkCircle} className="shrink-0 text-success-fg" />;
  return <Icon icon={KIND_ICON[info.kind]} className="shrink-0 text-fg-muted" />;
}

export interface TimelinePaneProps {
  /** The selected item, or undefined when nothing is selected. */
  info: ItemInfo | undefined;
  /** The loaded events by id (the HistoryStore, TSK-109). */
  events: { get(id: number): HistoryEvent | undefined };
  pending: readonly Record<string, unknown>[];
  now: number;
  /** Opens a child workflow in its own tab. */
  onOpenWorkflow?: ((workflowId: string, runId?: string, event?: LinkEvent) => void) | undefined;
}

/** The pane's content; the Timeline puts it in its `aside`. Keyed by the item, so its folds reset. */
export function TimelinePane({ info, events, pending, now, onOpenWorkflow }: TimelinePaneProps) {
  if (!info) {
    return (
      <div className="px-inset-md py-inset-sm">
        <EmptyLine>Click a bar, a diamond or a pin, or focus it and press Enter: its times, worker, failure and events show here.</EmptyLine>
      </div>
    );
  }
  return <ItemPane key={info.firstEventId} info={info} byId={events} pending={pending} now={now} onOpenWorkflow={onOpenWorkflow} />;
}

function ItemPane({ info, byId, pending, now, onOpenWorkflow }: { info: ItemInfo; byId: { get(id: number): HistoryEvent | undefined }; pending: readonly Record<string, unknown>[]; now: number; onOpenWorkflow?: ((workflowId: string, runId?: string, event?: LinkEvent) => void) | undefined }) {
  const notify = useContext(NoticeContext);
  const detail = itemDetail(info, byId, pending, now);
  // The first event starts open, as the mockup draws it; the others unfold on a click.
  const [open, setOpen] = useState<ReadonlySet<number>>(() => new Set(detail.events.slice(0, 1).map((e) => e.eventId)));
  const toggle = (id: number) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const copyFailure = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ title: "Copied the failure", description: value.length > 64 ? `${value.slice(0, 61)}…` : value, type: "success" });
    } catch {
      notify({ title: "Could not copy the failure", description: "The browser refused the clipboard. Select the text instead.", type: "warning" });
    }
  };
  const workflow = detail.workflow;

  return (
    <div className="flex flex-col gap-stack-md px-inset-lg py-inset-md">
      <div className="flex flex-col gap-stack-xs">
        <h3 className="flex min-w-0 flex-wrap items-center gap-inline-sm text-body-1-strong text-fg">
          <ItemIcon info={info} />
          <span className="min-w-0 break-all">{detail.title}</span>
          {detail.copy ? <CopyButton value={detail.copy.value} what={detail.copy.what} /> : null}
          <Badge appearance="tint" variant={ITEM_BADGE[info.status]}>
            {info.state}
          </Badge>
        </h3>
        {detail.context.length > 0 ? <p className="text-body-1 text-fg-muted">{detail.context.join(" · ")}</p> : null}
      </div>
      {workflow && onOpenWorkflow ? (
        <Button size="small" appearance="secondary" className="self-start" onClick={(e) => onOpenWorkflow(workflow.workflowId, workflow.runId, e)} onAuxClick={(e) => e.button === 1 && onOpenWorkflow(workflow.workflowId, workflow.runId, e)}>
          <Icon icon={Window} /> Open {workflow.workflowId}
        </Button>
      ) : null}
      <DescriptionList layout="aligned" aria-label="Facts">
        {detail.facts.map((f) => (
          <DescriptionListItem key={f.label}>
            <DescriptionListTerm>{f.label}</DescriptionListTerm>
            <DescriptionListDetails className="flex min-w-0 items-center gap-inline-xs">
              <span className={cn("min-w-0 break-all", f.mono && "font-mono text-code")}>{f.value}</span>
              {f.copy ? <CopyButton value={f.copy.value} what={f.copy.what} /> : null}
            </DescriptionListDetails>
          </DescriptionListItem>
        ))}
      </DescriptionList>
      {detail.failure ? (
        <section aria-label="Failure" className="flex flex-col gap-stack-sm">
          <div className="flex items-center justify-between gap-inline-md">
            <h4 className="text-body-1-strong text-fg">Failure</h4>
            <Button size="small" appearance="subtle" onClick={() => void copyFailure(detail.failure!.text)}>
              <Icon icon={Copy} /> Copy
            </Button>
          </div>
          <CodeBlock code={detail.failure.text} language="text" wrap appearance="inset" aria-label="Failure chain" />
        </section>
      ) : null}
      <section aria-label="Events" className="flex flex-col gap-stack-sm">
        <h4 className="flex items-center gap-inline-sm text-body-1-strong text-fg">
          Events <span className="text-body-1 text-fg-muted">{detail.events.length}</span>
        </h4>
        <ul className="flex flex-col rounded-md border border-border-subtle">
          {detail.events.map((e) => {
            const isOpen = open.has(e.eventId);
            return (
              <li key={e.eventId} className="flex flex-col border-b border-border-subtle last:border-b-0">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggle(e.eventId)}
                  className={cn("flex h-control-md w-full min-w-0 cursor-default items-center gap-inline-sm rounded-md px-inline-sm text-start text-body-1 text-fg hover:bg-hover", focusRing)}
                >
                  <Icon icon={isOpen ? ChevronDown : ChevronRight} className="size-icon-md shrink-0 text-fg-muted" />
                  <span className="font-mono text-code text-fg-muted">{e.eventId}</span>
                  <EventIcon event={e} />
                  <span className="min-w-0 flex-1 truncate">{e.eventType}</span>
                  <span className="shrink-0 font-mono text-code text-fg-muted">{clockText(eventMs(e), true)}</span>
                </button>
                {isOpen ? (
                  <div className="flex flex-col gap-stack-xs ps-inline-xl pe-inline-sm pb-stack-sm">
                    <span className="text-caption-1 text-fg-muted">{payloadLabel(e.encodings)}</span>
                    <JsonView modeKey="temporal.event.attributes" value={e.attributes} defaultExpandDepth={2} aria-label={`Attributes of event ${e.eventId}`} />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
