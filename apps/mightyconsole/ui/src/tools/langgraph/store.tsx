// The store browser (spec §11.2): namespaces, item search (query, filter), item detail, put and
// delete. "Store not available on this server" when the server has none.
import { useMemo, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Input } from "@/components/ui/input";
import { JsonViewer } from "@/components/ui/json-viewer";
import { RelativeTime } from "@/components/ui/relative-time";
import { Resizable, ResizableHandle, ResizablePanel } from "@/components/ui/resizable";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/components/ui/toast";
import { PageHeader } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { Add, ArrowClockwise, Delete, Folder } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { JsonField, parseJson, preview, seenKeysSchema, useLoad } from "./shared";

/** "a.b" ↔ ["a", "b"]: the LangGraph store's own way of writing a namespace. */
export const splitNamespace = (s: string) => s.split(".").map((p) => p.trim()).filter(Boolean);
export const joinNamespace = (ns: readonly string[]) => ns.join(".");

export function StoreTab({ tab, profile, connId, client, useTabActions, note }: TabProps) {
  const toast = useToast();
  const namespaces = useLoad(connId ? () => client.langgraph.store.namespaces({ connId, prefix: null, maxDepth: null }) : null, [connId], note);
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

  const reload = () => {
    void namespaces.reload();
    void items.reload();
  };
  const search = () => filter.ok && setApplied({ query: query.trim() || null, filter: (filter.value ?? null) as api.JsonValue | null });
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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title="Store"
        subtitle={`${profile.name} · ${prefix.length === 0 ? "all namespaces" : `namespace ${joinNamespace(prefix)}`}`}
        actions={
          <>
            <Button appearance="subtle" loading={items.loading} onClick={reload}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="primary" onClick={() => setPutting({ namespace: joinNamespace(prefix), key: "", value: "{}" })}>
              <Icon icon={Add} /> Put item
            </Button>
          </>
        }
      />
      {error ? <ErrorState error={error} onRetry={() => setError(null)} /> : null}
      {unavailable ? <EmptyLine>The store is not available on this server.</EmptyLine> : namespaces.error ? <ErrorState error={namespaces.error} onRetry={reload} onRefresh={reload} /> : null}
      <Resizable orientation="horizontal" className="mt-stack-md min-h-0 flex-1 border-t border-border-subtle">
        <ResizablePanel defaultSize={22} minSize={14}>
          <nav aria-label="Namespaces" className="flex h-full flex-col gap-stack-xs overflow-auto py-inset-sm ps-inset-sm pe-inset-xs">
            <Button appearance={prefix.length === 0 ? "secondary" : "subtle"} size="small" className="justify-start" onClick={() => setPrefix([])}>
              <Icon icon={Folder} /> All namespaces
            </Button>
            {namespaces.loading && !namespaces.data ? <LoadingRows label="Loading namespaces" /> : null}
            {namespaces.data?.length === 0 ? <EmptyLine>No namespaces yet.</EmptyLine> : null}
            {(namespaces.data ?? []).map((ns) => {
              const name = joinNamespace(ns);
              return (
                <Button key={name} appearance={joinNamespace(prefix) === name ? "secondary" : "subtle"} size="small" className="justify-start font-mono" aria-current={joinNamespace(prefix) === name || undefined} onClick={() => setPrefix(ns)}>
                  {name}
                </Button>
              );
            })}
          </nav>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel minSize={30}>
          <div className="flex h-full min-h-0 flex-col">
            <form
              className="flex flex-wrap items-end gap-inline-md px-inset-lg py-stack-md"
              onSubmit={(e) => {
                e.preventDefault();
                search();
              }}
            >
              <Input aria-label="Search query" placeholder="Query (semantic search, when the store is indexed)" value={query} onValueChange={setQuery} className="min-w-panel-xs flex-1" />
              <CodeEditor
                singleLine
                language="json"
                aria-label="Filter (JSON)"
                invalid={!filter.ok}
                placeholder='Filter, e.g. {"approved": true}'
                value={filterText}
                onValueChange={setFilterText}
                onSubmit={search}
                jsonSchema={filterSchema}
                className="min-w-panel-xs flex-1"
              />
              <Button type="submit" disabled={!filter.ok}>
                Search
              </Button>
            </form>
            {items.error && !unavailable ? <ErrorState error={items.error} onRetry={() => void items.reload()} /> : null}
            {items.loading && !items.data ? <LoadingRows label="Loading items" /> : null}
            {items.data?.length === 0 ? (
              <EmptyLine
                action={
                  <Button size="small" onClick={() => setPutting({ namespace: joinNamespace(prefix), key: "", value: "{}" })}>
                    Put item
                  </Button>
                }
              >
                No items{prefix.length > 0 ? ` in ${joinNamespace(prefix)}` : ""}.
              </EmptyLine>
            ) : null}
            {items.data && items.data.length > 0 ? (
              <Resizable orientation="vertical" className="min-h-0 flex-1">
                <ResizablePanel defaultSize={55} minSize={20}>
                  <Table aria-label="Items" className="h-full">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Namespace</TableHead>
                        <TableHead>Key</TableHead>
                        <TableHead>Value</TableHead>
                        <TableHead>Updated</TableHead>
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.data.map((item) => (
                        <TableRow key={`${joinNamespace(item.namespace)}/${item.key}`} aria-selected={selected === item} data-selected={selected === item ? "" : undefined} onClick={() => setSelected(item)}>
                          <TableCell className="font-mono text-code">{joinNamespace(item.namespace)}</TableCell>
                          <TableCell>
                            <Button appearance="transparent" size="small" onClick={() => setSelected(item)}>
                              {item.key}
                            </Button>
                          </TableCell>
                          <TableCell className="max-w-panel-sm truncate font-mono text-code">{preview(item.value)}</TableCell>
                          <TableCell>{item.updatedAt ? <RelativeTime date={item.updatedAt} /> : null}</TableCell>
                          <TableCell>
                            <IconButton aria-label={`Delete ${item.key}`} size="small" onClick={() => setDeleting(item)}>
                              <Icon icon={Delete} />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ResizablePanel>
                <ResizableHandle />
                <ResizablePanel minSize={20}>
                  <div className="flex h-full min-h-0 flex-col gap-stack-xs p-inset-sm">
                    {selected ? (
                      <>
                        <div className="flex items-center gap-inline-sm">
                          <span className="text-subtitle-2 text-fg">{selected.key}</span>
                          <Button size="small" onClick={() => setPutting({ namespace: joinNamespace(selected.namespace), key: selected.key, value: JSON.stringify(selected.value, null, 2) })}>
                            Edit
                          </Button>
                        </div>
                        <JsonViewer value={selected.value} aria-label={`Value of ${selected.key}`} defaultExpandDepth={2} className="min-h-0 flex-1" />
                      </>
                    ) : (
                      <EmptyLine>Choose an item to see its value.</EmptyLine>
                    )}
                  </div>
                </ResizablePanel>
              </Resizable>
            ) : null}
          </div>
        </ResizablePanel>
      </Resizable>
      <Dialog open={putting !== null} onOpenChange={(o) => !o && setPutting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Put an item</DialogTitle>
            <DialogDescription>Writes the item on {profile.name}, replacing the one with the same key.</DialogDescription>
          </DialogHeader>
          {putting ? (
            <DialogBody className="flex flex-col gap-stack-md">
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
            </DialogBody>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setPutting(null)}>Cancel</Button>
            <Button appearance="primary" disabled={!putReady} onClick={() => void put()}>
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete {deleting?.key} from {deleting ? joinNamespace(deleting.namespace) : ""} on {profile.name}?
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
