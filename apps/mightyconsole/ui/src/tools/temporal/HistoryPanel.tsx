// The History view of a workflow (Mightyconsole spec §9.3, the TSK-91 mockup frame
// `temporal-history`): category chips with counts, Find in events (Ctrl+F), Go to an event (J and
// K step), Table or JSON, Download; a virtual table with the time since the start, an icon per
// category, red failures, workflow tasks folded and each event's pair; the chosen event's detail;
// a footer that says what is loaded and whether new events are followed.
//
// Long histories (TSK-109, §9.6.1): the events are read from a HistoryStore, not copied into React
// state; the rows come from a row model by index (only the drawn ones are built), counts and pairs
// are kept up to date by the store, a filter or a search keeps its matches and adds the newer
// events only, and Download is a stream from the server.
import { useContext, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
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
import { focusRing } from "@/lib/control";
import type { EventCategory, HistoryEvent } from "@/gen/api";
import { ArrowDownload, ArrowImport, ArrowSortDown, ChevronDown, ChevronRight, Clock, Copy, ErrorCircle, CheckmarkCircle, Eye, EyeOff, Flash, Info, Link, NumberSymbol, Pin, Play, Search, SplitVertical, type IconDefinition } from "@/lib/icons";
import { clockText, eventMs } from "./history";
import { HISTORY_CHIPS, flatRows, foldedRows, groupSummary, historyJson, historySummary, isFailure, sinceStart, type HistoryRow, type RowModel, type SummaryContext } from "./history-view";
import { JSON_VIEW_EVENTS, type HistoryStore } from "./history-store";
import { LIMITS, LargeStubCard, largeStubs, withoutPreviews, type LargeStub } from "./LargePayload";
import { formatBytes } from "./NamespacesTab";
import type { HistoryOrder } from "./useWorkflow";

/** The rows as events only, largest first (folds opened). */
export function bySizeRows(rows: readonly HistoryRow[]): HistoryRow[] {
  return rows
    .flatMap((r): HistoryRow[] => (r.kind === "group" ? r.events.map((event) => ({ kind: "event" as const, event })) : [{ kind: "event", event: r.event }]))
    .sort((a, b) => (a.kind === "event" && b.kind === "event" ? b.event.size - a.event.size : 0));
}

/** Rows from a list in no particular order (by size). */
function listRows(events: readonly HistoryEvent[]): RowModel {
  return {
    count: events.length,
    row: (i) => ({ kind: "event", event: events[i]! }),
    find: (id) => {
      const index = events.findIndex((e) => e.eventId === id);
      return index < 0 ? null : { index };
    },
  };
}

/**
 * The events a filter or a search keeps, in time order (TSK-109): made once for a filter, then
 * only the newer events are tested; an older page (the store's generation) makes it anew.
 */
class Matches {
  private key = "";
  private generation = -1;
  private seen = 0;
  events: HistoryEvent[] = [];

  update(store: HistoryStore, key: string, keep: (e: HistoryEvent) => boolean): HistoryEvent[] {
    if (key !== this.key || store.generation !== this.generation) {
      this.key = key;
      this.generation = store.generation;
      this.seen = 0;
      this.events = [];
    }
    for (let i = this.seen; i < store.size; i += 1) {
      const e = store.at(i)!;
      if (keep(e)) this.events.push(e);
    }
    this.seen = store.size;
    return this.events;
  }
}

const CATEGORY_ICON: Record<EventCategory, IconDefinition> = { Workflow: Link, WorkflowTask: Link, Activity: Flash, Timer: Clock, ChildWorkflow: SplitVertical, Signal: Play, Update: ArrowImport, Marker: Pin, Other: Info };

/** The icon of an event: a check for a completion, a red circle for a failure, else its category's. */
export function EventIcon({ event }: { event: HistoryEvent }) {
  if (isFailure(event)) return <Icon icon={ErrorCircle} className="text-danger-fg" />;
  if (event.eventType.endsWith("Completed") && event.category !== "WorkflowTask") return <Icon icon={CheckmarkCircle} className="text-success-fg" />;
  return <Icon icon={CATEGORY_ICON[event.category]} className="text-fg-muted" />;
}

export interface HistoryPanelProps {
  workflowId: string;
  runId: string;
  /** The loaded events (TSK-109). */
  store: HistoryStore;
  /** The history's length as describe reports it (the events may be loaded in part). */
  total: number;
  /** When the run started, for "since start" while its first event is not loaded. */
  startMs?: number | undefined;
  /** The run is followed live. */
  live: boolean;
  pending: readonly Record<string, unknown>[];
  selected: number | null;
  onSelect(id: number): void;
  hasMore: boolean;
  /** A page beyond the first is being read. */
  loadingMore?: boolean | undefined;
  onLoadMore(): void;
  /** Reads pages until an event is loaded (Go to an event not loaded yet). */
  loadUntil?: ((eventId: number) => Promise<boolean>) | undefined;
  /** Newest first (the default of the tab) or oldest first; oldest first when absent. */
  order?: HistoryOrder | undefined;
  /** Switches the order (the tab reads the history again from that end). */
  onOrderChange?: ((order: HistoryOrder) => void) | undefined;
  /** Saves the whole history from the server, decoded or as stored (`workflows.downloadHistory`). */
  onDownload?: ((form: "decoded" | "stored") => Promise<void>) | undefined;
  onOpenPending(): void;
  /** An event's attributes as stored (`temporal.workflows.rawEvent`), for the Raw form. */
  loadRaw?: ((eventId: number) => Promise<Record<string, unknown>>) | undefined;
  /** Opens a large payload of an event in its own tab (TSK-92). */
  onOpenPayload?: ((stub: LargeStub, label: string) => void) | undefined;
}

export function HistoryPanel({ workflowId, runId, store, total, startMs, live, pending, selected, onSelect, hasMore, loadingMore = false, onLoadMore, loadUntil, order = "oldest", onOrderChange, onDownload, onOpenPending, loadRaw, onOpenPayload }: HistoryPanelProps) {
  const notify = useContext(NoticeContext);
  const version = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const newestFirst = order === "newest";
  const facts = store.facts;
  const [category, setCategory] = useState<EventCategory | "All">("All");
  const [query, setQuery] = useState("");
  // The search follows the typing a step behind, so typing stays quick over a long history.
  const q = useDeferredValue(query).trim().toLowerCase();
  const [fold, setFold] = useState(true);
  // Sorted by size (TSK-92): the heavy events first, folds opened.
  const [bySize, setBySize] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [view, setView] = useState<"table" | "json">("table");
  const [goTo, setGoTo] = useState("");
  const [downloading, setDownloading] = useState<"decoded" | "stored" | null>(null);
  const scroller = useRef<HTMLDivElement | null>(null);
  const findRef = useRef<HTMLInputElement | null>(null);
  const matches = useRef(new Matches());

  const ctx = useMemo(() => facts.context(pending), [facts, pending]);
  const counts = facts.counts;
  const flat = category !== "All" || q !== "" || !fold || bySize;
  const list = flat ? matches.current.update(store, `${category}\u0000${q}`, (e) => (category === "All" || e.category === category) && (!q || facts.searchText(e, ctx).includes(q))) : null;
  const listLength = list?.length ?? 0;
  const model = useMemo<RowModel>(() => {
    if (list && bySize) return listRows([...list].sort((a, b) => b.size - a.size));
    if (list) return flatRows(list, newestFirst);
    return foldedRows(facts.units, expanded, newestFirst);
    // `list` and the units grow in place: their length and the store's version say when.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list, listLength, bySize, newestFirst, facts, expanded, version]);
  const first = store.first ?? store.at(0);
  const start = store.first ? eventMs(store.first) : (startMs ?? (first ? eventMs(first) : 0));
  const picked = selected === null ? undefined : store.get(selected);

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
  }, [hasMore, onLoadMore, model.count, view]);

  // Newest first, a followed event comes in at the top: with the list scrolled away from the
  // top, the rows in view stay where they are; at the top, the new rows show (TSK-109).
  const seen = useRef({ hi: store.hi, lo: store.lo, count: model.count });
  useLayoutEffect(() => {
    const before = seen.current;
    seen.current = { hi: store.hi, lo: store.lo, count: model.count };
    const el = scroller.current;
    if (!newestFirst || !el || el.scrollTop === 0 || store.lo !== before.lo || store.hi <= before.hi) return;
    const row = el.querySelector<HTMLElement>("tbody tr:not([data-spacer])");
    if (row) el.scrollTop += (model.count - before.count) * row.offsetHeight;
  }, [model, store, newestFirst]);

  // An event to scroll to once its fold is open.
  const revealing = useRef<number | null>(null);
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => {
    const id = revealing.current;
    if (id === null) return;
    const found = model.find(id);
    if (found?.fold !== undefined && !expanded.has(found.fold)) {
      setExpanded((s) => new Set(s).add(found.fold!));
      return;
    }
    revealing.current = null;
    const el = scroller.current;
    const row = el?.querySelector<HTMLElement>("tbody tr:not([data-spacer])");
    if (found && el && row) el.scrollTop = Math.max(found.index * row.offsetHeight - el.clientHeight / 3, 0);
  }, [model, expanded, revealTick]);

  /** Selects an event and scrolls its row into view, opening its folded group; reads pages up to it when it is not loaded yet. */
  const reveal = async (id: number) => {
    if (!store.get(id) && loadUntil && hasMore) await loadUntil(id);
    if (!store.get(id)) {
      notify({ title: `No event ${id}`, description: id > 0 && id <= total ? "Scroll to load more of the history, then try again." : `The history has ${formatCount(Math.max(total, store.size))} events.`, type: "warning" });
      return;
    }
    onSelect(id);
    revealing.current = id;
    setRevealTick((t) => t + 1);
  };

  /** J moves down the list and K up, over the events shown; Ctrl+F finds. */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
      findRef.current?.focus();
      e.preventDefault();
      return;
    }
    const target = e.target as HTMLElement;
    if (target.closest("input, textarea, [contenteditable=true]")) return;
    if (e.key !== "j" && e.key !== "k") return;
    const step = e.key === "j" ? 1 : -1;
    const at = selected === null ? null : model.find(selected);
    for (let i = at ? at.index + step : 0; i >= 0 && i < model.count; i += at ? step : 1) {
      const row = model.row(i);
      if (row.kind === "event") {
        void reveal(row.event.eventId);
        break;
      }
    }
    e.preventDefault();
  };

  const download = async (form: "decoded" | "stored") => {
    if (!onDownload) return;
    setDownloading(form);
    try {
      await onDownload(form);
    } finally {
      setDownloading(null);
    }
  };

  // The JSON view: the events shown, at most JSON_VIEW_EVENTS of them.
  const json = useMemo(() => {
    if (view !== "json") return null;
    const out: HistoryEvent[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < model.count && out.length < JSON_VIEW_EVENTS; i += 1) {
      const row = model.row(i);
      for (const e of row.kind === "group" ? row.events : [row.event]) {
        if (!seen.has(e.eventId) && out.length < JSON_VIEW_EVENTS) {
          seen.add(e.eventId);
          out.push(e);
        }
      }
    }
    return { text: historyJson(out), shown: out.length };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, model, version]);

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
        <TableRow key={`g${row.first}`} onClick={toggle} data-fold={row.open ? "open" : "closed"} className={cn("text-caption-1 [&&>td]:h-control-md", row.open ? "text-fg" : "text-fg-muted")}>
          <TableCell align="end">
            {/* The chevron is the fold's button (aria-expanded belongs on a control, not on a plain table's row); a click anywhere on the row does the same. */}
            <button
              type="button"
              aria-expanded={row.open}
              aria-label={`${row.open ? "Fold" : "Unfold"} events ${row.first}–${row.last}`}
              onClick={(e) => {
                e.stopPropagation();
                toggle();
              }}
              className={cn("inline-flex cursor-default rounded-sm align-middle", focusRing)}
            >
              <Icon icon={row.open ? ChevronDown : ChevronRight} className="size-icon-md" />
            </button>
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
          <TableCell align="end" className="whitespace-nowrap text-fg-muted tabular-nums">
            {formatBytes(row.events.reduce((n, x) => n + x.size, 0))}
          </TableCell>
        </TableRow>
      );
    }
    const e = row.event;
    const pair = facts.pairs.get(e.eventId);
    const failed = isFailure(e);
    return (
      <TableRow
        key={e.eventId}
        selected={e.eventId === selected}
        onClick={() => onSelect(e.eventId)}
        aria-selected={e.eventId === selected}
        data-index={i}
        data-in-fold={row.inFold ? "" : undefined}
        className={cn(failed && "bg-danger-subtle", row.inFold && "[&&>td]:h-control-md")}
      >
        <TableCell align="end">{e.eventId}</TableCell>
        <TableCell className="whitespace-nowrap font-mono text-code">{clockText(eventMs(e), true)}</TableCell>
        <TableCell align="end" className="whitespace-nowrap text-fg-muted">
          {sinceStart(eventMs(e), start)}
        </TableCell>
        <TableCell className={cn(row.inFold && "relative")}>
          {/* An open fold's events sit indented under it, a guide line down from the fold's icon (the mockup's `td.ind`). */}
          {row.inFold ? <span aria-hidden="true" data-slot="fold-guide" className="absolute inset-y-0 start-[calc(var(--by-table-cell-padding-x)+var(--by-size-icon-md)/2)] border-s border-border-strong" /> : null}
          <span className={cn("flex min-w-0 items-center gap-inline-sm", row.inFold && "ps-inline-xl")}>
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
                void reveal(pair.to);
              }}
            >
              {pair.direction === "next" ? "→" : "←"} {pair.to}
            </Button>
          ) : null}
        </TableCell>
        <TableCell align="end" className={cn("whitespace-nowrap tabular-nums", e.size >= LIMITS.payloadWarn ? "text-warning-fg" : "text-fg-muted")}>
          {formatBytes(e.size)}
        </TableCell>
      </TableRow>
    );
  };

  const whole = Math.max(total, store.size);
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
            <InputGroupInput ref={findRef} aria-label="Find in events" placeholder={store.size < whole ? `Find in ${formatCount(store.size)} loaded` : "Find in events"} value={query} onChange={(e) => setQuery(e.currentTarget.value)} />
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
                if (e.key === "Enter" && goTo) void reveal(Number(goTo));
              }}
            />
          </InputGroup>
          {onOrderChange ? (
            <ToggleGroup aria-label="Order" size="small" value={[order]} onValueChange={(v) => v[0] && onOrderChange(v[0] as HistoryOrder)}>
              <ToggleGroupItem value="newest">Newest first</ToggleGroupItem>
              <ToggleGroupItem value="oldest">Oldest first</ToggleGroupItem>
            </ToggleGroup>
          ) : null}
          <ToggleGroup aria-label="View" size="small" value={[view]} onValueChange={(v) => v[0] && setView(v[0] as "table" | "json")}>
            <ToggleGroupItem value="table">Table</ToggleGroupItem>
            <ToggleGroupItem value="json">JSON</ToggleGroupItem>
          </ToggleGroup>
          {onDownload ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<IconButton size="small" aria-label="Download the history" disabled={downloading !== null} />}>
                <Icon icon={ArrowDownload} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void download("decoded")}>Download, payloads decoded (JSON)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void download("stored")}>Download as stored (for replay)</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {view === "json" ? (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-stack-sm overflow-auto p-inset-md">
            {json && json.shown < model.count ? (
              <p className="text-caption-1 text-fg-muted">
                The first {formatCount(json.shown)} events shown; Download has the whole history.
              </p>
            ) : null}
            <CodeBlock code={json?.text ?? ""} language="json" lineNumbers copyable aria-label="History as JSON" virtualizeAfter={2000} />
          </div>
        ) : model.count === 0 ? (
          <div className="min-w-0 flex-1">
            <EmptyLine>{q ? `No event matches "${query.trim()}"${store.size < whole ? ` in the ${formatCount(store.size)} events loaded` : ""}.` : store.size === 0 ? "No history yet." : "No events of this kind."}</EmptyLine>
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
                <TableHead align="end">
                  <button type="button" aria-pressed={bySize} onClick={() => setBySize((b) => !b)} className={cn("inline-flex items-center gap-inline-xs rounded-sm", focusRing)} title={bySize ? "Back to event order" : "Sort by size, largest first"}>
                    Size
                    {bySize ? <Icon icon={ArrowSortDown} size="xs" /> : null}
                  </button>
                </TableHead>
              </TableRow>
            </TableHeader>
            {model.count > 200 ? (
              <TableVirtualBody count={model.count} renderRow={(i) => renderRow(model.row(i), i)} />
            ) : (
              <TableBody>{Array.from({ length: model.count }, (_, i) => renderRow(model.row(i), i))}</TableBody>
            )}
          </Table>
        )}
        <EventDetail event={picked} start={start} ctx={ctx} onSelect={(id) => void reveal(id)} onOpenPending={onOpenPending} loadRaw={loadRaw} onOpenPayload={onOpenPayload} />
      </div>
      <footer className="flex shrink-0 items-center gap-inline-md border-t border-border-subtle px-inset-lg py-stack-sm text-caption-1 text-fg-muted">
        {live ? (
          <span className="flex items-center gap-inline-xs">
            <span aria-hidden="true" className="size-icon-xs rounded-full bg-success" /> Following new events
          </span>
        ) : null}
        <span>
          {formatCount(store.size)} of {formatCount(whole)} events loaded
          {loadingMore ? ", loading more…" : hasMore ? ", more load as you scroll" : ""}
        </span>
        <span className="ms-auto">{fold ? "Workflow tasks folded" : "Every event shown"}</span>
        <Button size="small" appearance="subtle" className="text-caption-1" onClick={() => setFold((f) => !f)}>
          <Icon icon={fold ? Eye : EyeOff} /> {fold ? "Show all" : "Fold workflow tasks"}
        </Button>
      </footer>
    </div>
  );
}

