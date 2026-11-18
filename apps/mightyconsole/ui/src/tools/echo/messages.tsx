// The messaging core on echo's test backend (TSK-80, Mightyconsole spec §5.8): a Messages tab (live
// tail of the topic `echo` in the MessageViewer, with the codec selects and the filter bar) and a
// Composer tab (echo.messages.produce). Every echo connection has its own topic with 3 partitions.
import { isRpcError } from "@byterygon/ambidex";
import { useCallback, useMemo, useState } from "react";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { liveTimeout, useServices } from "@/app/client";
import { useStore } from "@/app/store";
import * as api from "@/gen/api";
import { CodecSelect } from "@/messaging/CodecSelect";
import { Composer, type ComposerDraft, type ComposerTemplate, EMPTY_DRAFT, headerInputs, type SchemaChoice } from "@/messaging/Composer";
import { FilterBar } from "@/messaging/FilterBar";
import { MessageViewer } from "@/messaging/MessageViewer";
import { useLiveTail } from "@/messaging/useLiveTail";
import type { ProfileRecord } from "@/profiles/record";
import type { TabProps } from "../types";

const TARGET: api.Target = { kind: "topic", name: "echo" };

/** The profile's local schemas, as the Composer offers them. */
export function schemaChoices(profile: ProfileRecord): SchemaChoice[] {
  const schemas = profile.extras["schemas"];
  if (!Array.isArray(schemas)) return [];
  return schemas.filter((s): s is api.LocalSchema => typeof s === "object" && s !== null && "id" in s && "type" in s).map((s) => ({ id: s.id, name: s.name, type: s.type }));
}

/** An error's field and position (ToolError details), for the Composer and the filter bar. */
export function describeError(e: unknown): { title: string; field?: string; line?: number; column?: number } {
  if (isRpcError(e)) {
    const d = (e.details ?? {}) as { message?: string; field?: string; position?: { line: number; column: number } };
    return { title: d.message ?? e.message, ...(d.field ? { field: d.field } : {}), ...(d.position ? { line: d.position.line, column: d.position.column } : {}) };
  }
  return { title: e instanceof Error ? e.message : String(e) };
}

type StartKind = "earliest" | "latest" | "latestN";

/** `echo.messages`: the topic `echo` in a MessageViewer. */
export function MessagesTab({ connId, client, useTabActions, onLive, note }: TabProps) {
  const services = useServices();
  const { state } = useStore();
  const [decode, setDecode] = useState<api.DecodeOptions>({ key: { codec: "auto" }, value: { codec: "auto" } });
  const [filter, setFilter] = useState<api.Filter>({});
  const [start, setStart] = useState<StartKind>("latestN");
  const [latestN, setLatestN] = useState("100");
  const [follow, setFollow] = useState(true);
  const [push, setPush] = useState(false);
  const open = useMemo(
    () =>
      connId === null
        ? null
        : (streamId: string, resume: readonly api.LastPosition[] | null) =>
            client.echo.messages.tail(
              {
                connId,
                streamId,
                start: resume
                  ? { kind: "offsets", offsets: resume.filter((p) => p.partition !== undefined && p.offset !== undefined).map((p) => ({ partition: p.partition!, offset: String(BigInt(p.offset!) + 1n) })) }
                  : start === "latestN"
                    ? { kind: "latestN", n: Math.max(0, Number.parseInt(latestN, 10) || 0) }
                    : { kind: start },
                follow,
                push,
                decode,
                filter,
                maxScan: null,
                limit: null,
              },
              liveTimeout(api.procedures.echo.messages.tail),
            ),
    [client, connId, start, latestN, follow, push, decode, filter],
  );
  const tail = useLiveTail(services, open, note, onLive);
  useTabActions({ primary: () => tail.start(tail.status === "ended"), stop: tail.stop, pause: tail.pause });
  const check = useCallback((f: api.Filter) => client.messaging.filter.check({ filter: f }), [client]);
  const loadFull = useCallback(
    async (m: { partition: number | null; offset: string | null }) => {
      if (connId === null || m.partition === null || m.offset === null) throw new Error("not connected");
      const full = await client.echo.messages.get({ connId, partition: m.partition, offset: m.offset });
      const s = atob(full.payload);
      return Uint8Array.from(s, (c) => c.charCodeAt(0));
    },
    [client, connId],
  );
  const loadSchema = useCallback(
    async (ref: { schema: api.SchemaRef; messageType: string | null }) => {
      const out = await client.messaging.schemas.inspect({ connId, schema: ref.schema, messageType: ref.messageType });
      return out.text || JSON.stringify(out.jsonSchema, null, 2);
    },
    [client, connId],
  );
  const running = tail.status === "live" || tail.status === "paused";
  const controls = (
    <>
      <div className="flex flex-wrap items-end gap-inline-sm border-b border-border-subtle px-inset-sm py-inset-xs">
        <Field className="w-auto">
          <FieldLabel>Start at</FieldLabel>
          <Select<StartKind>
            size="small"
            disabled={running || push}
            items={[
              { value: "latestN", label: "Latest n per partition" },
              { value: "earliest", label: "Earliest" },
              { value: "latest", label: "Latest (new only)" },
            ]}
            value={start}
            onValueChange={(v) => setStart(v ?? "latestN")}
          >
            <SelectItem value="latestN">Latest n per partition</SelectItem>
            <SelectItem value="earliest">Earliest</SelectItem>
            <SelectItem value="latest">Latest (new only)</SelectItem>
          </Select>
        </Field>
        {start === "latestN" && !push ? (
          <Field className="w-auto">
            <FieldLabel>n</FieldLabel>
            <Input size="small" value={latestN} onValueChange={setLatestN} inputMode="numeric" disabled={running} />
          </Field>
        ) : null}
        <Field className="w-auto">
          <FieldLabel>
            <Switch checked={follow} onCheckedChange={setFollow} disabled={running || push} /> Follow new {push ? "" : "records"}
          </FieldLabel>
        </Field>
        <Field className="w-auto">
          <FieldLabel>
            <Switch checked={push} onCheckedChange={setPush} disabled={running} /> Push-only (as core NATS)
          </FieldLabel>
        </Field>
        <CodecSelect label="Key codec" value={decode.key ?? { codec: "auto" }} onChange={(key) => setDecode((d) => ({ ...d, key }))} />
        <CodecSelect label="Value codec" value={decode.value ?? { codec: "auto" }} onChange={(value) => setDecode((d) => ({ ...d, value }))} />
      </div>
      <FilterBar system="kafka" applied={filter} onApply={setFilter} check={check} />
    </>
  );
  return (
    <MessageViewer
      system="kafka"
      tail={tail}
      maxMessages={state.settings.liveBuffer}
      controls={controls}
      onLoadFull={loadFull}
      loadSchema={loadSchema}
    />
  );
}

