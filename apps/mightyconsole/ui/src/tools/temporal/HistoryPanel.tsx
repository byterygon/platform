// The History view of a workflow (Mightyconsole spec §9.3, the TSK-91 mockup frame
// `temporal-history`): category chips with counts, Find in events (Ctrl+F), Go to an event (J and
// K step), Table or JSON, Download; a virtual table with the time since the start, an icon per
// category, red failures, workflow tasks folded and each event's pair; the chosen event's detail;
// a footer that says what is loaded and whether new events are followed.
import { useContext, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TableVirtualBody } from "@/components/ui/table";
import { ToggleButton } from "@/components/ui/toggle-button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton, LinkButton, NoticeContext, chipClass, gutterTable } from "@/app/page";
import { EmptyLine } from "@/app/states";
import { formatCount } from "@/app/messages";
import { cn } from "@/lib/cn";
import type { EventCategory, HistoryEvent } from "@/gen/api";
import { ArrowDownload, ArrowImport, ChevronDown, ChevronRight, Clock, Copy, ErrorCircle, CheckmarkCircle, Eye, EyeOff, Flash, Info, Link, NumberSymbol, Pin, Play, Search, SplitVertical, type IconDefinition } from "@/lib/icons";
import { clockText, eventMs } from "./history";
import { HISTORY_CHIPS, categoryCounts, groupSummary, historyJson, historyRows, historySummary, isFailure, pairsOf, sinceStart, summaryContext, type HistoryRow } from "./history-view";

const CATEGORY_ICON: Record<EventCategory, IconDefinition> = { Workflow: Link, WorkflowTask: Link, Activity: Flash, Timer: Clock, ChildWorkflow: SplitVertical, Signal: Play, Update: ArrowImport, Marker: Pin, Other: Info };

/** The icon of an event: a check for a completion, a red circle for a failure, else its category's. */
function EventIcon({ event }: { event: HistoryEvent }) {
  if (isFailure(event)) return <Icon icon={ErrorCircle} className="text-danger-fg" />;
  if (event.eventType.endsWith("Completed") && event.category !== "WorkflowTask") return <Icon icon={CheckmarkCircle} className="text-success-fg" />;
  return <Icon icon={CATEGORY_ICON[event.category]} className="text-fg-muted" />;
}

export interface HistoryPanelProps {
  workflowId: string;
  runId: string;
  events: HistoryEvent[];
  /** The history's length as describe reports it (the events may be loaded in part). */
  total: number;
  /** The run is followed live. */
  live: boolean;
  pending: readonly Record<string, unknown>[];
  selected: number | null;
  onSelect(id: number): void;
  hasMore: boolean;
  onLoadMore(): void;
  onOpenPending(): void;
  /** An event's attributes as stored (`temporal.workflows.rawEvent`), for the Raw form. */
  loadRaw?: ((eventId: number) => Promise<Record<string, unknown>>) | undefined;
}

