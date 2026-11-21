// What the Images, Volumes and Networks tabs share (Mightyconsole spec §10.4, TSK-81 batch 3,
// mockup frames docker-images and docker-volumes): a list loaded once and again after the host's
// events of its kind (and the container events that change what uses an item), the "Used by" cell
// (running containers first, each a link to its container), the Inspect sheet (`docker inspect` in
// the JsonViewer) and the toast after a remove. Each list it loads gives the tree its count.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { JsonViewer } from "@/components/ui/json-viewer";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { MightyClient } from "@/app/client";
import { CopyButton, LinkButton } from "@/app/page";
import { ErrorState, LoadingRows } from "@/app/states";
import type { ContainerUse } from "@/gen/api";
import { Code, Delete } from "@/lib/icons";
import type { DescribedError, LinkEvent } from "../types";
import { type DockerEvent, changesRows } from "./format";
import { type EventsState, useDockerEvents } from "./live";
import { setTreeCount } from "./tree-data";

const TREE_COUNT = { image: "images", volume: "volumes", network: "networks" } as const;

/** How long after an event the list is loaded again (a project's `down` sends a burst). */
export const RELOAD_DEBOUNCE_MS = 300;

/** Containers named in a "Used by" cell before "+n more". */
export const USED_BY_SHOWN = 2;

/** The container events that change what uses an image, a volume or a network. */
export function changesUsers(event: DockerEvent): boolean {
  return event.kind === "container" && changesRows(event);
}

export interface DockerList<T> {
  data: T | null;
  error: DescribedError | null;
  loading: boolean;
  reload(): void;
  events: EventsState;
}

/**
 * Loads a list while connected and again after the host's events of `kind` or a container's that
 * changes what uses it; the latest answer wins.
 */
export function useDockerList<T>({ client, connId, note, kind, load, count, active }: { /** The tab is shown (TSK-107). */ active: boolean; client: MightyClient; connId: string | null; note(e: unknown): DescribedError; kind: "image" | "volume" | "network"; load(connId: string): Promise<T>; count(data: T): number }): DockerList<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loader = useRef(load);
  loader.current = load;
  const counter = useRef(count);
  counter.current = count;

  const reload = useCallback(async () => {
    if (connId === null) return;
    const mine = ++generation.current;
    setLoading(true);
    try {
      const next = await loader.current(connId);
      if (mine !== generation.current) return;
      setData(next);
      setError(null);
      setTreeCount(connId, TREE_COUNT[kind], counter.current(next));
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [connId, note]);

  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const events = useDockerEvents({
    client,
    connId,
    active,
    types: [kind, "container"],
    onEvent: (event) => {
      if (event.kind !== kind && !changesUsers(event)) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reload(), RELOAD_DEBOUNCE_MS);
    },
  });

  return { data, error, loading, reload: () => void reload(), events };
}

/** `shop-api-1, shop-api-2` with a dot per container (green while running); a link to each. */
export function UsedBy({ list, onOpen }: { list: readonly ContainerUse[]; onOpen(name: string, event?: LinkEvent): void }) {
  if (list.length === 0) return <span className="text-fg-muted">—</span>;
  const shown = list.slice(0, USED_BY_SHOWN);
  const rest = list.length - shown.length;
  return (
    <span className="flex min-w-0 items-center gap-inline-md whitespace-nowrap" title={list.map((u) => `${u.name} (${u.state})`).join(", ")}>
      {shown.map((u) => (
        <Badge key={u.name} appearance="dot" size="sm" variant={u.state === "running" ? "success" : "neutral"}>
          <LinkButton onOpen={(e) => onOpen(u.name, e)} aria-label={`${u.name}, ${u.state}`}>
            {u.name}
          </LinkButton>
        </Badge>
      ))}
      {rest > 0 ? <span className="text-fg-muted">+{rest} more</span> : null}
    </span>
  );
}

/** Running containers among the users, for the in-use reasons. */
export function runningUsers(list: readonly ContainerUse[]): ContainerUse[] {
  return list.filter((u) => u.state === "running");
}

