// The store browser (spec §11.2, §11.2.1; laid out as the TSK-91 mockup's langgraph-store by
// TSK-96): the namespaces as a tree with item counts, the items of the selected namespace (key,
// value preview, updated, size) with a semantic query and a filter, the item in a side pane (Edit,
// Copy value, Delete), Put item in a sheet. "Store not available on this server" when it has none.
import { useEffect, useMemo, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { RelativeTime } from "@/components/ui/relative-time";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { SearchInput } from "@/components/ui/search-input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { Tree, type TreeNode } from "@/components/ui/tree";
import { CopyButton, PageHeader, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { Add, ArrowClockwise, Code, Copy, Delete, Folder } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { sizeText } from "./cut-value";
import { JsonField, parseJson, preview, seenKeysSchema, useLoad } from "./shared";

/** "a.b" ↔ ["a", "b"]: the LangGraph store's own way of writing a namespace. */
export const splitNamespace = (s: string) => s.split(".").map((p) => p.trim()).filter(Boolean);
export const joinNamespace = (ns: readonly string[]) => ns.join(".");
/** "users › ana", as the screen writes a namespace. */
export const showNamespace = (ns: readonly string[]) => ns.join(" › ");

/** The tree's node for every namespace. */
const ALL = "*";
/** Items read for the tree's counts: past this, the counts say "+". */
const COUNT_PAGE = 100;

/**
 * The namespaces as a tree: a node per label, each with the items counted under it (those of
 * the counting page; `more` adds "+" when that page was full).
 */
export function namespaceTree(namespaces: readonly (readonly string[])[], counts: ReadonlyMap<string, number>, more: boolean): TreeNode[] {
  type Mutable = { id: string; label: string; children: Mutable[] };
  const root: Mutable[] = [];
  for (const ns of namespaces) {
    let level = root;
    ns.forEach((label, i) => {
      const id = joinNamespace(ns.slice(0, i + 1));
      let node = level.find((n) => n.id === id);
      if (!node) {
        node = { id, label, children: [] };
        level.push(node);
      }
      level = node.children;
    });
  }
  const toNode = (n: Mutable): TreeNode => {
    const count = [...counts].filter(([ns]) => ns === n.id || ns.startsWith(`${n.id}.`)).reduce((sum, [, c]) => sum + c, 0);
    return { id: n.id, label: n.label, icon: <Icon icon={Folder} />, ...(count > 0 ? { meta: `${count}${more ? "+" : ""}` } : {}), ...(n.children.length > 0 ? { children: n.children.map(toNode) } : {}) };
  };
  return root.map(toNode);
}

/** An item's size as compact JSON. */
const itemSize = (item: api.StoreItem) => new TextEncoder().encode(JSON.stringify(item.value) ?? "").length;

export function StoreTab({ profile, connId, client, useTabActions, note }: TabProps) {
  const toast = useToast();
  const namespaces = useLoad(connId ? () => client.langgraph.store.namespaces({ connId, prefix: null, maxDepth: null }) : null, [connId], note);
  // One page of every item, for the tree's counts.
  const counting = useLoad(connId ? () => client.langgraph.store.search({ connId, namespacePrefix: [], query: null, filter: null, limit: COUNT_PAGE, offset: null }) : null, [connId], note);
  const [prefix, setPrefix] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [filterText, setFilterText] = useState("");
  const [applied, setApplied] = useState<{ query: string | null; filter: api.JsonValue | null }>({ query: null, filter: null });
  const items = useLoad(connId ? () => client.langgraph.store.search({ connId, namespacePrefix: prefix, query: applied.query, filter: applied.filter, limit: 100, offset: null }) : null, [connId, prefix, applied], note);
  const [selected, setSelected] = useState<api.StoreItem | null>(null);
  const [putting, setPutting] = useState<{ namespace: string; key: string; value: string } | null>(null);
  const [deleting, setDeleting] = useState<api.StoreItem | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const filter = parseJson(filterText);
  // The value keys of the items listed, as suggestions for the filter (TSK-93).
  const filterSchema = useMemo(() => seenKeysSchema((items.data ?? []).map((i) => i.value)), [items.data]);
  const tree = useMemo(() => {
    const counts = new Map<string, number>();
    for (const i of counting.data ?? []) counts.set(joinNamespace(i.namespace), (counts.get(joinNamespace(i.namespace)) ?? 0) + 1);
    const all: TreeNode = { id: ALL, label: "All namespaces", icon: <Icon icon={Folder} /> };
    return [all, ...namespaceTree(namespaces.data ?? [], counts, (counting.data?.length ?? 0) >= COUNT_PAGE)];
  }, [namespaces.data, counting.data]);

  // Top-level namespaces open as they load; what the user folds stays folded.
  const [expanded, setExpanded] = useState<string[]>([]);
  useEffect(() => setExpanded((e) => [...new Set([...e, ...tree.map((n) => n.id)])]), [tree]);

  const reload = () => {
    void namespaces.reload();
    void counting.reload();
    void items.reload();
  };
  // As in Threads (TSK-94): the parse error shows once Search is asked for, not while typing.
  const [tried, setTried] = useState(false);
  const search = () => {
    setTried(!filter.ok);
    if (filter.ok) setApplied({ query: query.trim() || null, filter: (filter.value ?? null) as api.JsonValue | null });
  };
  useTabActions({ refresh: reload, primary: search });

  const put = async () => {
    if (!connId || !putting) return;
    const value = parseJson(putting.value);
    if (!value.ok) return;
    try {
      await client.langgraph.store.put({ connId, namespace: splitNamespace(putting.namespace), key: putting.key, value: (value.value ?? {}) as api.JsonValue });
      toast.add({ title: `Saved ${putting.key}`, type: "success" });
      setPutting(null);
      reload();
    } catch (e) {
      setError(note(e));
    }
  };
  const remove = async (item: api.StoreItem) => {
    setDeleting(null);
    if (!connId) return;
    try {
      await client.langgraph.store.delete({ connId, namespace: item.namespace, key: item.key });
      toast.add({ title: `Deleted ${item.key}`, type: "success" });
      if (selected?.key === item.key && joinNamespace(selected.namespace) === joinNamespace(item.namespace)) setSelected(null);
      reload();
    } catch (e) {
      setError(note(e));
    }
  };

  // A server without a store answers the namespaces call with an error: say so once.
  const unavailable = namespaces.error && (namespaces.error.kind === "NotFound" || namespaces.error.remoteCode === "404" || namespaces.error.remoteCode === "501");
  const putValue = putting ? parseJson(putting.value) : null;
  const putReady = putting !== null && splitNamespace(putting.namespace).length > 0 && putting.key.trim() !== "" && putValue?.ok === true && typeof putValue.value === "object" && putValue.value !== null && !Array.isArray(putValue.value);
  const count = items.data ? `${items.data.length}${items.data.length >= 100 ? "+" : ""} item${items.data.length === 1 ? "" : "s"}` : null;
  const putNew = () => setPutting({ namespace: joinNamespace(prefix), key: "", value: "{}" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Store"
        subtitle={
          <>
            {profile.name} · {prefix.length === 0 ? "all namespaces" : (
              <>
                namespace <span className="text-body-1-strong text-fg">{showNamespace(prefix)}</span>
              </>
            )}
            {count ? ` · ${count}` : null}
          </>
        }
        actions={
          <>
            <Button appearance="subtle" loading={items.loading} onClick={reload}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="primary" onClick={putNew}>
              <Icon icon={Add} /> Put item
            </Button>
          </>
        }
      />
      {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
      {unavailable ? <EmptyLine>The store is not available on this server.</EmptyLine> : namespaces.error ? <ErrorState error={namespaces.error} onRetry={reload} onRefresh={reload} /> : null}
      <Resizable orientation="horizontal" className="mt-stack-md min-h-0 flex-1 border-t border-border-subtle">
        <ResizablePanel defaultSize={18} minSize={12}>
          <div className="flex h-full min-h-0 flex-col py-inset-sm ps-inset-sm pe-inset-xs">
            {namespaces.loading && !namespaces.data ? <LoadingRows label="Loading namespaces" /> : null}
            <Tree aria-label="Namespaces" nodes={tree} selected={prefix.length === 0 ? ALL : joinNamespace(prefix)} onSelectedChange={(id) => setPrefix(id === ALL ? [] : splitNamespace(id))} expanded={expanded} onExpandedChange={setExpanded} emptyText="No namespaces yet." className="h-full" />
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={30}>
          <div className="flex h-full min-h-0 flex-col">
            <form
              className="flex flex-wrap items-center gap-inline-md px-inset-lg py-stack-md"
              onSubmit={(e) => {
                e.preventDefault();
                search();
              }}
            >
              <SearchInput aria-label="Semantic query" placeholder='Semantic query, e.g. "refund preferences"' value={query} onValueChange={setQuery} className="min-w-panel-xs flex-[2]" />
              <CodeEditor
                singleLine
                language="json"
                aria-label="Filter (JSON)"
                invalid={!filter.ok}
                placeholder='Filter {"tier": "gold"}'
                value={filterText}
                onValueChange={(text) => {
                  setFilterText(text);
                  if (parseJson(text).ok) setTried(false);
                }}
                onSubmit={search}
                jsonSchema={filterSchema}
                className="min-w-panel-xs flex-1"
              />
              <Button type="submit">Search</Button>
            </form>
            {tried && !filter.ok ? <p className="-mt-stack-sm px-inset-lg pb-stack-sm text-caption-1 text-danger-fg">Filter is not valid JSON: {filter.message}</p> : null}
            {items.error && !unavailable ? <ErrorState error={items.error} onRetry={() => void items.reload()} /> : null}
            {items.loading && !items.data ? <LoadingRows label="Loading items" /> : null}
            {items.data?.length === 0 ? (
              <EmptyLine
                action={
                  <Button size="small" onClick={putNew}>
                    Put item
                  </Button>
                }
              >
                No items{prefix.length > 0 ? ` in ${showNamespace(prefix)}` : ""}.
              </EmptyLine>
            ) : null}
            {items.data && items.data.length > 0 ? (
              <div className="min-h-0 flex-1 overflow-auto border-t border-border-subtle">
                <Table aria-label="Items" className={gutterTable}>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Key</TableHead>
                      {prefix.length === 0 ? <TableHead>Namespace</TableHead> : null}
                      <TableHead>Value</TableHead>
                      <TableHead>Updated</TableHead>
                      <TableHead className="text-end">Size</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.data.map((item) => (
                      <TableRow key={`${joinNamespace(item.namespace)}/${item.key}`} aria-selected={selected === item} data-selected={selected === item ? "" : undefined} onClick={() => setSelected(item)}>
                        <TableCell className="font-mono text-code">
                          <span className="flex items-center gap-inline-xs">
                            <button type="button" onClick={() => setSelected(item)}>
                              {item.key}
                            </button>
                            <CopyButton value={item.key} what="key" />
                          </span>
                        </TableCell>
                        {prefix.length === 0 ? <TableCell className="font-mono text-code text-fg-muted">{showNamespace(item.namespace)}</TableCell> : null}
                        <TableCell className="max-w-panel-sm truncate font-mono text-code">{preview(item.value)}</TableCell>
                        <TableCell>{item.updatedAt ? <RelativeTime date={item.updatedAt} /> : null}</TableCell>
                        <TableCell className="text-end tabular-nums">{sizeText(itemSize(item))}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : null}
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize={26} minSize={18}>
          <div className="flex h-full min-h-0 flex-col gap-stack-sm overflow-auto px-inset-lg py-inset-md">
            {selected ? (
              <section aria-label={`Item ${selected.key}`} className="flex flex-col gap-stack-sm">
                <h3 className="flex items-center gap-inline-sm text-body-1-strong text-fg">
                  <span className="font-mono">{selected.key}</span> <CopyButton value={selected.key} what="key" />
                </h3>
                <p className="text-caption-1 text-fg-muted">
                  {showNamespace(selected.namespace)}
                  {selected.createdAt ? (
                    <>
                      {" "}
                      · created <RelativeTime date={selected.createdAt} />
                    </>
                  ) : null}
                  {selected.updatedAt ? (
                    <>
                      {" "}
                      · updated <RelativeTime date={selected.updatedAt} />
                    </>
                  ) : null}
                </p>
                <pre aria-label={`Value of ${selected.key}`} className="max-h-panel-md overflow-auto rounded-md bg-layer-alt p-inset-sm font-mono text-code whitespace-pre-wrap text-fg">
                  {JSON.stringify(selected.value, null, 2)}
                </pre>
                <div className="flex flex-wrap gap-inline-sm">
                  <Button size="small" onClick={() => setPutting({ namespace: joinNamespace(selected.namespace), key: selected.key, value: JSON.stringify(selected.value, null, 2) })}>
                    <Icon icon={Code} /> Edit
                  </Button>
                  <Button
                    size="small"
                    appearance="subtle"
                    onClick={() => {
                      void navigator.clipboard?.writeText(JSON.stringify(selected.value, null, 2));
                      toast.add({ title: `Copied the value of ${selected.key}`, type: "success" });
                    }}
                  >
                    <Icon icon={Copy} /> Copy value
                  </Button>
                  <Button size="small" appearance="subtle" className="text-danger-fg" onClick={() => setDeleting(selected)}>
                    <Icon icon={Delete} /> Delete…
                  </Button>
                </div>
              </section>
            ) : (
              <p className="text-body-1 text-fg-muted">Choose an item to see its value.</p>
            )}
          </div>
        </ResizablePanel>
      </Resizable>
      <Sheet open={putting !== null} onOpenChange={(o) => !o && setPutting(null)}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Put an item</SheetTitle>
            <SheetDescription>Writes the item on {profile.name}, replacing the one with the same key.</SheetDescription>
          </SheetHeader>
          {putting ? (
            <SheetBody className="flex flex-col gap-stack-md">
              <Field invalid={splitNamespace(putting.namespace).length === 0}>
                <FieldLabel>Namespace</FieldLabel>
                <Input value={putting.namespace} onValueChange={(v) => setPutting({ ...putting, namespace: v })} placeholder="users.ana.memories" className="font-mono" />
                <FieldDescription>Labels separated by dots.</FieldDescription>
                {splitNamespace(putting.namespace).length === 0 ? <FieldError match>At least one label.</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel>Key</FieldLabel>
                <Input value={putting.key} onValueChange={(v) => setPutting({ ...putting, key: v })} />
              </Field>
              <JsonField label="Value (a JSON object)" value={putting.value} onChange={(v) => setPutting({ ...putting, value: v })} rows={8} />
            </SheetBody>
          ) : null}
          <SheetFooter>
            <span className="flex-1" />
            <Button onClick={() => setPutting(null)}>Cancel</Button>
            <Button appearance="primary" disabled={!putReady} onClick={() => void put()}>
              Save
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleting?.key} from {deleting ? showNamespace(deleting.namespace) : ""} on {profile.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>The item is deleted from the server's store.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction appearance="danger" onClick={() => deleting && void remove(deleting)}>
              Delete item
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
