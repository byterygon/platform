// A thread's State (spec §11.2) and the Edit state sheet (DOC-21 §11.2.1, the TSK-91 mockup's
// langgraph-edit-state, TSK-96): as node, the checkpoint to start from (an older one forks), the
// values in Monaco with the state schema, "What changes" before it is sent; Update state, or
// Update and continue the run.
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { JsonViewer } from "@/components/ui/json-viewer";
import { RelativeTime } from "@/components/ui/relative-time";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/components/ui/toast";
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton, PageBar } from "@/app/page";
import { PayloadView } from "../temporal/LargePayload";
import { ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { ArrowClockwise, ChevronDown, ChevronRight, Edit, Save } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { CutValue, cutOf, loadCut } from "./cut-value";
import { DiffView } from "./diff-view";
import { appendKeys, stepNodes, stepOf, updatePreview } from "./state-diff";
import { JsonField, parseJson, partialSchema, preview, shortId, useLoad } from "./shared";

interface PanelProps extends TabProps {
  threadId: string;
}

/** Where a state's values were left out for their size (TSK-108): a note with Load, in place of the value. */
export function StateDetails({ state, connId, threadId, client, note }: { state: api.ThreadState; threadId: string } & Pick<TabProps, "connId" | "client" | "note">) {
  const meta = (state.metadata ?? {}) as Record<string, unknown>;
  const source = { connId: connId ?? "", threadId, checkpointId: state.checkpointId ?? null };
  const cutValue = (label: string, cut: api.ValueCut, className?: string) => <CutValue key={cut.field} label={label} cut={cut} note={note} className={className} load={() => loadCut(client, source, cut)} />;
  const valuesCut = cutOf(state.cuts, "values");
  const metadataCut = cutOf(state.cuts, "metadata");
  const otherCuts = state.cuts.filter((c) => c.field !== "values" && c.field !== "metadata");
  return (
    <div className="flex flex-col gap-stack-md">
      <DescriptionList>
        <DescriptionListItem>
          <DescriptionListTerm>Checkpoint</DescriptionListTerm>
          <DescriptionListDetails className="font-mono text-code">{state.checkpointId ?? "—"}</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Parent</DescriptionListTerm>
          <DescriptionListDetails className="font-mono text-code">{state.parentCheckpointId ?? "—"}</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Next</DescriptionListTerm>
          <DescriptionListDetails>{state.next.length > 0 ? state.next.join(", ") : "nothing (the graph ended)"}</DescriptionListDetails>
        </DescriptionListItem>
        <DescriptionListItem>
          <DescriptionListTerm>Step, source</DescriptionListTerm>
          <DescriptionListDetails>
            {String(meta["step"] ?? "—")}, {String(meta["source"] ?? "—")}
          </DescriptionListDetails>
        </DescriptionListItem>
        {state.createdAt ? (
          <DescriptionListItem>
            <DescriptionListTerm>Created</DescriptionListTerm>
            <DescriptionListDetails>
              <RelativeTime date={state.createdAt} />
            </DescriptionListDetails>
          </DescriptionListItem>
        ) : null}
      </DescriptionList>
      {state.tasks.length > 0 ? (
        <section className="flex flex-col gap-stack-xs">
          <h3 className="text-subtitle-2 text-fg">Tasks</h3>
          <ul className="flex flex-col gap-stack-xs">
            {state.tasks.map((t) => (
              <li key={t.id} className="flex flex-wrap items-center gap-inline-sm text-body-1 text-fg">
                <Badge appearance="tint" variant="neutral">
                  {t.name}
                </Badge>
                {t.error ? <span className="text-danger-fg">{t.error}</span> : null}
                {t.interrupts.map((i, n) => (
                  <span key={i.id ?? n} className="font-mono text-code text-warning-fg">
                    interrupt {preview(i.value)}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <h3 className="text-subtitle-2 text-fg">Values</h3>
      {valuesCut ? cutValue("Values", valuesCut, "h-panel-sm") : <JsonViewer value={state.values} aria-label="Values" defaultExpandDepth={2} className="h-panel-sm" />}
      <h3 className="text-subtitle-2 text-fg">Metadata</h3>
      {metadataCut ? cutValue("Metadata", metadataCut, "h-panel-xs") : <JsonViewer value={state.metadata} aria-label="Metadata" className="h-panel-xs" />}
      {otherCuts.length > 0 ? (
        <section className="flex flex-col gap-stack-xs">
          <h3 className="text-subtitle-2 text-fg">Also left out</h3>
          {otherCuts.map((c) => cutValue(c.field, c, "h-panel-xs"))}
        </section>
      ) : null}
    </div>
  );
}

/** The current state (DOC-21 §11.2.1, the mockup's langgraph-thread-state): its values as the large-state tree or JSON, its tasks and checkpoint beside. */
export function StatePanel({ threadId, connId, client, note, version, onEdit, onResume }: PanelProps & { version: number; onEdit: () => void; onResume: () => void }) {
  const state = useLoad(connId ? () => client.langgraph.threads.state({ connId, threadId, checkpointId: null, subgraphs: true }) : null, [connId, threadId, version], note);
  const [as, setAs] = useState<"tree" | "json">("tree");
  const s = state.data;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="State" className="pb-stack-sm">
        {s?.checkpointId ? (
          <span className="flex items-center gap-inline-xs text-body-1 text-fg-muted">
            At checkpoint <span className="font-mono text-fg">{shortId(s.checkpointId)}</span> <CopyButton value={s.checkpointId} what="checkpoint ID" />
          </span>
        ) : null}
        {s ? (
          <span className="flex flex-wrap items-center gap-inline-xs text-body-1 text-fg-muted">
            Next
            {s.next.length > 0
              ? s.next.map((n) => (
                  <Badge key={n} appearance="tint" variant={s.interrupts.length > 0 ? "warning" : "neutral"}>
                    {n}
                  </Badge>
                ))
              : " nothing (the graph ended)"}
          </span>
        ) : null}
        <span className="flex-1" />
        <ToggleGroup aria-label="Show the values as" size="small" value={[as]} onValueChange={(v) => v[0] && setAs(v[0] as typeof as)}>
          <ToggleGroupItem value="tree">Tree</ToggleGroupItem>
          <ToggleGroupItem value="json">JSON</ToggleGroupItem>
        </ToggleGroup>
        <Button appearance="subtle" loading={state.loading} onClick={() => void state.reload()}>
          <Icon icon={ArrowClockwise} /> Refresh
        </Button>
        <Button disabled={!s} onClick={onEdit}>
          <Icon icon={Edit} /> Edit state
        </Button>
      </PageBar>
      {state.error ? <ErrorState error={state.error} onRetry={() => void state.reload()} onRefresh={() => void state.reload()} /> : null}
      {state.loading && !s ? <LoadingRows label="Loading the state" /> : null}
      {s ? (
        <Resizable orientation="horizontal" className="min-h-0 flex-1 border-t border-border-subtle">
          <ResizablePanel defaultSize={68} minSize={40}>
            <div className="flex h-full min-h-0 flex-col overflow-auto px-inset-lg py-inset-md">
              {as === "tree" ? <ValuesTree state={s} threadId={threadId} connId={connId} client={client} note={note} /> : cutOf(s.cuts, "values") ? <CutValue label="Values" cut={cutOf(s.cuts, "values")!} note={note} load={() => loadCut(client, { connId: connId ?? "", threadId, checkpointId: s.checkpointId ?? null }, cutOf(s.cuts, "values")!)} className="h-panel-md" /> : <JsonViewer value={s.values} aria-label="Values" defaultExpandDepth={2} className="min-h-0 flex-1" />}
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel minSize={22}>
            <div className="h-full overflow-auto px-inset-lg py-inset-md">
              <StateSide state={s} onResume={onResume} />
            </div>
          </ResizablePanel>
        </Resizable>
      ) : null}
    </div>
  );
}

/** The values as Temporal's large-payload tree, read node by node from the server (`langgraph.values`). */
function ValuesTree({ state, threadId, connId, client, note }: { state: api.ThreadState; threadId: string } & Pick<TabProps, "connId" | "client" | "note">) {
  const checkpointId = state.checkpointId ?? null;
  const stub = useLoad(connId ? () => client.langgraph.values.open({ connId, threadId, checkpointId, runId: null, field: "values" }) : null, [connId, threadId, checkpointId], note);
  if (stub.error) return <ErrorState error={stub.error} onRetry={() => void stub.reload()} />;
  if (!stub.data || !connId) return <LoadingRows label="Reading the values" />;
  return <PayloadView client={client} connId={connId} stub={stub.data} label="Values" fileName={`thread-${shortId(threadId)}-values`} note={note} onReload={() => void stub.reload()} calls={client.langgraph.values} />;
}

/** Beside the values: what runs next with its interrupts and errors, and the checkpoint. */
function StateSide({ state, onResume }: { state: api.ThreadState; onResume: () => void }) {
  const meta = (state.metadata ?? {}) as Record<string, unknown>;
  const writes = meta["writes"] && typeof meta["writes"] === "object" ? Object.keys(meta["writes"] as object) : [];
  return (
    <div className="flex flex-col gap-stack-lg">
      <section aria-label="Tasks" className="flex flex-col gap-stack-sm">
        <div>
          <h3 className="text-body-1-strong text-fg">Tasks</h3>
          <p className="text-body-1 text-fg-muted">What runs next</p>
        </div>
        {state.tasks.length === 0 && state.interrupts.length === 0 ? <p className="text-body-1 text-fg-muted">{state.next.length > 0 ? `${state.next.join(", ")} next.` : "Nothing: the graph ended here."}</p> : null}
        {/* Interrupts the server gives on the state rather than on a task. */}
        {state.interrupts.length > 0 && !state.tasks.some((t) => t.interrupts.length > 0) ? (
          <Alert intent="warning">
            <AlertTitle>{state.next.length > 0 ? `${state.next.join(", ")} is interrupted` : "Interrupted"}</AlertTitle>
            <AlertDescription>
              <pre className="font-mono text-code whitespace-pre-wrap text-fg">{state.interrupts.map((i) => JSON.stringify(i.value)).join("\n")}</pre>
            </AlertDescription>
            <AlertActions>
              <Button size="small" onClick={onResume}>
                Resume…
              </Button>
            </AlertActions>
          </Alert>
        ) : null}
        {state.tasks.map((t) =>
          t.interrupts.length > 0 ? (
            <Alert key={t.id} intent="warning">
              <AlertTitle>
                {t.name} is interrupted
              </AlertTitle>
              <AlertDescription>
                <pre className="font-mono text-code whitespace-pre-wrap text-fg">{t.interrupts.map((i) => JSON.stringify(i.value)).join("\n")}</pre>
              </AlertDescription>
              <AlertActions>
                <Button size="small" onClick={onResume}>
                  Resume…
                </Button>
              </AlertActions>
            </Alert>
          ) : t.error ? (
            <Alert key={t.id} intent="danger">
              <AlertTitle>{t.name} failed</AlertTitle>
              <AlertDescription>{t.error}</AlertDescription>
            </Alert>
          ) : (
            <p key={t.id} className="flex items-center gap-inline-sm text-body-1 text-fg">
              <Badge appearance="tint" variant="neutral">
                {t.name}
              </Badge>
              waits to run
            </p>
          ),
        )}
      </section>
      <section aria-label="Checkpoint" className="flex flex-col gap-stack-sm">
        <h3 className="text-body-1-strong text-fg">Checkpoint</h3>
        <DescriptionList>
          <DescriptionListItem>
            <DescriptionListTerm>ID</DescriptionListTerm>
            <DescriptionListDetails className="flex items-center gap-inline-xs font-mono text-code">
              {state.checkpointId ? shortId(state.checkpointId) : "—"}
              {state.checkpointId ? <CopyButton value={state.checkpointId} what="checkpoint ID" /> : null}
            </DescriptionListDetails>
          </DescriptionListItem>
          <DescriptionListItem>
            <DescriptionListTerm>Parent</DescriptionListTerm>
            <DescriptionListDetails className="font-mono text-code">{state.parentCheckpointId ? shortId(state.parentCheckpointId) : "—"}</DescriptionListDetails>
          </DescriptionListItem>
          <DescriptionListItem>
            <DescriptionListTerm>Step</DescriptionListTerm>
            <DescriptionListDetails>
              {String(meta["step"] ?? "—")} · source {String(meta["source"] ?? "—")}
            </DescriptionListDetails>
          </DescriptionListItem>
          {writes.length > 0 ? (
            <DescriptionListItem>
              <DescriptionListTerm>Writes</DescriptionListTerm>
              <DescriptionListDetails className="font-mono text-code">{writes.join(", ")}</DescriptionListDetails>
            </DescriptionListItem>
          ) : null}
          {state.createdAt ? (
            <DescriptionListItem>
              <DescriptionListTerm>Created</DescriptionListTerm>
              <DescriptionListDetails>
                <RelativeTime date={state.createdAt} />
              </DescriptionListDetails>
            </DescriptionListItem>
          ) : null}
        </DescriptionList>
      </section>
    </div>
  );
}

// ---- Edit state -------------------------------------------------------------------------------

export interface EditStateSheetProps extends Pick<TabProps, "connId" | "client" | "note"> {
  /** The checkpoint to start from: null for the latest. */
  at: { checkpointId: string | null } | null;
  onClose: () => void;
  threadId: string;
  /** The checkpoints loaded (History's first page), newest first, for the Checkpoint menu. */
  checkpoints: readonly api.ThreadState[];
  /** The graph's own nodes, for As node. */
  nodes: readonly string[];
  stateSchema: unknown;
  /** After the write: the new checkpoint, and whether to run on from it. */
  onSaved: (checkpointId: string | null, continueRun: boolean) => void;
}

const LATEST = "latest";

export function EditStateSheet({ at, onClose, threadId, connId, client, note, checkpoints, nodes, stateSchema, onSaved }: EditStateSheetProps) {
  const toast = useToast();
  const open = at !== null;
  const latestId = checkpoints[0]?.checkpointId ?? null;
  const [checkpoint, setCheckpoint] = useState<string>(LATEST);
  const [asNode, setAsNode] = useState<string | null>(null);
  const [text, setText] = useState("{}");
  const [showChanges, setShowChanges] = useState(true);
  const [busy, setBusy] = useState<"save" | "continue" | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const chosenId = checkpoint === LATEST ? latestId : checkpoint;
  // The values the update is written on: from the loaded page, else read.
  const loaded = checkpoints.find((s) => s.checkpointId === chosenId);
  const read = useLoad(open && connId && !loaded ? () => client.langgraph.threads.state({ connId, threadId, checkpointId: checkpoint === LATEST ? null : checkpoint, subgraphs: null }) : null, [open, connId, threadId, checkpoint, Boolean(loaded)], note);
  const base = loaded ?? read.data ?? null;
  useEffect(() => {
    if (!open) return;
    setCheckpoint(at.checkpointId && at.checkpointId !== latestId ? at.checkpointId : LATEST);
    setText("{}");
    setError(null);
    // By default the update counts as written by the node that wrote last.
    const start = checkpoints.find((s) => s.checkpointId === (at.checkpointId ?? latestId));
    const parent = start?.parentCheckpointId ? checkpoints.find((s) => s.checkpointId === start.parentCheckpointId) : undefined;
    const last = start ? stepNodes(start, parent).find((n) => nodes.includes(n)) : undefined;
    setAsNode(last ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset each time the sheet opens
  }, [open, at?.checkpointId]);
  const parsed = parseJson(text);
  const appended = useMemo(() => appendKeys(stateSchema), [stateSchema]);
  const valuesCut = base ? cutOf(base.cuts, "values") : undefined;
  const changes = useMemo(() => (parsed.ok && parsed.value !== undefined && base && !valuesCut ? updatePreview(base.values, parsed.value, appended) : null), [parsed, base, valuesCut, appended]);
  const valid = parsed.ok && parsed.value !== undefined && typeof parsed.value === "object" && parsed.value !== null && !Array.isArray(parsed.value);
  const forks = checkpoint !== LATEST && checkpoint !== latestId;
  const submit = async (continueRun: boolean) => {
    if (!connId || !valid) return;
    setBusy(continueRun ? "continue" : "save");
    setError(null);
    try {
      const out = await client.langgraph.threads.updateState({ connId, threadId, values: parsed.value as api.JsonValue, asNode, checkpointId: forks ? checkpoint : null });
      toast.add({ title: forks ? "Forked" : "State updated", description: out.checkpointId ? `New checkpoint ${shortId(out.checkpointId)}` : undefined, type: "success" });
      onSaved(out.checkpointId ?? null, continueRun);
      onClose();
    } catch (e) {
      setError(note(e));
    } finally {
      setBusy(null);
    }
  };
  const checkpointItems: Record<string, string> = { [LATEST]: latestId ? `${shortId(latestId)} (latest)` : "The latest" };
  for (const s of checkpoints.slice(1)) {
    if (s.checkpointId) checkpointItems[s.checkpointId] = `${shortId(s.checkpointId)} · step ${stepOf(s) ?? "?"}`;
  }
  if (at?.checkpointId && !(at.checkpointId in checkpointItems) && at.checkpointId !== latestId) checkpointItems[at.checkpointId] = shortId(at.checkpointId);
  const nodeItems = Object.fromEntries(nodes.map((n) => [n, n]));
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} size="lg">
      <SheetContent className="max-w-panel-sheet">
        <SheetHeader>
          <SheetTitle>{forks ? "Fork from a checkpoint" : "Edit state"}</SheetTitle>
          <SheetDescription>
            Thread {shortId(threadId)} · {forks ? `writes a new branch after ${shortId(checkpoint)}` : `makes a new checkpoint after ${latestId ? shortId(latestId) : "the latest"}`}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-stack-lg">
          {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
          <div className="grid grid-cols-2 gap-inline-lg">
            <Field>
              <FieldLabel>As node</FieldLabel>
              <Select aria-label="As node" value={asNode} onValueChange={(v) => setAsNode((v as string | null) ?? null)} items={nodeItems} placeholder="The graph decides">
                {nodes.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </Select>
              <FieldDescription>The update counts as written by this node; the graph continues from what follows it.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>Checkpoint</FieldLabel>
              <Select aria-label="Checkpoint" value={checkpoint} onValueChange={(v) => setCheckpoint((v as string) ?? LATEST)} items={checkpointItems}>
                {Object.entries(checkpointItems).map(([id, label]) => (
                  <SelectItem key={id} value={id}>
                    {label}
                  </SelectItem>
                ))}
              </Select>
              <FieldDescription>An older one forks a new branch.</FieldDescription>
            </Field>
          </div>
          <JsonField label="Values to write" value={text} onChange={setText} rows={7} schema={partialSchema(stateSchema)} schemaLabel="the state schema" onSubmit={() => void submit(false)} description="Completion and validation from the assistant's state schema; reducers apply as the graph defines them (messages are appended, not replaced)." />
          {parsed.ok && parsed.value !== undefined && !valid ? <p className="text-body-1 text-danger-fg">The values to write are a JSON object: {"{ \"key\": value }"}.</p> : null}
          <section aria-label="What changes" className="flex flex-col gap-stack-sm border-t border-border-subtle pt-stack-md">
            <button type="button" aria-expanded={showChanges} onClick={() => setShowChanges((s) => !s)} className="flex items-center gap-inline-sm text-start text-body-1-strong text-fg">
              <Icon icon={showChanges ? ChevronDown : ChevronRight} />
              What changes
              {changes ? (
                <span className="text-body-1 text-fg-muted">
                  {changes.keys.length} key{changes.keys.length === 1 ? "" : "s"}
                </span>
              ) : null}
            </button>
            {showChanges ? (
              read.loading && !base ? (
                <LoadingRows label="Loading the checkpoint" />
              ) : valuesCut ? (
                <p className="text-body-1 text-fg-muted">The checkpoint's values were left out for their size, so the change cannot be shown here; what you write is sent as it is.</p>
              ) : !changes ? (
                <p className="text-body-1 text-fg-muted">Type the values to write to see what they change.</p>
              ) : changes.keys.length === 0 ? (
                <p className="text-body-1 text-fg-muted">Nothing changes: the values are already these.</p>
              ) : (
                <>
                  <DiffView label="The change" lines={changes.lines} />
                  <p className="text-caption-1 text-fg-muted">The preview appends to {[...appended].join(", ")} and replaces the other keys; a graph with other reducers may write differently.</p>
                </>
              )
            ) : null}
          </section>
        </SheetBody>
        <SheetFooter className="flex-nowrap">
          <Button appearance="subtle" loading={busy === "continue"} disabled={!valid || busy !== null} onClick={() => void submit(true)}>
            Update and continue the run
          </Button>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button appearance="primary" loading={busy === "save"} disabled={!valid || busy !== null} onClick={() => void submit(false)}>
            <Icon icon={Save} /> Update state
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

