// `nats.streams {}`: the account's streams as a table (`nats.js.streams.list`: name, subjects,
// storage, messages, bytes, consumers, created), a subject to find the streams that take it, and
// New stream. The streams behind KV buckets and object stores show only when asked. The tree's Streams group opens it (DOC-21 Open question 47: §6.2 lists no tab for
// the list itself). JetStream off says so.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { SearchInput } from "@/components/ui/search-input";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { LinkButton, NoticeContext, Page, PageHeader, PageRegion, gutterTable } from "@/app/page";
import { DisconnectedState, EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import { formatCount } from "@/app/messages";
import type { NatsStreamSummary } from "@/gen/api";
import { Add, ArrowClockwise } from "@/lib/icons";
import { cn } from "@/lib/cn";
import type { DescribedError, TabProps } from "../types";
import { StreamSheet } from "./StreamSheet";
import { formatAgo, formatSize } from "./format";
import { validatePattern } from "./profile";
import { isBackingStream, reloadStreams } from "./tree-data";

export function StreamsTab({ tab, profile, connId, client, useTabActions, note, openTab }: TabProps) {
  const notify = useContext(NoticeContext);
  const [streams, setStreams] = useState<NatsStreamSummary[] | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [loading, setLoading] = useState(false);
  const [subject, setSubject] = useState("");
  const [creating, setCreating] = useState(tab.params["create"] === true);
  const [backing, setBacking] = useState(false);
  const generation = useRef(0);
  const subjectProblem = subject.trim() === "" ? null : validatePattern(subject.trim());

  const load = useCallback(async () => {
    if (connId === null || subjectProblem) return;
    const mine = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const list = await client.nats.js.streams.list({ connId, subject: subject.trim() || null });
      if (mine === generation.current) setStreams(list);
    } catch (e) {
      if (mine === generation.current) setError(note(e));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [client, connId, note, subject, subjectProblem]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 250);
    return () => clearTimeout(timer);
  }, [load]);
  useTabActions({ refresh: () => void load(), primary: () => setCreating(true) });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;
  const open = (name: string) => openTab({ kind: "nats.stream", params: { stream: name }, title: name });
  const all = streams ?? [];
  const hidden = all.filter(isBackingStream).length;
  const shown = backing ? all : all.filter((s) => !isBackingStream(s));
  return (
    <Page>
      <PageHeader
        title="Streams"
        subtitle={[profile.name, streams ? `${shown.length} ${shown.length === 1 ? "stream" : "streams"}${subject.trim() ? ` taking ${subject.trim()}` : ""}` : null].filter(Boolean).join(" · ")}
        actions={
          <>
            <Button appearance="subtle" onClick={() => void load()} loading={loading}>
              <Icon icon={ArrowClockwise} /> Refresh
            </Button>
            <Button appearance="primary" onClick={() => setCreating(true)} disabled={error !== null && streams === null}>
              <Icon icon={Add} /> New stream
            </Button>
          </>
        }
      />
      <PageRegion className="mt-stack-md">
        <div className="flex items-center gap-inline-sm px-inset-lg pb-stack-sm">
          <SearchInput aria-label="Streams that take a subject" value={subject} onValueChange={setSubject} placeholder="Streams that take a subject, e.g. orders.eu.created" className="max-w-panel-md font-mono" />
          {subjectProblem ? <span className="text-caption-1 text-danger-fg">{subjectProblem}</span> : null}
          <span className="flex-1" />
          {hidden > 0 || backing ? (
            <label className="flex items-center gap-inline-sm text-body-1 text-fg-muted">
              <Switch checked={backing} onCheckedChange={setBacking} /> Show the {hidden} {hidden === 1 ? "stream" : "streams"} behind KV and Object Store
            </label>
          ) : null}
        </div>
        {error ? (
          <div className="px-inset-lg">
            <ErrorState error={error} onRetry={() => void load()} />
          </div>
        ) : null}
        {streams === null && loading ? <LoadingRows label="Loading the streams" /> : null}
        {streams !== null && shown.length === 0 && !error ? <EmptyLine action={<Button onClick={() => setCreating(true)}>New stream</Button>}>{subject.trim() ? `No stream takes ${subject.trim()}.` : "No streams on this account yet."}</EmptyLine> : null}
        {shown.length > 0 ? (
          <Table aria-label="Streams" className={cn("min-h-0 flex-1", gutterTable)}>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Subjects</TableHead>
                <TableHead>Storage</TableHead>
                <TableHead align="end">Messages</TableHead>
                <TableHead align="end">Bytes</TableHead>
                <TableHead align="end">Consumers</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((s) => (
                <TableRow key={s.name}>
                  <TableCell>
                    <span className="flex items-center gap-inline-sm">
                      <LinkButton className="font-mono" onClick={() => open(s.name)}>
                        {s.name}
                      </LinkButton>
                      {s.sealed ? (
                        <Badge appearance="tint" variant="warning">
                          sealed
                        </Badge>
                      ) : null}
                      {s.mirror ? (
                        <Badge appearance="tint" variant="info">
                          mirror of {s.mirror}
                        </Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono">{s.subjects.join(", ") || "none"}</TableCell>
                  <TableCell>
                    {s.storage} · {s.retention === "workQueue" ? "work queue" : s.retention}
                  </TableCell>
                  <TableCell align="end" className="tabular-nums">
                    {formatCount(s.messages)}
                  </TableCell>
                  <TableCell align="end" className="tabular-nums">
                    {formatSize(s.bytes)}
                  </TableCell>
                  <TableCell align="end" className="tabular-nums">
                    {formatCount(s.consumers)}
                  </TableCell>
                  <TableCell>{formatAgo(s.createdUs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : null}
      </PageRegion>
      <StreamSheet
        open={creating}
        onOpenChange={setCreating}
        profileName={profile.name}
        connId={connId}
        client={client}
        onSaved={(info) => {
          notify({ title: `Created stream ${info.config.name}`, type: "success", action: { label: "Open stream", onClick: () => open(info.config.name) } });
          void load();
          void reloadStreams(connId, client);
        }}
      />
    </Page>
  );
}