/** `shop-api-1`, `shop-api-1 and shop-api-2`, `shop-api-1, shop-api-2 and 3 more`. */
export function namesText(list: readonly ContainerUse[]): string {
  const names = list.map((u) => u.name);
  if (names.length <= 1) return names.join("");
  if (names.length <= 3) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** What `docker inspect` of an item shows in the sheet. */
export interface InspectTarget {
  /** `image`, `volume` or `network`. */
  what: string;
  name: string;
  load(): Promise<{ inspect: Record<string, unknown> }>;
}

/** `docker inspect` of an image, a volume or a network in a sheet, with Copy. */
export function InspectSheet({ target, host, note, onClose }: { target: InspectTarget | null; host: string; note(e: unknown): DescribedError; onClose(): void }) {
  const [value, setValue] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setValue(null);
    setError(null);
    if (!target) return undefined;
    let stale = false;
    target.load().then(
      (out) => !stale && setValue(out.inspect),
      (e: unknown) => !stale && setError(note(e)),
    );
    return () => {
      stale = true;
    };
  }, [target, note, attempt]);

  const command = target ? `docker ${target.what} inspect ${target.name}` : "";
  return (
    <Sheet open={target !== null} onOpenChange={(o) => !o && onClose()} size="lg">
      <SheetContent className="flex flex-col">
        <SheetHeader>
          <SheetTitle>
            <span className="font-mono">{target?.name}</span>
          </SheetTitle>
          <SheetDescription>
            <span className="font-mono text-code">{command}</span> on {host}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex min-h-0 flex-1 flex-col gap-stack-sm">
          {error ? <ErrorState error={error} onRetry={() => setAttempt((n) => n + 1)} /> : null}
          {!value && !error ? <LoadingRows label={`Loading ${command}`} /> : null}
          {value ? (
            <>
              <span className="flex items-center justify-end">
                <CopyButton value={JSON.stringify(value, null, 2)} what="inspect JSON" />
              </span>
              <JsonViewer value={value} aria-label={command} defaultExpandDepth={1} className="min-h-0 flex-1" />
            </>
          ) : null}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}

/** A toast's sentences after a remove: `Removed old-cache`, `Could not remove shop_data: …`. */
export function removeOutcome(what: string, done: readonly string[], failed: readonly { name: string; error: string }[]): { title: string; description?: string; type: "success" | "warning" } {
  const many = (n: number) => `${n} ${what}${n === 1 ? "" : "s"}`;
  if (failed.length === 0) return { title: `Removed ${done.length === 1 ? done[0] : many(done.length)}`, type: "success" };
  const first = failed[0]!;
  return {
    title: done.length > 0 ? `Removed ${many(done.length)}; ${failed.length} failed` : `Could not remove ${failed.length === 1 ? first.name : many(failed.length)}`,
    description: failed.length === 1 ? first.error : failed.map((f) => `${f.name}: ${f.error}`).join("\n"),
    type: "warning",
  };
}

/** A row's Inspect and Remove as icon buttons with tooltips; Remove is off with the reason in its tooltip (and its name). */
export function RowActions({ name, onInspect, onRemove, refusal }: { name: string; onInspect(): void; onRemove(): void; refusal: string | null }) {
  return (
    <span className="flex items-center justify-end gap-inline-xs">
      <Tooltip>
        <TooltipTrigger render={<IconButton size="small" appearance="subtle" onClick={onInspect} aria-label={`Inspect ${name}`} />}>
          <Icon icon={Code} />
        </TooltipTrigger>
        <TooltipContent>Inspect</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={refusal === null ? <IconButton size="small" appearance="subtle" onClick={onRemove} aria-label={`Remove ${name}`} /> : <IconButton size="small" appearance="subtle" disabled focusableWhenDisabled aria-label={`Remove ${name}: ${refusal}`} />}>
          <Icon icon={Delete} />
        </TooltipTrigger>
        <TooltipContent>{refusal ?? "Remove…"}</TooltipContent>
      </Tooltip>
    </span>
  );
}
