// The Queries tab of a workflow (Mightyconsole spec §9.3): a query type (suggestions from the
// worker's `__temporal_workflow_metadata` when the SDK offers it), JSON arguments, Run, and the
// decoded result. A query never changes the workflow.
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { JsonViewer } from "@/components/ui/json-viewer";
import { EmptyLine, ErrorState } from "@/app/states";
import type { MightyClient } from "@/app/client";
import { Play } from "@/lib/icons";
import type { DescribedError } from "../types";
import { ArgsField, parseArgs } from "./ActionDialogs";

/** The query names a metadata answer lists (`definition.queryDefinitions[].name`), else none. */
export function queryNamesOf(metadata: unknown): string[] {
  const definition = (metadata as { definition?: { queryDefinitions?: unknown } } | null)?.definition;
  const defs = definition?.queryDefinitions;
  if (!Array.isArray(defs)) return [];
  return defs.flatMap((d): string[] => (typeof d === "object" && d !== null && typeof (d as { name?: unknown }).name === "string" ? [(d as { name: string }).name] : []));
}

export interface QueriesPanelProps {
  client: MightyClient;
  connId: string | null;
  namespace: string;
  workflowId: string;
  runId: string;
  /** Registers Mod+Enter. */
  active: boolean;
  note(error: unknown): DescribedError;
}

export function QueriesPanel({ client, connId, namespace, workflowId, runId, active, note }: QueriesPanelProps) {
  const [type, setType] = useState("");
  const [args, setArgs] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [result, setResult] = useState<{ value: unknown } | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();

  // Suggestions, once, when the tab is first shown; a worker that does not know the metadata query
  // answers with an error, which only means there are no suggestions.
  useEffect(() => {
    if (!active || connId === null || names.length > 0) return;
    let live = true;
    client.temporal.workflows.query({ connId, namespace, workflowId, runId, queryType: "__temporal_workflow_metadata" }).then(
      (out) => live && setNames(queryNamesOf(out.result)),
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, connId]);

  const parsed = parseArgs(args);
  const run = async () => {
    if (connId === null || type.trim() === "" || "error" in parsed) return;
    setBusy(true);
    setError(null);
    try {
      const out = await client.temporal.workflows.query({ connId, namespace, workflowId, runId, queryType: type.trim(), args: parsed.args });
      setResult({ value: out.result });
    } catch (e) {
      setResult(null);
      setError(note(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-stack-md"
      onSubmit={(e) => {
        e.preventDefault();
        void run();
      }}
    >
      <Field>
        <FieldLabel>Query type</FieldLabel>
        <Input value={type} onValueChange={setType} list={listId} placeholder="status" autoComplete="off" spellCheck={false} />
        <datalist id={listId}>
          {["__stack_trace", ...names.filter((n) => n !== "__stack_trace")].map((n) => (
            <option key={n} value={n} />
          ))}
        </datalist>
      </Field>
      <ArgsField value={args} onChange={setArgs} onSubmit={() => void run()} />
      <div>
        <Button type="submit" appearance="primary" loading={busy} disabled={type.trim() === "" || "error" in parsed}>
          <Icon icon={Play} /> Run query
        </Button>
      </div>
      {error ? <ErrorState error={error} onRetry={() => void run()} /> : null}
      {result ? <JsonViewer value={result.value} defaultExpandDepth={3} aria-label="Query result" className="max-h-panel-md" /> : error ? null : <EmptyLine>The result shows here.</EmptyLine>}
    </form>
  );
}
