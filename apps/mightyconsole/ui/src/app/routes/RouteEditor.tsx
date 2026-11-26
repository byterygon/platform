// The route editor (DOC-23 §10, (p), (q), (r); mockup frames routes-editor, routes-editor-long,
// routes-hop-*, routes-test-ok, routes-test-fail, routes-trust, routes-trust-changed): a 760 px
// sheet (the full width under 1024 px) with the path figure above an ordered list of 1 to 8 hops.
// Hops reorder by drag, by the keyboard pattern of a sortable list (Space lifts, arrows move,
// Space drops, Esc cancels; the new place is announced) and by Move up and Move down. Each hop
// opens in place on its form. Test runs the draft to a target host and port, one line per hop up to
// the first failure; an unknown or changed host key asks to be trusted right there and is saved
// into the SSH host. Saving a route whose commands nobody confirmed opens the confirmation.
import { type DragEvent, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type { HopInput, HopView, RouteKind, RouteTestOutput, RouteView } from "@/gen/api";
import { Add, ArrowDown, ArrowUp, ChevronDown, ChevronRight, Delete, PlugConnected } from "@/lib/icons";
import {
  type DraftHop,
  type RouteDraft,
  type RouteErrors,
  HOP_KIND_LABELS,
  MAX_HOPS,
  confirmRoute,
  emptyRouteDraft,
  hasErrors,
  hopKey,
  hopTitle,
  moveHop,
  proxyById,
  routeDraftOf,
  saveRoute,
  testRoute,
  unconfirmedHops,
  validateRoute,
} from "@/profiles/routes";
import { addressOf, sshHostById, trustHostKey } from "@/profiles/ssh-hosts";
import type { MightyClient } from "../client";
import { HostKeyDialog } from "../dialogs/HostKeyDialog";
import { describeError, describeToolError } from "../messages";
import { ErrorState } from "../states";
import type { DescribedError } from "@/tools/types";
import { CommandConfirm } from "./CommandConfirm";
import { CommandHopForm, ProxyHopForm, SshHopForm } from "./HopForms";
import { type PathNode, PathFigure, resultsOf } from "./PathFigure";

export interface RouteEditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  client: MightyClient;
  /** The route to edit; none makes one of `kind`. */
  route?: RouteView | undefined;
  kind?: RouteKind;
  /** A new route for the tenant by default (from a shared profile's Connect through). */
  sharedByDefault?: boolean;
  /** A target to test with (a profile's address). */
  testTarget?: string | undefined;
  /** The hop to open first (an error's or a figure's). */
  openHop?: number | undefined;
  onSaved?: (route: RouteView) => void;
}

/** What a hop of the draft is, for its row and the figure: the kind and the address. */
function nodeOf(hop: DraftHop): PathNode & { kindLabel: string } {
  const h = hop.hop;
  switch (h.kind) {
    case "proxy": {
      const p = proxyById(h.proxyId);
      const kind = p?.fields.kind ?? hop.proxyKind ?? "httpConnect";
      return { kind, label: p ? `${p.fields.host}:${p.fields.port}` : "choose a proxy", name: p?.name, kindLabel: HOP_KIND_LABELS[kind] ?? kind };
    }
    case "ssh":
    case "sshCommand": {
      const host = sshHostById(h.sshHostId);
      return { kind: h.kind, label: host ? addressOf(host.fields) : "choose an SSH host", name: host?.name, kindLabel: HOP_KIND_LABELS[h.kind] ?? h.kind };
    }
    default: {
      const name = h.program.trim().split(/[\\/]/).pop() || "program";
      return { kind: "command", label: name, kindLabel: HOP_KIND_LABELS.command ?? "Local command" };
    }
  }
}

function newHop(kind: "httpConnect" | "socks5" | "ssh" | "sshCommand" | "command"): DraftHop {
  switch (kind) {
    case "httpConnect":
    case "socks5":
      return { key: hopKey(), hop: { kind: "proxy", proxyId: "" }, proxyKind: kind };
    case "ssh":
      return { key: hopKey(), hop: { kind: "ssh", sshHostId: "" } };
    case "sshCommand":
      return { key: hopKey(), hop: { kind: "sshCommand", sshHostId: "", command: "nc {host} {port}" } };
    default:
      return { key: hopKey(), hop: { kind: "command", program: "", args: [], env: [], cwd: null } };
  }
}

function splitTarget(text: string): { host: string; port: string } {
  const t = text.trim();
  const at = t.lastIndexOf(":");
  if (at <= 0 || t.endsWith("]")) return { host: t, port: "" };
  return { host: t.slice(0, at).replace(/^\[|\]$/g, ""), port: t.slice(at + 1) };
}