export function HistoryPanel({ workflowId, runId, events, total, live, pending, selected, onSelect, hasMore, onLoadMore, onOpenPending, loadRaw }: HistoryPanelProps) {
  const notify = useContext(NoticeContext);
  const [category, setCategory] = useState<EventCategory | "All">("All");
  const [query, setQuery] = useState("");
  const [fold, setFold] = useState(true);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [view, setView] = useState<"table" | "json">("table");
  const [goTo, setGoTo] = useState("");
  const scroller = useRef<HTMLDivElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);

  const ctx = useMemo(() => summaryContext(events, pending), [events, pending]);
  const counts = useMemo(() => categoryCounts(events), [events]);
  const pairs = useMemo(() => pairsOf(events), [events]);
  const rows = useMemo(() => historyRows(events, { category, fold, expanded, query, ctx }), [events, category, fold, expanded, query, ctx]);
  const start = events.length > 0 ? eventMs(events[0]!) : 0;
  const byId = useMemo(() => new Map(events.map((e) => [e.eventId, e])), [events]);
  const picked = selected === null ? undefined : byId.get(selected);

  // More pages load as the table nears its end.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !hasMore) return undefined;
    const check = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 400) onLoadMore();
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    return () => el.removeEventListener("scroll", check);
  }, [hasMore, onLoadMore, rows.length, view]);

  /** Selects an event and scrolls its row into view, opening its folded group. */
  const reveal = (id: number) => {
    const event = byId.get(id);
    if (!event) {
      notify({ title: `No event ${id} loaded`, description: hasMore ? "Scroll to load more of the history, then try again." : `The history has ${formatCount(events.length)} events.`, type: "warning" });
      return;
    }
    onSelect(id);
    let index = rows.findIndex((r) => r.kind === "event" && r.event.eventId === id);
    if (index < 0) {
      const group = rows.find((r) => r.kind === "group" && r.first <= id && id <= r.last);
      if (group && group.kind === "group") setExpanded((s) => new Set(s).add(group.first));
      index = rows.findIndex((r) => r.kind === "group" && r.first <= id && id <= r.last) + 1 + (group && group.kind === "group" ? group.events.findIndex((e) => e.eventId === id) : 0);
    }
    const el = scroller.current;
    const row = el?.querySelector<HTMLElement>("tbody tr:not([data-spacer])");
    if (el && row) el.scrollTop = Math.max(index * row.offsetHeight - el.clientHeight / 3, 0);
  };

  /** J and K step through the shown events; Ctrl+F finds. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      findRef.current?.focus();
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable=true]")) return;
    if (e.key !== "j" && e.key !== "k") return;
    const ids = rows.flatMap((r) => (r.kind === "event" ? [r.event.eventId] : []));
    if (ids.length === 0) return;
    const at = selected === null ? -1 : ids.indexOf(selected);
    const next = e.key === "j" ? ids[Math.min(at + 1, ids.length - 1)] : ids[Math.max(at - 1, 0)];
    if (next !== undefined) reveal(next);
    e.preventDefault();
  };

  const download = () => {
    const blob = new Blob([historyJson(events)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workflowId}_${runId}_history.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const renderRow = (row: HistoryRow, i: number) => {
    if (row.kind === "group") {
      const toggle = () =>
        setExpanded((s) => {
          const next = new Set(s);
          if (next.has(row.first)) next.delete(row.first);
          else next.add(row.first);
          return next;
        });
      return (
        <TableRow key={`g${row.first}`} onClick={toggle} aria-expanded={row.open} className="text-caption-1 text-fg-muted [&&>td]:h-control-md">
          <TableCell align="end">
            <Icon icon={row.open ? ChevronDown : ChevronRight} className="size-icon-md" />
          </TableCell>
          <TableCell>
            Events {row.first}–{row.last}
          </TableCell>
          <TableCell />
          <TableCell>
            <span className="flex items-center gap-inline-sm">
              <Icon icon={Link} className="size-icon-md" /> Workflow task
            </span>
          </TableCell>
          <TableCell className="w-full max-w-0">
            <span className="block truncate">{groupSummary(row.events)}</span>
          </TableCell>
          <TableCell />
        </TableRow>
      );
    }
    const e = row.event;
    const pair = pairs.get(e.eventId);
    const failed = isFailure(e);
    return (
      <TableRow key={e.eventId} selected={e.eventId === selected} onClick={() => onSelect(e.eventId)} aria-selected={e.eventId === selected} data-index={i} className={cn(failed && "bg-danger-subtle")}>
        <TableCell align="end">{e.eventId}</TableCell>
        <TableCell className="whitespace-nowrap font-mono text-code">{clockText(eventMs(e), true)}</TableCell>
        <TableCell align="end" className="whitespace-nowrap text-fg-muted">
          {sinceStart(eventMs(e), start)}
        </TableCell>
        <TableCell>
          <span className="flex min-w-0 items-center gap-inline-sm">
            <EventIcon event={e} />
            <span className="whitespace-nowrap">{e.eventType}</span>
          </span>
        </TableCell>
        <TableCell className="w-full max-w-0 text-fg-muted">
          <span className="block truncate">{historySummary(e, ctx)}</span>
        </TableCell>
        <TableCell>
          {pair ? (
            <Button
              size="small"
              appearance="transparent"
              aria-label={`Go to event ${pair.to}`}
              onClick={(ev) => {
                ev.stopPropagation();
                reveal(pair.to);
              }}
            >
              {pair.direction === "next" ? "→" : "←"} {pair.to}
            </Button>
          ) : null}
        </TableCell>
      </TableRow>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div role="toolbar" aria-label="History filter" className="flex shrink-0 flex-wrap items-center gap-inline-md border-b border-border-subtle px-inset-lg py-stack-sm">
        <div role="group" aria-label="Category" className="flex flex-wrap items-center gap-inline-xs">
          {HISTORY_CHIPS.map(({ category: c, label }) => (
            <ToggleButton key={c} size="small" appearance="outline" pressed={category === c} disabled={c !== "All" && counts[c] === 0} onPressedChange={(p) => p && setCategory(c)} className={chipClass}>
              {label} <span className={category === c || (c !== "All" && counts[c] === 0) ? undefined : "text-fg-muted"}>{formatCount(counts[c])}</span>
            </ToggleButton>
          ))}
        </div>
        <div className="ms-auto flex items-center gap-inline-sm">
          <InputGroup size="small" className="w-panel-xs">
            <InputGroupAddon>
              <Icon icon={Search} />
            </InputGroupAddon>
            <InputGroupInput ref={findRef} aria-label="Find in events" placeholder="Find in events" value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
            <InputGroupAddon>
              <Kbd>Ctrl+F</Kbd>
            </InputGroupAddon>
          </InputGroup>
          <InputGroup size="small" className="w-[calc(var(--by-size-panel-xs)/2)]">
            <InputGroupAddon>
              <Icon icon={NumberSymbol} />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Go to event"
              placeholder="Go to"
              inputMode="numeric"
              value={goTo}
              onChange={(e) => setGoTo(e.currentTarget.value.replace(/\D/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && goTo) reveal(Number(goTo));
              }}
            />
          </InputGroup>
          <ToggleGroup aria-label="View" size="small" value={[view]} onValueChange={(v) => v[0] && setView(v[0] as "table" | "json")}>
            <ToggleGroupItem value="table">Table</ToggleGroupItem>
            <ToggleGroupItem value="json">JSON</ToggleGroupItem>
          </ToggleGroup>
          <IconButton size="small" aria-label={hasMore ? `Download the ${formatCount(events.length)} loaded events as JSON` : "Download the history as JSON"} onClick={download}>
            <Icon icon={ArrowDownload} />
          </IconButton>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {view === "json" ? (
          <div className="min-h-0 min-w-0 flex-1 overflow-auto p-inset-md">
            <CodeBlock code={historyJson(rows.flatMap((r) => (r.kind === "group" ? r.events : [r.event])).filter((e, i, all) => all.indexOf(e) === i))} language="json" lineNumbers copyable aria-label="History as JSON" virtualizeAfter={2000} />
          </div>
        ) : rows.length === 0 ? (
          <div className="min-w-0 flex-1">
            <EmptyLine>{query ? `No event matches "${query}".` : "No events of this kind."}</EmptyLine>
          </div>
        ) : (
          <Table ref={scroller} aria-label="History events" className={cn("min-h-0 min-w-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead align="end">ID</TableHead>
                <TableHead>Time</TableHead>
                <TableHead align="end">Since start</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Pair</TableHead>
              </TableRow>
            </TableHeader>
            {rows.length > 200 ? <TableVirtualBody count={rows.length} renderRow={(i) => renderRow(rows[i]!, i)} /> : <TableBody>{rows.map(renderRow)}</TableBody>}
          </Table>
        )}
        <EventDetail event={picked} start={start} ctx={ctx} onSelect={reveal} onOpenPending={onOpenPending} loadRaw={loadRaw} />
      </div>
      <footer className="flex shrink-0 items-center gap-inline-md border-t border-border-subtle px-inset-lg py-stack-sm text-caption-1 text-fg-muted">
        {live ? (
          <span className="flex items-center gap-inline-xs">
            <span aria-hidden="true" className="size-icon-xs rounded-full bg-success" /> Following new events
          </span>
        ) : null}
        <span>
          {formatCount(events.length)} of {formatCount(Math.max(total, events.length))} events loaded{hasMore ? ", more load as you scroll" : ""}
        </span>
        <span className="ms-auto">{fold ? "Workflow tasks folded" : "Every event shown"}</span>
        <Button size="small" appearance="subtle" className="text-caption-1" onClick={() => setFold((f) => !f)}>
          <Icon icon={fold ? Eye : EyeOff} /> {fold ? "Show all" : "Fold workflow tasks"}
        </Button>
      </footer>
    </div>
  );
}

/** The chosen event: its time, its activity's other events and pending attempt, its attributes as JSON, Copy input and Copy event. */
/** "json/plain · 1 payload", "binary/encrypted, json/plain · 3 payloads": the forms of an event's payloads as stored. */
export function payloadLabel(encodings: readonly string[] | undefined): string {
  if (!encodings || encodings.length === 0) return "no payloads";
  const kinds = [...new Set(encodings)].join(", ");
  return `${kinds} · ${encodings.length} payload${encodings.length === 1 ? "" : "s"}`;
}