/** An event's attributes cut by the server, too big to send with the rest (DOC-21 §9.6.1): their size and start. */
export function cutOf(attributes: Record<string, unknown>): { bytes: number; preview: string } | null {
  const cut = attributes["$cut"];
  if (typeof cut !== "object" || cut === null) return null;
  const c = cut as { bytes?: unknown; preview?: unknown };
  return { bytes: typeof c.bytes === "number" ? c.bytes : 0, preview: typeof c.preview === "string" ? c.preview : "" };
}

/** The chosen event: its time, its activity's other events and pending attempt, its attributes as JSON, Copy input and Copy event. */
/** "json/plain · 1 payload", "binary/encrypted, json/plain · 3 payloads": the forms of an event's payloads as stored. */
export function payloadLabel(encodings: readonly string[] | undefined): string {
  if (!encodings || encodings.length === 0) return "no payloads";
  const kinds = [...new Set(encodings)].join(", ");
  return `${kinds} · ${encodings.length} payload${encodings.length === 1 ? "" : "s"}`;
}

function EventDetail({ event, start, ctx, onSelect, onOpenPending, loadRaw, onOpenPayload }: { event: HistoryEvent | undefined; start: number; ctx: SummaryContext; onSelect(id: number): void; onOpenPending(): void; loadRaw?: ((eventId: number) => Promise<Record<string, unknown>>) | undefined; onOpenPayload?: ((stub: LargeStub, label: string) => void) | undefined }) {
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
        <>
          {cutOf(a) ? (
            <div role="note" className="flex flex-col gap-stack-xs rounded-md border border-border-subtle bg-layer px-inset-md py-inset-sm text-body-1">
              <p className="text-fg">Too big to send with the rest: {formatBytes(cutOf(a)!.bytes)} of JSON. Raw shows it as stored.</p>
              <p className="text-caption-1 text-fg-muted">The start of it:</p>
            </div>
          ) : null}
          {largeStubs(a).map(({ path, stub }) => (
            <LargeStubCard key={stub.id + path} stub={stub} label={path} onOpen={() => onOpenPayload?.(stub, `Event ${event.eventId} · ${path}`)} />
          ))}
          <CodeBlock code={cutOf(a) ? cutOf(a)!.preview : JSON.stringify(withoutPreviews(a), null, 2)} language="json" wrap={cutOf(a) !== null} appearance="inset" aria-label={`Attributes of event ${event.eventId}`} className="min-h-0" />
        </>
      )}
      <div className="flex flex-wrap items-center gap-inline-md">
        {input !== undefined && largeStubs(input).length === 0 ? (
          <Button size="small" appearance="subtle" onClick={() => void copy(JSON.stringify(input, null, 2), "the input")}>
            <Icon icon={Copy} /> Copy input
          </Button>
        ) : null}
        <Button size="small" appearance="subtle" onClick={() => void copy(JSON.stringify({ ...event, attributes: withoutPreviews(event.attributes) }, null, 2), "the event")}>
          <Icon icon={Copy} /> Copy event
        </Button>
      </div>
    </aside>
  );
}
