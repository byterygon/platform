// The network map's side panel (DOC-23 §10, (aa) to (ad); mockup frames routes-map, routes-map-edge,
// routes-map-add, routes-map-test): what is selected, with what can be done to it.
// - A node: its address and login, where it is used, the way in when it has two, the route to it
//   link by link with Test, Save as route, "Connect to…" (what dragging does) and Remove node.
// - A link: its method (the ones the source allows), for a command its program and arguments or its
//   line with the live "what will run", the confirmation a command waits for, Test this link, Remove.
// A command is not confirmed until a person has read it here; saving a change to what it runs clears
// the confirmation.
import { type ReactNode, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { LinkView } from "@/gen/api";
import { Checkmark, Delete, Edit, Play, Warning } from "@/lib/icons";
import { type LinkDraft, METHOD_LABELS, changesWhatRuns, draftForMethod, draftOfLink, previewOfDraft } from "@/profiles/links";
import { type EdgeResult, type MapEdge, type MapGraph, type MapNode, type MapPath, NODE_KIND_LABELS, edgeLabel, linkTargets, methodsOf, nodeById } from "./model";


function Detail({ term, mono = false, children }: { term: string; mono?: boolean; children: ReactNode }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails className={mono ? "font-mono" : ""}>{children}</DescriptionListDetails>
    </DescriptionListItem>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="text-caption-1 text-fg-muted">{children}</p>;
}

export interface NodePanelProps {
  graph: MapGraph;
  node: MapNode;
  /** The edges that reach it. */
  incoming: readonly MapEdge[];
  via: string | undefined;
  path: MapPath;
  results: Record<string, EdgeResult> | null;
  busy: boolean;
  /** Why the path to it cannot be tested or saved, or `null`. */
  testBlocked: string | null;
  routeName: string;
  onRouteName: (name: string) => void;
  onChooseWayIn: (edgeId: string) => void;
  onTest: () => void;
  onSaveRoute: () => void;
  onLinkTo: (nodeId: string) => void;
  onEdit?: (() => void) | undefined;
  onRemove?: (() => void) | undefined;
  onOpenProfile?: (() => void) | undefined;
  onFix: (edgeId: string) => void;
  onSelectEdge: (edgeId: string) => void;
}

export function NodePanel(p: NodePanelProps) {
  const n = p.node;
  const targets = n.kind === "target" ? [] : linkTargets(p.graph, n.id);
  return (
    <div className="flex flex-col gap-stack-md" data-testid="map-node-panel">
      <div className="flex items-center gap-inline-sm">
        <h3 className="min-w-0 flex-1 truncate text-subtitle-2">{n.name}</h3>
        <Badge>{NODE_KIND_LABELS[n.kind]}</Badge>
      </div>
      <DescriptionList layout="aligned">
        {n.address ? <Detail term="Address" mono>{n.address}</Detail> : null}
        {n.kind === "host" && n.user ? <Detail term="User" mono>{n.user}</Detail> : null}
        {n.kind === "host" && n.auth ? <Detail term="Authentication">{n.auth}</Detail> : null}
        {n.used.length > 0 ? <Detail term="Used by">{n.used.join(", ")}</Detail> : null}
      </DescriptionList>
      {n.kind !== "server" ? (
        <section className="flex flex-col gap-stack-xs" aria-label="Reach it via">
          <h4 className="text-caption-1-strong text-fg-muted">Reach it via</h4>
          {p.incoming.length === 0 ? (
            <span className="text-body-1 text-fg-muted">No link reaches it yet. Drag a link from another node onto it, or choose Connect to… on that node.</span>
          ) : (
            <ToggleGroup aria-label="Way in" orientation="vertical" value={p.via ? [p.via] : []} onValueChange={(v) => v[0] && p.onChooseWayIn(v[0])}>
              {p.incoming.map((e) => (
                <ToggleGroupItem key={e.id} value={e.id} disabled={p.incoming.length === 1}>
                  {nodeById(p.graph, e.from)?.name ?? e.from} · {edgeLabel(p.graph, e)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          )}
        </section>
      ) : null}
      {n.kind !== "server" ? (
        <section className="flex flex-col gap-stack-xs" aria-label="Route to here">
          <h4 className="text-caption-1-strong text-fg-muted">Route to here</h4>
          {p.path.ok && p.path.edges.length > 0 ? (
            <ol className="flex flex-col gap-stack-xs text-body-1">
              {p.path.edges.map((e, i) => {
                const r = p.results?.[e.id];
                return (
                  <li key={e.id} data-state={r?.s} className="flex flex-col gap-stack-xs">
                    <button type="button" className="flex items-center gap-inline-sm text-start" onClick={() => p.onSelectEdge(e.id)}>
                      <span className="w-control-xs text-fg-muted">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        {nodeById(p.graph, e.from)?.name} → {nodeById(p.graph, e.to)?.name} <span className="text-fg-muted">· {edgeLabel(p.graph, e)}</span>
                      </span>
                      <span className={r?.s === "bad" ? "text-danger-fg" : "text-fg-muted"}>{r ? (r.s === "run" ? "…" : r.s === "ok" ? `${r.ms ?? 0} ms` : "failed") : ""}</span>
                    </button>
                    {r?.text ? (
                      <div role="alert" className="ms-icon-xl text-danger-fg">
                        {r.text}
                        {r.hint ? (
                          <Button size="small" appearance="subtle" className="ms-inline-sm" onClick={() => p.onFix(e.id)}>
                            Use SSH command instead
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ol>
          ) : (
            <span className="text-body-1 text-fg-muted">{p.path.ok ? "This server reaches it directly." : "No path from this server reaches it yet."}</span>
          )}
          {p.testBlocked ? <span className="text-caption-1 text-fg-muted">{p.testBlocked}</span> : null}
          <div>
            <Button size="small" appearance="primary" disabled={p.busy || p.testBlocked !== null} onClick={p.onTest}>
              <Icon icon={Play} size="sm" />
              Test route
            </Button>
          </div>
          <div className="flex items-end gap-inline-sm">
            <Field className="min-w-0 flex-1">
              <FieldLabel className="sr-only">Route name</FieldLabel>
              <Input aria-label="Route name" value={p.routeName} onValueChange={p.onRouteName} placeholder="Route name" />
            </Field>
            <Button size="small" disabled={p.busy || p.routeName.trim() === "" || !p.path.ok} onClick={p.onSaveRoute}>
              Save as route
            </Button>
          </div>
        </section>
      ) : null}
      {n.kind !== "target" ? (
        <section className="flex flex-col gap-stack-xs" aria-label="Add a link from here">
          <h4 className="text-caption-1-strong text-fg-muted">Add a link from here</h4>
          <Select<string | null> aria-label={`Connect ${n.name} to`} value={null} placeholder="Connect to…" onValueChange={(v) => typeof v === "string" && p.onLinkTo(v)}>
            {targets.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </Select>
          <Hint>Or drag from the dot on the node's right edge.</Hint>
        </section>
      ) : null}
      <div className="flex flex-wrap gap-inline-sm">
        {p.onEdit ? (
          <Button size="small" appearance="subtle" onClick={p.onEdit}>
            <Icon icon={Edit} size="sm" />
            Edit {n.kind === "host" ? "SSH host" : "proxy"}
          </Button>
        ) : null}
        {p.onOpenProfile ? (
          <Button size="small" appearance="subtle" onClick={p.onOpenProfile}>
            Open profile
          </Button>
        ) : null}
        {p.onRemove ? (
          <Button size="small" appearance="subtle" className="text-danger-fg" onClick={p.onRemove}>
            <Icon icon={Delete} size="sm" />
            Remove node
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export interface LinkPanelProps {
  graph: MapGraph;
  edge: MapEdge;
  result: EdgeResult | undefined;
  busy: boolean;
  /** Saves another method or other settings; a command link is saved here, not on every keystroke. */
  onSave: (draft: LinkDraft) => void;
  onConfirm: () => void;
  onTest: () => void;
  onRemove: () => void;
  onFix: () => void;
}

export function LinkPanel({ graph, edge, result, busy, onSave, onConfirm, onTest, onRemove, onFix }: LinkPanelProps) {
  const from = nodeById(graph, edge.from);
  const to = nodeById(graph, edge.to);
  const link: LinkView | undefined = edge.link;
  const base = link ? draftOfLink(link) : draftForMethod(edge.method);
  const [draft, setDraft] = useState<LinkDraft>(base);
  useEffect(() => {
    setDraft(link ? draftOfLink(link) : draftForMethod(edge.method));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edge.id, link?.etag]);
  if (!from || !to) return null;
  const methods = methodsOf(from);
  const editable = link !== undefined && (link.access === "owner" || link.access === "edit") && edge.link?.to.kind !== "target";
  const dirty = link !== undefined && JSON.stringify(draft) !== JSON.stringify(draftOfLink(link));
  const cmd = draft.method === "command" || draft.method === "sshCommand";
  const clears = link !== undefined && dirty && cmd && changesWhatRuns(link, draft) && link.confirmed !== undefined && link.confirmed !== null;
  const set = (patch: Partial<LinkDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const used = edge.routes;
  const readOnlyWhy = link === undefined ? "A link to a target you added is kept in this browser; its method is the one its source gives." : !editable ? (link.to.kind === "target" ? "This link ends a route: change it in the route's editor." : "You may not change this link.") : null;
  return (
    <div className="flex flex-col gap-stack-md" data-testid="map-link-panel">
      <div className="flex items-center gap-inline-sm">
        <h3 className="min-w-0 flex-1 truncate text-subtitle-2">
          {from.name} → {to.name}
        </h3>
        {edge.unconfirmed ? <Badge variant="warning">Not confirmed</Badge> : null}
      </div>
      <section className="flex flex-col gap-stack-xs" aria-label="Method">
        <h4 className="text-caption-1-strong text-fg-muted">How {from.kind === "server" ? "this server" : from.name} reaches {to.name}</h4>
        <ToggleGroup
          aria-label="Method"
          value={[draft.method]}
          onValueChange={(v) => {
            const m = methods.find((x) => x === v[0]);
            if (!m || m === draft.method) return;
            const next = draftForMethod(m, draft);
            setDraft(next);
            // A method with nothing to read is saved at once; a command waits for its Save.
            if (m !== "command" && m !== "sshCommand" && editable) onSave(next);
          }}
        >
          {methods.map((m) => (
            <ToggleGroupItem key={m} value={m} disabled={!editable && m !== draft.method}>
              {METHOD_LABELS[m]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {methods.length === 1 ? <Hint>A proxy has one way: the CONNECT request. Its login is the proxy's own setting.</Hint> : null}
        {readOnlyWhy ? <Hint>{readOnlyWhy}</Hint> : null}
      </section>
      {draft.method === "command" ? (
        <section className="flex flex-col gap-stack-sm">
          <Field>
            <FieldLabel>Program</FieldLabel>
            <Input className="font-mono" value={draft.program} disabled={!editable} onValueChange={(program) => set({ program })} placeholder="tsh" spellCheck={false} autoComplete="off" />
          </Field>
          <Field>
            <FieldLabel>Arguments</FieldLabel>
            <Textarea className="font-mono" rows={4} value={draft.args} disabled={!editable} onValueChange={(args) => set({ args })} spellCheck={false} />
            <FieldDescription>One per line, no shell. {"{host}"} and {"{port}"} are the next address.</FieldDescription>
          </Field>
        </section>
      ) : null}
      {draft.method === "sshCommand" ? (
        <Field>
          <FieldLabel>Command on {from.name}</FieldLabel>
          <Input className="font-mono" value={draft.command} disabled={!editable} onValueChange={(command) => set({ command })} placeholder="nc {host} {port}" spellCheck={false} autoComplete="off" />
          <FieldDescription>
            Runs as {from.user ?? "the host's user"} on {from.address.replace(/:22$/, "")}; its stdin and stdout are the stream. Use it when forwarding is off.
          </FieldDescription>
        </Field>
      ) : null}
      <section className="flex flex-col gap-stack-xs" aria-label="What will run">
        <h4 className="text-caption-1-strong text-fg-muted">What will run</h4>
        <Code className="break-all whitespace-pre-wrap">{previewOfDraft(draft, { from: from.id, to: to.id, fromName: from.name, user: from.user, next: to.address || to.name })}</Code>
      </section>
      {draft.method === "ssh" ? (
        <p className="text-body-1 text-fg-muted">
          Needs <Code>AllowTcpForwarding</Code> on {from.name}. The login, key and host key are {from.name}'s.
        </p>
      ) : null}
      {dirty && cmd ? (
        <div className="flex flex-col gap-stack-xs">
          {clears ? <span className="text-caption-1 text-warning-fg">Saving changes what runs: the confirmation is cleared and every route over it waits for a new one.</span> : null}
          <div className="flex gap-inline-sm">
            <Button size="small" appearance="primary" disabled={busy} onClick={() => onSave(draft)}>
              Save link
            </Button>
            <Button size="small" onClick={() => setDraft(base)}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}
      {edge.unconfirmed && !dirty ? (
        <div role="group" aria-label="Confirmation" className="flex gap-inline-sm rounded-md border border-border-subtle p-inset-sm text-body-1">
          <Icon icon={Warning} tone="warning" />
          <div className="flex flex-col gap-stack-xs">
            <b>This command has not been confirmed.</b>
            <span>It runs {draft.method === "command" ? "on this machine" : `on ${from.name}`}, so read it above first. It will not run until you do.</span>
            <div>
              <Button size="small" appearance="primary" disabled={busy || !editable} onClick={onConfirm}>
                <Icon icon={Checkmark} size="sm" />
                Confirm it may run
              </Button>
            </div>
          </div>
        </div>
      ) : null}
      {result?.text ? (
        <div role="alert" className="text-body-1 text-danger-fg">
          {result.text}
          {result.hint ? (
            <Button size="small" appearance="subtle" className="ms-inline-sm" onClick={onFix}>
              Use SSH command instead
            </Button>
          ) : null}
        </div>
      ) : null}
      <section className="flex flex-col gap-stack-xs" aria-label="Used by routes">
        <h4 className="text-caption-1-strong text-fg-muted">Used by routes</h4>
        {used.length > 0 ? (
          <div className="flex flex-wrap gap-inline-sm">
            {used.map((r) => (
              <Badge key={r}>{r}</Badge>
            ))}
          </div>
        ) : (
          <span className="text-body-1 text-fg-muted">No saved route yet</span>
        )}
      </section>
      <div className="flex gap-inline-sm">
        <Button size="small" disabled={busy} onClick={onTest}>
          <Icon icon={Play} size="sm" />
          Test this link
        </Button>
        <Button size="small" appearance="subtle" className="text-danger-fg" disabled={busy || (used.length > 0 && link !== undefined)} onClick={onRemove}>
          <Icon icon={Delete} size="sm" />
          Remove link
        </Button>
      </div>
      {used.length > 0 && link !== undefined ? <Hint>A route uses this link: take it out of the route first.</Hint> : null}
    </div>
  );
}