function EventDetail({ event, start, ctx, onSelect, onOpenPending, loadRaw }: { event: HistoryEvent | undefined; start: number; ctx: ReturnType<typeof summaryContext>; onSelect(id: number): void; onOpenPending(): void; loadRaw?: ((eventId: number) => Promise<Record<string, unknown>>) | undefined }) {
  const notify = useContext(NoticeContext);
  const [form, setForm] = useState<"decoded" | "raw">("decoded");
  // Raw forms already read, by event id (an error is kept as its message).
  const [raws, setRaws] = useState<ReadonlyMap<number, Record<string, unknown> | string>>(() => new Map());
  const eventId = event?.eventId;
  useEffect(() => {
    if (form !== "raw" || eventId === undefined || !loadRaw || raws.has(eventId)) return;
    let live = true;
    loadRaw(eventId).then(
      (attributes) => live && setRaws((m) => new Map(m).set(eventId, attributes)),
      (e: unknown) => live && setRaws((m) => new Map(m).set(eventId, e instanceof Error ? e.message : String(e))),
    );
    return () => {
      live = false;
    };
  }, [form, eventId, loadRaw, raws]);
  if (!event) {
    return (
      <aside aria-label="Event detail" className="flex w-panel-pane max-w-1/2 min-w-0 shrink-0 flex-col border-s border-border-subtle">
        <EmptyLine>Select an event: its attributes, decoded, show here. J and K step through the events.</EmptyLine>
      </aside>
    );
  }
  const t = eventMs(event);
  const a = event.attributes;
  const scheduledId = event.eventType === "ActivityTaskScheduled" ? event.eventId : typeof a["scheduledEventId"] === "number" ? (a["scheduledEventId"] as number) : null;
  const activity = scheduledId === null ? undefined : ctx.activities.get(scheduledId);
  const pending = activity && !ctx.closed.has(scheduledId!) ? ctx.pending.get(activity.activityId) : undefined;
  const input = a["input"];
  const copy = async (value: string, what: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify({ title: `Copied ${what}`, description: value.length > 64 ? `${value.slice(0, 61)}…` : value, type: "success" });
    } catch {
      notify({ title: `Could not copy ${what}`, description: "The browser refused the clipboard. Select the text instead.", type: "warning" });
    }
  };
  const date = new Intl.DateTimeFormat("en-GB", { dateStyle: "medium" }).format(new Date(t));
  return (
    <aside aria-label="Event detail" className="flex w-panel-pane max-w-1/2 min-w-0 shrink-0 flex-col gap-stack-md overflow-auto border-s border-border-subtle px-inset-lg py-inset-md">
      <div className="flex flex-col gap-stack-xs">
        <h3 className="flex items-center gap-inline-md text-body-1-strong text-fg">
          Event {event.eventId} · {event.eventType}
          <CopyButton value={String(event.eventId)} what="event ID" />
        </h3>
        <p className="text-body-1 text-fg-muted">
          {date}, {clockText(t, true)} · {sinceStart(t, start)}
        </p>
      </div>
      {activity ? (
        <div className="flex flex-wrap items-center gap-inline-sm text-caption-1 text-fg">
          <span className="text-fg-muted">Activity {activity.name}:</span>
          {event.eventId !== scheduledId ? (
            <LinkButton className="text-caption-1" onClick={() => onSelect(scheduledId!)}>
              Scheduled {scheduledId}
            </LinkButton>
          ) : (
            <span className="text-fg-muted">scheduled here</span>
          )}
          {pending ? (
            <>
              <span aria-hidden="true">→</span>
              <span>
                Pending, attempt {pending.attempt}
                {pending.maximumAttempts > 0 ? ` of ${pending.maximumAttempts}` : ""}
              </span>
              <LinkButton className="text-caption-1" onClick={onOpenPending}>
                Open Pending
              </LinkButton>
            </>
          ) : null}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-inline-md">
        {loadRaw ? (
          <ToggleGroup aria-label="Payload form" size="small" value={[form]} onValueChange={(v) => v[0] && setForm(v[0] as "decoded" | "raw")}>
            <ToggleGroupItem value="decoded">Decoded</ToggleGroupItem>
            <ToggleGroupItem value="raw">Raw</ToggleGroupItem>
          </ToggleGroup>
        ) : (
          <Badge appearance="tint" variant="neutral">Decoded</Badge>
        )}
        <span className="text-caption-1 text-fg-muted">{payloadLabel(event.encodings)}</span>
      </div>
      {form === "raw" ? (
        typeof raws.get(event.eventId) === "string" ? (
          <p role="alert" className="text-body-1 text-danger-fg">
            Could not read the event as stored: {raws.get(event.eventId) as string}
          </p>
        ) : raws.get(event.eventId) ? (
          <CodeBlock code={JSON.stringify(raws.get(event.eventId), null, 2)} language="json" appearance="inset" aria-label={`Event ${event.eventId} as stored`} className="min-h-0" />
        ) : (
          <p role="status" className="text-body-1 text-fg-muted">
            Reading the event as stored…
          </p>
        )
      ) : (
        <CodeBlock code={JSON.stringify(a, null, 2)} language="json" appearance="inset" aria-label={`Attributes of event ${event.eventId}`} className="min-h-0" />
      )}
      <div className="flex flex-wrap items-center gap-inline-md">
        {input !== undefined ? (
          <Button size="small" appearance="subtle" onClick={() => void copy(JSON.stringify(input, null, 2), "the input")}>
            <Icon icon={Copy} /> Copy input
          </Button>
        ) : null}
        <Button size="small" appearance="subtle" onClick={() => void copy(JSON.stringify(event, null, 2), "the event")}>
          <Icon icon={Copy} /> Copy event
        </Button>
      </div>
    </aside>
  );
}
