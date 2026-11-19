// `temporal.taskQueue { namespace, name }` (Mightyconsole spec §9.3): the workflow and activity
// pollers of a task queue (who is polling, when they last did, at what rate) and its backlog when
// the server reports it. With no name yet, it asks for one.
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CopyButton, Page, PageHeader } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { Poller, TaskQueueDescription } from "@/gen/api";
import { ArrowClockwise, Search } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { formatTime } from "./format";

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export function TaskQueueTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
  const namespace = text(tab.params["namespace"]) || "default";
  const name = text(tab.params["name"]);
  const [typed, setTyped] = useState(name);
  const [description, setDescription] = useState<TaskQueueDescription | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

  const load = useCallback(async () => {
    if (connId === null || name === "") return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const d = await client.temporal.taskQueues.describe({ connId, namespace, taskQueue: name });
      if (mine === generation.current) setDescription(d);
    } catch (e) {
      if (mine === generation.current) {
        setDescription(null);
        setError(note(e));
      }
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, namespace, name, note]);

  useEffect(() => {
    void load();
  }, [load]);
  useTabActions({ refresh: () => void load() });

  if (name === "") {
    return (
      <form
        className="flex max-w-panel-md flex-col gap-stack-md p-inset-md"
        onSubmit={(e) => {
          e.preventDefault();
          const n = typed.trim();
          if (n) openTab({ kind: "temporal.taskQueue", params: { namespace, name: n }, title: n });
        }}
      >
        <Field>
          <FieldLabel>Task queue</FieldLabel>
          <Input value={typed} onValueChange={setTyped} placeholder="orders" autoComplete="off" spellCheck={false} />
        </Field>
        <div>
          <Button type="submit" appearance="primary" disabled={typed.trim() === ""}>
            <Icon icon={Search} /> Look up
          </Button>
        </div>
        <EmptyLine>Open a workflow to reach its task queue, or type a name.</EmptyLine>
      </form>
    );
  }

  return (
    <Page>
      <PageHeader
        title={name}
        adornment={<CopyButton value={name} what="task queue name" />}
        subtitle={`Task queue · ${profile.name} · namespace ${namespace}`}
        actions={
          <Button appearance="subtle" onClick={() => void load()}>
            <Icon icon={ArrowClockwise} /> Refresh
          </Button>
        }
      />
      {error ? <ErrorState error={error} onRetry={() => void load()} /> : null}
      {loading && description === null ? <LoadingRows label="Loading the task queue" /> : null}
      {description ? (
        <div className="mt-stack-md flex min-h-0 flex-1 flex-col gap-stack-lg overflow-auto border-t border-border-subtle px-inset-lg py-inset-md">
          <PollerTable title="Workflow pollers" pollers={description.workflowPollers} backlog={description.workflowBacklog} />
          <PollerTable title="Activity pollers" pollers={description.activityPollers} backlog={description.activityBacklog} />
        </div>
      ) : null}
    </Page>
  );
}

function PollerTable({ title, pollers, backlog }: { title: string; pollers: Poller[]; backlog: number | undefined }) {
  return (
    <section className="flex flex-col gap-stack-xs pb-inset-md">
      <h3 className="flex items-center gap-inline-sm text-body-1-strong text-fg">
        {title} ({pollers.length})
        {backlog !== undefined ? <Badge appearance="tint" variant={backlog > 0 ? "warning" : "neutral"}>{formatCount(backlog)} waiting</Badge> : null}
      </h3>
      {pollers.length === 0 ? (
        <EmptyLine>No worker is polling this task queue.</EmptyLine>
      ) : (
        <Table aria-label={title}>
          <TableHeader>
            <TableRow>
              <TableHead>Identity</TableHead>
              <TableHead>Last access</TableHead>
              <TableHead align="end">Rate per second</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pollers.map((p) => (
              <TableRow key={p.identity}>
                <TableCell>{p.identity}</TableCell>
                <TableCell>{formatTime(p.lastAccessTime)}</TableCell>
                <TableCell align="end">{p.ratePerSecond > 0 ? p.ratePerSecond.toFixed(2) : ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
