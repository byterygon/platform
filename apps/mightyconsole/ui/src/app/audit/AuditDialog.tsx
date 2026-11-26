// The audit log (DOC-25 §3.5, TSK-135 §6): who did what, newest first, for people who hold
// `audit.read`. Filters (who, tool, risk, outcome, period, sensitive reads) go to the server with
// the first page and each "Load more"; a row opens its entry with the digests and hashes (never a
// value); the chain check runs on the server when asked; the filtered view exports as CSV by
// paging `audit.list`. Reading the log is itself recorded (`audit.list`, `audit.get`).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { SearchInput } from "@/components/ui/search-input";
import { Select, SelectItem } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import type { AuditRecordView, AuditRow, AuditStatusOutput, AuditVerifyOutput } from "@/gen/api";
import { ArrowClockwise, ArrowExport, Eye, Shield } from "@/lib/icons";
import type { MightyClient } from "../client";
import { describeError } from "../messages";
import { Failure, useLoad } from "../admin/parts";
import { EXPORT_LIMIT, type Filters, NO_FILTERS, PERIODS, auditTools, durationText, filterOf, isFiltered, outcomeText, riskText, shortHash, statusText, timeText, toCsv, verdict } from "./audit";

/** Hands a text file to the browser; replaced in tests. */
export function saveText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export interface AuditDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  client: MightyClient;
  /** Hands the exported file over; the browser's download by default. */
  save?: (name: string, text: string) => void;
}

const PAGE = 100;

function outcomeBadge(row: Pick<AuditRow, "outcome" | "errorCode">) {
  const text = outcomeText(row.outcome);
  if (row.outcome === "refused") return <Badge variant="warning">{text}</Badge>;
  if (row.outcome === "failed") return <Badge variant="danger">{row.errorCode ? `${text} · ${row.errorCode}` : text}</Badge>;
  return <Badge variant="neutral">{text}</Badge>;
}

export function AuditDialog({ open, onOpenChange, client, save = saveText }: AuditDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="xl">
      <DialogContent data-testid="audit-dialog" className="min-h-panel-lg">
        <DialogHeader>
          <DialogTitle>Audit log</DialogTitle>
          <DialogDescription>Who did what on this server, newest first. Entries hold digests, never the values; reading this log is recorded too.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex min-h-0 flex-1 flex-col">{open ? <AuditLog client={client} save={save} /> : null}</DialogBody>
      </DialogContent>
    </Dialog>
  );
}