type TestState = { status: "idle" } | { status: "running" } | { status: "done"; out: RouteTestOutput } | { status: "failed"; error: DescribedError };

export function RouteEditor({ open, onOpenChange, client, route, kind = "path", sharedByDefault = false, testTarget, openHop, onSaved }: RouteEditorProps) {
  const [draft, setDraft] = useState<RouteDraft>(() => (route ? routeDraftOf(route) : { ...emptyRouteDraft(kind), shared: sharedByDefault }));
  const [errors, setErrors] = useState<RouteErrors>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [lifted, setLifted] = useState<number | null>(null);
  const [announce, setAnnounce] = useState("");
  const [dragging, setDragging] = useState<number | null>(null);
  const [target, setTarget] = useState(() => splitTarget(testTarget ?? ""));
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [trust, setTrust] = useState<{ index: number; error: DescribedError } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<DescribedError | null>(null);
  const [confirming, setConfirming] = useState<{ route: RouteView; hops: HopView[]; before: (HopView | undefined)[] } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const liftedFrom = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const next = route ? routeDraftOf(route) : { ...emptyRouteDraft(kind), shared: sharedByDefault };
    setDraft(next);
    setErrors({});
    setSaveError(null);
    setTest({ status: "idle" });
    setTarget(splitTarget(testTarget ?? ""));
    setExpanded(openHop !== undefined ? (next.hops[openHop]?.key ?? null) : next.hops.length === 0 ? null : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, route?.id]);

  const readOnly = route !== undefined && route.access !== "owner" && route.access !== "edit";
  const system = draft.kind === "system";
  const nodes = useMemo(() => draft.hops.map(nodeOf), [draft.hops]);
  const setHops = (hops: DraftHop[]) => {
    setDraft((d) => ({ ...d, hops }));
    // Moving or changing a hop clears the test result.
    setTest({ status: "idle" });
  };
  const setHop = (i: number, hop: HopInput) => setHops(draft.hops.map((h, j) => (j === i ? { ...h, hop } : h)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.hops.length || from === to) return;
    setHops(moveHop(draft.hops, from, to));
    setAnnounce(`Hop moved to position ${to + 1} of ${draft.hops.length}.`);
  };
  const add = (k: Parameters<typeof newHop>[0]) => {
    const hop = newHop(k);
    setHops(k === "command" ? [hop, ...draft.hops] : [...draft.hops, hop]);
    setExpanded(hop.key);
  };

  const gripKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (lifted === null) {
        setLifted(i);
        liftedFrom.current = i;
        setAnnounce(`Hop ${i + 1} lifted. Use the arrow keys to move it, Space to drop it, Escape to cancel.`);
      } else {
        setLifted(null);
        setAnnounce(`Hop dropped at position ${i + 1}.`);
      }
    } else if (lifted !== null && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const to = e.key === "ArrowUp" ? lifted - 1 : lifted + 1;
      if (to >= 0 && to < draft.hops.length) {
        move(lifted, to);
        setLifted(to);
      }
    } else if (lifted !== null && e.key === "Escape") {
      e.preventDefault();
      if (liftedFrom.current !== null) move(lifted, liftedFrom.current);
      setLifted(null);
      setAnnounce("Move cancelled.");
    }
  };
  const drop = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    if (dragging !== null) move(dragging, i);
    setDragging(null);
  };

  const targetPort = Number(target.port);
  const targetOk = target.host.trim() !== "" && Number.isInteger(targetPort) && targetPort >= 1 && targetPort <= 65535;
  const runTest = async () => {
    const next = validateRoute(draft);
    setErrors(next);
    if (hasErrors(next) || !targetOk) return;
    setTest({ status: "running" });
    try {
      const where = { host: target.host.trim(), port: targetPort };
      const out = system && route ? await testRoute(client, where, { id: route.id }) : await testRoute(client, where, { hops: draft.hops.map((h) => h.hop) });
      setTest({ status: "done", out });
      const failed = out.lines.find((l) => !l.ok);
      if (failed?.error?.hostKey?.sshHostId) setTrust({ index: failed.hop.index, error: describeToolError(failed.error) });
    } catch (e) {
      setTest({ status: "failed", error: describeError(e) });
    }
  };

  const save = async () => {
    const next = validateRoute(draft);
    setErrors(next);
    if (hasErrors(next)) {
      const bad = draft.hops.findIndex((_, i) => next[`hop${i}`] !== undefined);
      if (bad >= 0) setExpanded(draft.hops[bad]?.key ?? null);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveRoute(client, draft, route);
      const waiting = unconfirmedHops(saved);
      if (waiting.length > 0) {
        setConfirming({ route: saved, hops: waiting, before: saved.hops.map((_, i) => route?.hops[i]) });
      } else {
        onSaved?.(saved);
        onOpenChange(false);
      }
    } catch (e) {
      setSaveError(describeError(e));
    } finally {
      setSaving(false);
    }
  };

  const confirm = async () => {
    if (!confirming) return;
    setConfirmBusy(true);
    try {
      const out = await confirmRoute(
        client,
        confirming.route,
        confirming.hops.map((h) => h.linkId),
      );
      setConfirming(null);
      onSaved?.(out);
      onOpenChange(false);
    } catch (e) {
      setSaveError(describeError(e));
      setConfirming(null);
    } finally {
      setConfirmBusy(false);
    }
  };

  const lines = test.status === "done" ? test.out.lines : [];
  const results = test.status === "done" ? resultsOf(lines, draft.hops.length) : undefined;
  const targetLabel = targetOk ? `${target.host.trim()}:${targetPort}` : null;
  const storedHop = (i: number) => route?.hops[i];
  const trustHost = trust ? sshHostById(trust.error.hostKey?.sshHostId ?? null) : undefined;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{route ? `Edit ${route.name}` : system ? "New System proxy route" : "New route"}</SheetTitle>
          <SheetDescription>
            {system
              ? "Reads HTTPS_PROXY, ALL_PROXY and NO_PROXY of the server's environment at each connection; chosen by hand only."
              : "An ordered path from this server to a profile's target: the first hop is the one the server contacts, every next hop is reached through the one before."}
          </SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="route-form"
            className="flex flex-col gap-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field invalid={errors.name !== undefined}>
              <FieldLabel>Name</FieldLabel>
              <Input value={draft.name} onValueChange={(name) => setDraft((d) => ({ ...d, name }))} placeholder="prod" disabled={readOnly} autoComplete="off" />
              {errors.name ? <FieldError match>{errors.name}</FieldError> : null}
            </Field>
            {route && !route.confirmed ? (
              <Alert intent="warning">
                <AlertTitle>Not confirmed</AlertTitle>
                <AlertDescription>A command of this route has not been read and confirmed: it cannot be tested, chosen or used yet. Save to see the confirmation.</AlertDescription>
              </Alert>
            ) : null}
            {!system ? (
              <>
                <div className="overflow-x-auto rounded-md border border-border-subtle bg-layer-alt p-inset-sm">
                  <PathFigure
                    hops={nodes}
                    target={targetLabel}
                    tls
                    {...(results ? { results } : {})}
                    onNodeClick={(i) => setExpanded(draft.hops[i]?.key ?? null)}
                  />
                </div>
                <div role="status" aria-live="polite" className="sr-only">
                  {announce}
                </div>
                <ol className="flex flex-col gap-stack-xs" aria-label="Hops">
                  {draft.hops.map((h, i) => {
                    const node = nodes[i];
                    const isOpen = expanded === h.key;
                    const view = storedHop(i);
                    const line = lines.find((l) => l.hop.index === i);
                    const notConfirmed = view && view.needsConfirmation && !view.confirmed && JSON.stringify(view && hopInputOfView(view)) === JSON.stringify(h.hop);
                    return (
                      <li
                        key={h.key}
                        className={`flex flex-col rounded-md border ${lifted === i ? "border-accent-compound" : "border-border-subtle"} bg-layer`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={drop(i)}
                        aria-label={`Hop ${i + 1}: ${node?.kindLabel} ${node?.name ?? node?.label}`}
                      >
                        <div className="flex items-center gap-inline-sm px-inset-sm py-inset-xs">
                          <button
                            type="button"
                            draggable={!readOnly}
                            onDragStart={() => setDragging(i)}
                            onKeyDown={gripKey(i)}
                            aria-label={`Reorder hop ${i + 1}`}
                            aria-pressed={lifted === i}
                            disabled={readOnly}
                            className="cursor-grab rounded-sm px-inline-xs text-fg-muted focus-visible:outline-2 focus-visible:outline-accent-compound"
                          >
                            ⋮⋮
                          </button>
                          <span className="text-caption-1-strong text-fg-muted">{i + 1}</span>
                          <span className="text-body-1-strong">{node?.kindLabel}</span>
                          <span className="min-w-0 truncate font-mono text-body-1 text-fg-muted">{node?.name ? `${node.name} · ${node.label}` : node?.label}</span>
                          {notConfirmed ? <Badge variant="warning">Not confirmed</Badge> : null}
                          {line ? <Badge variant={line.ok ? "success" : "danger"}>{line.ok ? `${line.ms} ms` : (line.failure ?? "Failed")}</Badge> : null}
                          {errors[`hop${i}`] ? <Badge variant="danger">Fix</Badge> : null}
                          <span className="ms-auto inline-flex gap-inline-xs">
                            <IconButton aria-label={`Move hop ${i + 1} up`} size="small" appearance="subtle" disabled={readOnly || i === 0} onClick={() => move(i, i - 1)}>
                              <Icon icon={ArrowUp} />
                            </IconButton>
                            <IconButton aria-label={`Move hop ${i + 1} down`} size="small" appearance="subtle" disabled={readOnly || i === draft.hops.length - 1} onClick={() => move(i, i + 1)}>
                              <Icon icon={ArrowDown} />
                            </IconButton>
                            <IconButton aria-label={`Remove hop ${i + 1}`} size="small" appearance="subtle" disabled={readOnly} onClick={() => setHops(draft.hops.filter((_, j) => j !== i))}>
                              <Icon icon={Delete} />
                            </IconButton>
                            <IconButton aria-label={isOpen ? `Close hop ${i + 1}` : `Open hop ${i + 1}`} aria-expanded={isOpen} size="small" appearance="subtle" onClick={() => setExpanded(isOpen ? null : h.key)}>
                              <Icon icon={isOpen ? ChevronDown : ChevronRight} />
                            </IconButton>
                          </span>
                        </div>
                        {isOpen ? (
                          <div className="border-t border-border-subtle px-inset-md py-inset-sm">
                            {errors[`hop${i}`] ? <p className="mb-stack-xs text-body-1 text-danger-fg">{errors[`hop${i}`]}</p> : null}
                            {h.hop.kind === "proxy" ? (
                              <ProxyHopForm client={client} kind={(node?.kind === "socks5" ? "socks5" : "httpConnect") as "socks5" | "httpConnect"} proxyId={h.hop.proxyId} shared={draft.shared} onChange={(proxyId) => setHop(i, { kind: "proxy", proxyId })} />
                            ) : h.hop.kind === "ssh" || h.hop.kind === "sshCommand" ? (
                              <SshHopForm client={client} hop={h.hop} shared={draft.shared} onChange={(hop) => setHop(i, hop)} />
                            ) : (
                              <CommandHopForm hop={h.hop} stored={view?.kind === "command" ? view.env : undefined} next={nodes[i + 1]?.label ?? targetLabel ?? "{host}:{port}"} onChange={(hop) => setHop(i, hop)} />
                            )}
                            {line && !line.ok && line.error ? <ErrorState error={describeToolError(line.error)} /> : null}
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ol>
                {errors.hops ? <p className="text-body-1 text-danger-fg">{errors.hops}</p> : null}
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button className="self-start" disabled={readOnly || draft.hops.length >= MAX_HOPS} title={draft.hops.length >= MAX_HOPS ? `A route has at most ${MAX_HOPS} hops` : undefined} />
                    }
                  >
                    <Icon icon={Add} /> Add hop
                  </DropdownMenuTrigger>
                  <DropdownMenuContent aria-label="Hop kinds">
                    <DropdownMenuItem onClick={() => add("httpConnect")}>HTTP CONNECT proxy</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => add("socks5")}>SOCKS5 proxy</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => add("ssh")}>SSH jump host</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => add("sshCommand")}>SSH command on a host</DropdownMenuItem>
                    <DropdownMenuItem disabled={draft.hops.some((h) => h.hop.kind === "command")} onClick={() => add("command")}>
                      Local command (first hop)
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            ) : null}
            {!route ? (
              <Field orientation="horizontal">
                <Checkbox checked={draft.shared} onCheckedChange={(v) => setDraft((d) => ({ ...d, shared: v === true }))} />
                <FieldLabel>Shared: for shared profiles (needs profiles.manage), through shared proxies and SSH hosts</FieldLabel>
              </Field>
            ) : null}
            <fieldset className="flex flex-col gap-stack-sm rounded-md border border-border-subtle p-inset-sm" aria-label="Test">
              <legend className="px-inline-xs text-body-1-strong">Test</legend>
              <div className="flex items-end gap-inline-md">
                <Field className="min-w-0 flex-1">
                  <FieldLabel>Target host</FieldLabel>
                  <Input value={target.host} onValueChange={(host) => setTarget((t) => ({ ...t, host }))} placeholder="temporal.prod.internal" spellCheck={false} />
                </Field>
                <Field className="w-24">
                  <FieldLabel>Port</FieldLabel>
                  <Input inputMode="numeric" value={target.port} onValueChange={(port) => setTarget((t) => ({ ...t, port }))} placeholder="7233" />
                </Field>
                <Button loading={test.status === "running"} disabled={!targetOk || (system && !route)} onClick={() => void runTest()}>
                  <Icon icon={PlugConnected} /> Test
                </Button>
              </div>
              <p className="text-caption-1 text-fg-muted">Each hop in order, then TCP to the target (not the tool's own protocol); the test stops at the first failure. Up to 60 s.</p>
              {test.status === "done" ? (
                <ol className="flex flex-col gap-stack-xs" aria-label="Test result">
                  {Array.from({ length: test.out.hops + 1 }, (_, i) => {
                    const line = test.out.lines.find((l) => l.hop.index === i);
                    const title = i < test.out.hops ? `Hop ${i + 1}, ${nodes[i]?.kindLabel ?? ""} ${nodes[i]?.label ?? ""}` : `Target ${targetLabel ?? ""}`;
                    return (
                      <li key={i} className="flex items-center gap-inline-sm text-body-1">
                        <Badge variant={line ? (line.ok ? "success" : "danger") : "neutral"}>{line ? (line.ok ? "OK" : (line.failure ?? "Failed")) : "Not tried"}</Badge>
                        <span>{line ? hopTitle(line.hop) : title}</span>
                        {line ? <span className="ms-auto text-caption-1 text-fg-muted">{line.ms} ms</span> : null}
                      </li>
                    );
                  })}
                  <li className="text-caption-1 text-fg-muted">Total {test.out.ms} ms.</li>
                </ol>
              ) : test.status === "failed" ? (
                <ErrorState error={test.error} />
              ) : null}
              {test.status === "done"
                ? (() => {
                    const failed = test.out.lines.find((l) => !l.ok);
                    if (!failed?.error) return null;
                    const error = describeToolError(failed.error);
                    return (
                      <ErrorState
                        error={error}
                        {...(failed.hop.index < draft.hops.length ? { onEditProfile: () => setExpanded(draft.hops[failed.hop.index]?.key ?? null) } : {})}
                        {...(failed.error.hostKey?.sshHostId ? { onTrust: () => setTrust({ index: failed.hop.index, error }) } : {})}
                      />
                    );
                  })()
                : null}
            </fieldset>
            {saveError ? <ErrorState error={saveError} /> : null}
          </form>
        </SheetBody>
        <HostKeyDialog
          open={trust !== null}
          name={trustHost?.name ?? "SSH host"}
          target={trust ? `Jump host ${trust.index + 1} (${trustHost ? addressOf(trustHost.fields) : ""})` : ""}
          details={trust?.error.hostKey ?? null}
          onCancel={() => setTrust(null)}
          onTrust={(key) => {
            const id = trust?.error.hostKey?.sshHostId;
            setTrust(null);
            if (!id) return;
            void trustHostKey(client, id, key).then(() => runTest());
          }}
        />
        <CommandConfirm
          route={confirming?.route ?? null}
          hops={confirming?.hops ?? []}
          before={confirming?.before ?? []}
          busy={confirmBusy}
          onConfirm={() => void confirm()}
          onCancel={() => {
            const saved = confirming?.route;
            setConfirming(null);
            if (saved) {
              onSaved?.(saved);
              onOpenChange(false);
            }
          }}
        />
        <SheetFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button appearance="primary" loading={saving} disabled={readOnly} onClick={() => void save()}>
            Save route
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

function hopInputOfView(view: HopView): HopInput {
  switch (view.kind) {
    case "httpConnect":
    case "socks5":
      return { kind: "proxy", proxyId: view.proxyId ?? "" };
    case "ssh":
      return { kind: "ssh", sshHostId: view.sshHostId ?? "" };
    case "sshCommand":
      return { kind: "sshCommand", sshHostId: view.sshHostId ?? "", command: view.command ?? "" };
    default:
      return { kind: "command", program: view.program ?? "", args: [...view.args], env: view.env.map((v) => (v.secret ? { name: v.name, secret: true, value: null } : { name: v.name, secret: false, value: v.value ?? "" })), cwd: view.cwd ?? null };
  }
}