/** `echo.compose`: the Composer writing to the topic `echo`. */
export function ComposeTab({ profile, connId, client, useTabActions, updateProfile }: TabProps) {
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);
  const [partition, setPartition] = useState<string>("auto");
  const templates = (Array.isArray(profile.extras["templates"]) ? profile.extras["templates"] : []) as ComposerTemplate[];
  const encode = useCallback((payload: api.ComposePayload) => client.messaging.encode({ connId, target: TARGET, part: "value", payload }), [client, connId]);
  const inspect = useCallback((schema: api.SchemaRef, messageType: string | null) => client.messaging.schemas.inspect({ connId, schema, messageType }), [client, connId]);
  const send = async (d: ComposerDraft) => {
    if (connId === null) throw new Error("Connect the profile first.");
    const out = await client.echo.messages.produce({
      connId,
      partition: partition === "auto" ? null : Number(partition),
      key: d.key,
      headers: headerInputs(d.headers),
      value: d.value,
    });
    return `Written to partition ${out.partition} at offset ${out.offset}, ${out.size.toLocaleString()} bytes${out.schemaRef ? ` (${out.schemaRef})` : ""}.`;
  };
  useTabActions({ primary: () => document.querySelector<HTMLFormElement>("[data-slot=composer]")?.requestSubmit() });
  return (
    <Composer
      target={
        <Field className="w-auto">
          <FieldLabel>Partition of echo</FieldLabel>
          <Select<string>
            items={[{ value: "auto", label: "By key, or round robin" }, ...[0, 1, 2].map((p) => ({ value: String(p), label: `Partition ${p}` }))]}
            value={partition}
            onValueChange={(v) => setPartition(v ?? "auto")}
          >
            <SelectItem value="auto">By key, or round robin</SelectItem>
            {[0, 1, 2].map((p) => (
              <SelectItem key={p} value={String(p)}>
                Partition {p}
              </SelectItem>
            ))}
          </Select>
        </Field>
      }
      withKey
      schemas={schemaChoices(profile)}
      draft={draft}
      onDraftChange={setDraft}
      encode={encode}
      inspect={inspect}
      onSend={send}
      templates={templates}
      describe={describeError}
      {...(updateProfile
        ? {
            onSaveTemplate: (name: string, d: ComposerDraft) =>
              void updateProfile((r) => ({ ...r, extras: { ...r.extras, templates: [...templates.filter((t) => t.name !== name), { id: crypto.randomUUID(), name, draft: d }] } })),
          }
        : {})}
    />
  );
}