function AuditLog({ client, save }: { client: MightyClient; save: (name: string, text: string) => void }) {
  const toast = useToast();
  const tools = useMemo(() => auditTools(), []);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [who, setWho] = useState("");
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: unknown }>({ loading: true, error: null });
  const [selected, setSelected] = useState<number | null>(null);
  const [verify, setVerify] = useState<{ running: boolean; result: AuditVerifyOutput | null; error: unknown }>({ running: false, result: null, error: null });
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0);
  const status = useLoad<AuditStatusOutput>(() => client.audit.status({}), [client]);

  // Typing in "Who" waits for a pause before the server is asked.
  useEffect(() => {
    const id = setTimeout(() => setFilters((f) => (f.who === who ? f : { ...f, who })), 300);
    return () => clearTimeout(id);
  }, [who]);

  const first = useCallback(async () => {
    const mine = ++generation.current;
    setState({ loading: true, error: null });
    try {
      const out = await client.audit.list({ filter: filterOf(filters, Date.now()), cursor: null, limit: PAGE });
      if (mine !== generation.current) return;
      setRows(out.records);
      setNext(out.next);
      setState({ loading: false, error: null });
    } catch (error) {
      if (mine === generation.current) setState({ loading: false, error });
    }
  }, [client, filters]);
  useEffect(() => {
    setSelected(null);
    void first();
  }, [first]);

  const more = async () => {
    if (!next) return;
    const mine = generation.current;
    setState({ loading: true, error: null });
    try {
      const out = await client.audit.list({ filter: filterOf(filters, Date.now()), cursor: next, limit: PAGE });
      if (mine !== generation.current) return;
      setRows((r) => [...r, ...out.records]);
      setNext(out.next);
      setState({ loading: false, error: null });
    } catch (error) {
      if (mine === generation.current) setState({ loading: false, error });
    }
  };

  const runVerify = async () => {
    setVerify({ running: true, result: null, error: null });
    try {
      setVerify({ running: false, result: await client.audit.verify({}), error: null });
      status.reload();
    } catch (error) {
      setVerify({ running: false, result: null, error });
    }
  };

  const exportView = async () => {
    setExporting(true);
    try {
      const all: AuditRow[] = [];
      let cursor: string | null = null;
      const filter = filterOf(filters, Date.now());
      let capped = false;
      do {
        const out: Awaited<ReturnType<typeof client.audit.list>> = await client.audit.list({ filter, cursor, limit: 500 });
        all.push(...out.records);
        cursor = out.next;
        if (all.length >= EXPORT_LIMIT) {
          capped = cursor !== null;
          break;
        }
      } while (cursor);
      save(`audit-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.csv`, toCsv(all));
      toast.add({ title: `Exported ${all.length.toLocaleString("en-GB")} entries`, ...(capped ? { description: `Stopped at ${EXPORT_LIMIT.toLocaleString("en-GB")}: narrow the filters for the rest.` } : {}), type: capped ? "warning" : "success" });
    } catch (error) {
      toast.add({ title: "Export failed", description: describeError(error).title, type: "danger" });
    } finally {
      setExporting(false);
    }
  };

  const set = <K extends keyof Filters>(key: K, value: Filters[K]) => setFilters((f) => ({ ...f, [key]: value }));
  const verdictOf = verify.result ? verdict(verify.result) : null;
  const row = rows.find((r) => r.seq === selected) ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-md" data-testid="audit-log">
      <div className="flex flex-wrap items-center gap-inline-md">
        <SearchInput aria-label="Who" placeholder="Who (name or id)" value={who} onValueChange={setWho} className="w-panel-xs" />
        <Select aria-label="Tool" value={filters.tool} onValueChange={(v) => set("tool", v ?? "any")} className="w-panel-xxs">
          <SelectItem value="any">Tool: any</SelectItem>
          {tools.map((t) => (
            <SelectItem key={t} value={t}>
              Tool: {t}
            </SelectItem>
          ))}
        </Select>
        <Select aria-label="Risk" value={filters.risk} onValueChange={(v) => set("risk", (v as Filters["risk"]) ?? "any")} className="w-panel-xxs">
          <SelectItem value="any">Risk: any</SelectItem>
          <SelectItem value="Read">Risk: read</SelectItem>
          <SelectItem value="Write">Risk: write</SelectItem>
          <SelectItem value="Destructive">Risk: destroy</SelectItem>
        </Select>
        <Select aria-label="Outcome" value={filters.outcome} onValueChange={(v) => set("outcome", (v as Filters["outcome"]) ?? "any")} className="w-panel-xxs">
          <SelectItem value="any">Outcome: any</SelectItem>
          <SelectItem value="allowed">Outcome: allowed</SelectItem>
          <SelectItem value="refused">Outcome: refused</SelectItem>
          <SelectItem value="failed">Outcome: failed</SelectItem>
        </Select>
        <Select aria-label="Period" value={filters.period} onValueChange={(v) => set("period", (v as Filters["period"]) ?? "week")} className="w-panel-xxs">
          {PERIODS.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </Select>
        <label className="flex items-center gap-inline-sm text-body-1">
          <Checkbox checked={filters.sensitiveOnly} onCheckedChange={(on) => set("sensitiveOnly", on === true)} aria-label="Sensitive reads only" />
          Sensitive reads only
        </label>
        <span className="flex-1" />
        {isFiltered(filters) || who ? (
          <Button
            appearance="subtle"
            onClick={() => {
              setWho("");
              setFilters(NO_FILTERS);
            }}
          >
            Clear filters
          </Button>
        ) : null}
        <Button onClick={() => void first()} loading={state.loading && rows.length === 0}>
          <Icon icon={ArrowClockwise} /> Refresh
        </Button>
        <Button onClick={() => void exportView()} loading={exporting} aria-label="Export this view as CSV">
          <Icon icon={ArrowExport} /> Export
        </Button>
      </div>

      <section aria-label="Chain" className="flex flex-col gap-stack-sm" data-testid="audit-chain">
        <div className="flex flex-wrap items-center gap-inline-md">
          <Icon icon={Shield} />
          <span className="text-caption-1 text-fg-muted" data-testid="audit-status">
            {status.data ? statusText(status.data) : status.error ? "The log's status could not be read." : "Reading the log's status…"}
          </span>
          <span className="flex-1" />
          <Button size="small" onClick={() => void runVerify()} loading={verify.running}>
            Verify chain
          </Button>
        </div>
        {status.data?.refusing ? (
          <Alert intent="danger">
            <AlertTitle>The log refuses writes</AlertTitle>
            <AlertDescription>{status.data.refusing}</AlertDescription>
          </Alert>
        ) : null}
        {verify.error ? <Failure error={verify.error} /> : null}
        {verdictOf && verify.result ? (
          <Alert intent={verdictOf.tone} data-testid="audit-verdict">
            <AlertTitle>{verdictOf.title}</AlertTitle>
            <AlertDescription>
              {verdictOf.detail} Checked {timeText(verify.result.checkedMs)}.
            </AlertDescription>
          </Alert>
        ) : null}
      </section>

      {state.error ? <Failure error={state.error} onRetry={() => void first()} /> : null}
      <div className="flex min-h-0 flex-1 gap-inline-lg overflow-hidden">
        <div className="min-h-0 w-3/5 shrink-0 overflow-auto">
          {state.loading && rows.length === 0 ? (
            <div aria-busy="true" aria-label="Loading the log" className="flex flex-col gap-stack-sm p-inset-sm">
              <Skeleton variant="text" />
              <Skeleton variant="text" />
              <Skeleton variant="text" />
            </div>
          ) : (
            <Table aria-label="Audit entries">
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Who</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Outcome</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.seq} selected={r.seq === selected} data-seq={r.seq}>
                    <TableCell>
                      <button type="button" onClick={() => setSelected(r.seq)} aria-label={`Entry ${r.seq}, ${r.action}`} className="text-start text-caption-1 outline-none focus-visible:underline">
                        {timeText(r.timeMs)}
                      </button>
                    </TableCell>
                    <TableCell className="max-w-panel-xxs truncate">{r.user}</TableCell>
                    <TableCell>
                      <span className="flex items-center gap-inline-xs">
                        <span className="font-mono text-caption-1">{r.action}</span>
                        {r.sensitive ? (
                          <span title="A sensitive read: the log keeps it" className="text-fg-muted">
                            <Icon icon={Eye} label="Sensitive read" />
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell>{riskText(r.risk)}</TableCell>
                    <TableCell>{outcomeBadge(r)}</TableCell>
                  </TableRow>
                ))}
                {rows.length === 0 && !state.loading ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-fg-muted">
                      No entry matches{isFiltered(filters) || who ? ": try wider filters" : ""}.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          )}
          <div className="flex items-center gap-inline-md px-inset-sm py-stack-sm">
            <span className="text-caption-1 text-fg-muted" data-testid="audit-count">
              {rows.length.toLocaleString("en-GB")} {rows.length === 1 ? "entry" : "entries"} shown{next ? ", more below" : rows.length > 0 ? ": the oldest is reached" : ""}
            </span>
            {next ? (
              <Button size="small" onClick={() => void more()} loading={state.loading}>
                Load more
              </Button>
            ) : null}
          </div>
        </div>
        <section aria-label="Entry" className="min-h-0 min-w-0 flex-1 overflow-auto border-s border-border-subtle ps-inset-lg" data-testid="audit-detail">
          {row === null ? <p className="text-body-1 text-fg-muted">Pick an entry to see who, what it touched and its hashes.</p> : <EntryDetail client={client} row={row} />}
        </section>
      </div>
    </div>
  );
}

