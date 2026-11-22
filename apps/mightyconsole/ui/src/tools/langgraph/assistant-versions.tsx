// An assistant's Versions (DOC-21 §11.2.1, the TSK-91 mockup's langgraph-assistant-versions, Open
// question 45 (n), TSK-96): every version newest first with what it changed, the diff of config,
// context and metadata against the version before (side by side or unified). Read only:
// "Make current" and editing are Later (DOC-20).
import { Fragment, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { RelativeTime } from "@/components/ui/relative-time";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { gutterTable } from "@/app/page";
import type * as api from "@/gen/api";
import { cn } from "@/lib/cn";
import { ArrowUndo } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { DiffView } from "./diff-view";
import type { useLoad } from "./shared";
import { sideBySide, versionChange, versionDiff } from "./versions";

export interface VersionsPanelProps extends Pick<TabProps, "connId" | "client" | "note"> {
  assistantId: string;
  /** The first page, loaded by the tab for its count. */
  first: ReturnType<typeof useLoad<api.AssistantVersionsPage>>;
  /** The assistant's current version. */
  current: number | undefined;
}

const tag = (v: api.Assistant) => (v.version !== undefined ? `v${v.version}` : "—");

export function VersionsPanel({ assistantId, connId, client, note, first, current }: VersionsPanelProps) {
  const [more, setMore] = useState<api.Assistant[]>([]);
  const [moreNext, setMoreNext] = useState<{ offset: number | null } | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DescribedError | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [layout, setLayout] = useState<"side" | "unified">("side");
  useEffect(() => {
    setMore([]);
    setMoreNext(null);
  }, [first.data]);
  const versions = useMemo(() => [...(first.data?.items ?? []), ...more], [first.data, more]);
  const next = moreNext ? moreNext.offset : (first.data?.next ?? null);
  const at = Math.max(0, versions.findIndex((v) => v.version === selected));
  const chosen = versions[at];
  const before = versions[at + 1];
  const lines = useMemo(() => (chosen && before && chosen.cuts.length === 0 && before.cuts.length === 0 ? versionDiff(before, chosen) : null), [chosen, before]);
  const loadMore = async () => {
    if (!connId || next === null) return;
    setLoadingMore(true);
    try {
      const page = await client.langgraph.assistants.versions({ connId, assistantId, limit: 20, offset: next });
      setMore((m) => [...m, ...page.items]);
      setMoreNext({ offset: page.next ?? null });
    } catch (e) {
      setError(note(e));
    } finally {
      setLoadingMore(false);
    }
  };
  const older = versions.find((v) => v.version !== current);
  return (
    <Resizable orientation="horizontal" className="min-h-0 flex-1 border-t border-border-subtle">
      <ResizablePanel defaultSize={72} minSize={40}>
        <div className="flex h-full min-h-0 flex-col overflow-auto">
          {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
          {first.error ? <ErrorState error={first.error} onRetry={() => void first.reload()} /> : null}
          {first.loading && !first.data ? <LoadingRows label="Loading the versions" /> : null}
          {versions.length > 0 ? (
            <Table aria-label="Versions" className={gutterTable}>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-end">Version</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Change</TableHead>
                  <TableHead>
                    <span className="sr-only">Current</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((v, i) => (
                  <TableRow key={`${v.version ?? i}`} data-selected={i === at ? "" : undefined} aria-selected={i === at} onClick={() => setSelected(v.version ?? null)}>
                    <TableCell className="text-end">
                      <button type="button" onClick={() => setSelected(v.version ?? null)}>
                        {tag(v)}
                      </button>
                    </TableCell>
                    <TableCell>{v.createdAt ? <RelativeTime date={v.createdAt} /> : "—"}</TableCell>
                    <TableCell>{versionChange(versions[i + 1], v)}</TableCell>
                    <TableCell className="text-end">
                      {v.version !== undefined && v.version === current ? (
                        <Badge appearance="tint" variant="success">
                          current
                        </Badge>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {next !== null ? (
            <div className="px-inset-lg py-stack-sm">
              <Button size="small" loading={loadingMore} onClick={() => void loadMore()}>
                Load older versions
              </Button>
            </div>
          ) : null}
          {chosen && !before && !next ? <EmptyLine>{versions.length === 1 ? "Only one version: nothing to compare." : "The first version: nothing before it to compare."}</EmptyLine> : null}
          {chosen && before ? (
            <section aria-label={`${tag(before)} to ${tag(chosen)}`} className="flex flex-col border-t border-border-subtle">
              <div className="flex items-center gap-inline-md px-inset-lg py-stack-sm">
                <h3 className="flex-1 text-body-1 text-fg">
                  <span className="text-body-1-strong">
                    {tag(before)} → {tag(chosen)}
                  </span>{" "}
                  config, context and metadata
                </h3>
                <ToggleGroup aria-label="Diff layout" size="small" value={[layout]} onValueChange={(v) => v[0] && setLayout(v[0] as typeof layout)}>
                  <ToggleGroupItem value="side">Side by side</ToggleGroupItem>
                  <ToggleGroupItem value="unified">Unified</ToggleGroupItem>
                </ToggleGroup>
              </div>
              <div className="px-inset-lg pb-stack-md">
                {lines === null ? (
                  <p className="text-body-1 text-fg-muted">These versions' settings were left out for their size, so they are not compared here.</p>
                ) : lines.every((l) => l.kind === "same") ? (
                  <p className="text-body-1 text-fg-muted">No change to config, context or metadata.</p>
                ) : layout === "unified" ? (
                  <DiffView label="Version diff" lines={lines} />
                ) : (
                  <SideBySide lines={lines} />
                )}
              </div>
            </section>
          ) : null}
        </div>
      </ResizablePanel>
      <ResizableHandle />
      <ResizablePanel minSize={20}>
        <div className="flex h-full flex-col gap-stack-sm overflow-auto px-inset-lg py-inset-md">
          <h3 className="text-body-1-strong text-fg">Read only for now</h3>
          <p className="text-body-1 text-fg-muted">Editing an assistant, and making another version current, are Later in DOC-20. The list and the diff come from the server's versions endpoint.</p>
          <div>
            <Button size="small" disabled title="Later (DOC-20)">
              <Icon icon={ArrowUndo} /> Make {older ? tag(older) : "a version"} current
            </Button>
          </div>
        </div>
      </ResizablePanel>
    </Resizable>
  );
}

/** The diff in two columns: before on the left, after on the right. */
function SideBySide({ lines }: { lines: Parameters<typeof sideBySide>[0] }) {
  const rows = sideBySide(lines);
  const cell = (l: (typeof rows)[number]["left"], side: "left" | "right") => (
    <div data-kind={l?.kind ?? "empty"} className={cn("min-w-0 px-inset-xs whitespace-pre-wrap break-all", l?.kind === "removed" && "bg-danger-subtle text-danger-fg", l?.kind === "added" && "bg-success-subtle text-success-fg", side === "right" && "border-s border-border-subtle")}>
      {l ? l.text : " "}
    </div>
  );
  return (
    <div role="group" aria-label="Version diff, side by side" data-slot="diff" className="grid grid-cols-2 overflow-auto rounded-md bg-layer-alt py-inset-xs font-mono text-code text-fg">
      {rows.flatMap((r, i) => [<Fragment key={`l${i}`}>{cell(r.left, "left")}</Fragment>, <Fragment key={`r${i}`}>{cell(r.right, "right")}</Fragment>])}
    </div>
  );
}