function EntryDetail({ client, row }: { client: MightyClient; row: AuditRow }) {
  const entry = useLoad<AuditRecordView>(() => client.audit.get({ seq: row.seq }), [client, row.seq]);
  const view = entry.data;
  return (
    <div className="flex flex-col gap-stack-md">
      <div className="flex flex-col gap-stack-xs">
        <h3 className="break-all font-mono text-subtitle-2">{row.action}</h3>
        <span className="text-caption-1 text-fg-muted">
          Entry {row.seq} · {timeText(row.timeMs)}
          {row.durationMs !== null ? ` · took ${durationText(row.durationMs)}` : ""}
        </span>
        <div className="flex flex-wrap gap-inline-sm">
          {outcomeBadge(row)}
          <Badge variant={row.risk === "Destructive" ? "danger" : "neutral"}>{riskText(row.risk)}</Badge>
          {row.sensitive ? <Badge variant="info">Sensitive read</Badge> : null}
        </div>
      </div>
      {entry.error ? <Failure error={entry.error} onRetry={entry.reload} /> : null}
      {entry.loading && !view ? <Skeleton variant="text" /> : null}
      {view ? (
        <>
          <DescriptionList divided layout="stacked" aria-label="Entry facts">
            <Fact term="Who">
              {view.principals.length === 0
                ? row.user
                : view.principals.map((p) => (
                    <span key={`${p.kind}|${p.id}|${p.session}`} className="block break-all">
                      {p.id} <span className="text-fg-muted">({p.kind}{p.session ? `, session ${p.session}` : ""})</span>
                    </span>
                  ))}
            </Fact>
            <Fact term="Permission">
              <span className="font-mono">{row.perm}</span>
            </Fact>
            {row.target ? <Fact term="Target">{row.target}</Fact> : null}
            {view.reason ? <Fact term="Why it was refused">{view.reason}</Fact> : null}
            {view.approvalId ? <Fact term="Approval">{view.approvalId}</Fact> : null}
            {view.delivery ? <Fact term="Delivered">{view.delivery}</Fact> : null}
            {view.detail.map((d) => (
              <Fact key={d.key} term={d.key}>
                {d.value}
              </Fact>
            ))}
            <Fact term="Call">
              <span className="break-all font-mono text-caption-1">{row.correlationId}</span>
            </Fact>
          </DescriptionList>
          <section aria-label="Digests" className="flex flex-col gap-stack-sm">
            <h4 className="text-body-1-strong">Digests and chain</h4>
            <p className="text-caption-1 text-fg-muted">The log keeps a digest of the input, never the input. Each entry's hash covers the one before it.</p>
            <DescriptionList divided layout="stacked" aria-label="Digests">
              <Fact term="Input digest">
                <span className="break-all font-mono text-caption-1">{view.inputDigest}</span>
              </Fact>
              {view.statementDigest ? (
                <Fact term="Statement digest">
                  <span className="break-all font-mono text-caption-1">{view.statementDigest}</span>
                </Fact>
              ) : null}
              <Fact term="Previous hash">
                <span className="break-all font-mono text-caption-1" title={view.prevHash}>
                  {shortHash(view.prevHash)}
                </span>
              </Fact>
              <Fact term="Hash">
                <span className="break-all font-mono text-caption-1" title={view.hash}>
                  {view.hash}
                </span>
              </Fact>
            </DescriptionList>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Fact({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails>{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

