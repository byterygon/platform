// A stream's Messages (§6.3 "Stream", mockup frame nats-stream-messages): browse from the first
// message, the last n, a sequence or a time, with an optional subject filter and Follow, in the
// messaging core's MessageViewer with its codec selects and filter bar. An ordered ephemeral
// consumer reads it (no acks); it stops at the last sequence there was at the start unless Follow
// is on. A payload over 1 MiB loads in full through `getMessage` (direct get).
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { liveTimeout, useServices, type MightyClient } from "@/app/client";
import { PageFooter } from "@/app/page";
import { useStore } from "@/app/store";
import * as api from "@/gen/api";
import { CodecMenu } from "@/messaging/schemas/CodecMenu";
import { FilterBar } from "@/messaging/FilterBar";
import { MessageViewer } from "@/messaging/MessageViewer";
import { useLiveTail } from "@/messaging/useLiveTail";
import { Play } from "@/lib/icons";
import type { DescribedError, LiveState } from "../types";
import { formatCount } from "@/app/messages";
import { validatePattern } from "./profile";
import { parseCount } from "./stream-form";
import type { ViewDecoding } from "./SchemasTab";

/** A browse without Follow ends by itself; 5 minutes is its default limit (§6.5). */
export const BROWSE_TIMEOUT_MS = 5 * 60_000;

export type BrowseFrom = api.NatsBrowseFrom;

export interface BrowseDraft {
  from: BrowseFrom;
  n: string;
  sequence: string;
  /** `datetime-local` text, in the browser's time zone. */
  time: string;
  subject: string;
  follow: boolean;
}

export const DEFAULT_BROWSE: BrowseDraft = { from: "last", n: "1000", sequence: "", time: "", subject: "", follow: false };

/** The browse's start, or why it cannot start. */
export function browseStart(d: BrowseDraft): { start: api.NatsBrowseStart } | { error: string } {
  switch (d.from) {
    case "first":
      return { start: { from: "first" } };
    case "last": {
      const n = parseCount(d.n);
      if (n === null || Number.isNaN(n) || n < 1) return { error: "How many of the last messages: a number from 1." };
      return { start: { from: "last", n } };
    }
    case "sequence": {
      const s = parseCount(d.sequence);
      if (s === null || Number.isNaN(s) || s < 1) return { error: "A sequence from 1." };
      return { start: { from: "sequence", sequence: s } };
    }
    case "time": {
      const ms = Date.parse(d.time);
      if (d.time === "" || Number.isNaN(ms)) return { error: "A date and time to start from." };
      return { start: { from: "time", timeUs: ms * 1000 } };
    }
  }
}

export interface StreamMessagesProps {
  /** The tab is shown and this is its view: a hidden one holds its live tail (TSK-107). */
  active: boolean;
  stream: string;
  lastSequence: number | null;
  connId: string;
  client: MightyClient;
  note(error: unknown): DescribedError;
  onLive(live: LiveState | null): void;
  /** The subject filter to start with (from Info's busiest subjects). */
  subject?: string;
  registerActions(actions: { primary: () => void; stop: () => void; pause: () => void }): void;
  /** The codec menu's schemas and "Decode as…" (the tab's profile). */
  decoding?: ViewDecoding;
}

export function StreamMessages({ stream, lastSequence, connId, client, note, onLive, subject: initialSubject, registerActions, decoding, active }: StreamMessagesProps) {
  const services = useServices();
  const { state } = useStore();
  const [draft, setDraft] = useState<BrowseDraft>({ ...DEFAULT_BROWSE, subject: initialSubject ?? "" });
  const [decode, setDecode] = useState<api.DecodeOptions>({ value: { codec: "auto" } });
  const [filter, setFilter] = useState<api.Filter>({});
  const set = (patch: Partial<BrowseDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const start = browseStart(draft);
  const subjectProblem = draft.subject.trim() === "" ? null : validatePattern(draft.subject.trim());
  const open = useMemo(
    () =>
      "error" in start || subjectProblem
        ? null
        : (streamId: string, resume: readonly api.LastPosition[] | null) => {
            const last = resume?.find((p) => p.sequence !== undefined)?.sequence;
            return client.nats.js.streams.browse(
              {
                connId,
                streamId,
                stream,
                start: last !== undefined ? { from: "sequence", sequence: Number(BigInt(last) + 1n) } : start.start,
                subject: draft.subject.trim() || null,
                follow: draft.follow,
                decode,
                filter,
              },
              draft.follow ? liveTimeout(api.procedures.nats.js.streams.browse) : { timeoutMs: BROWSE_TIMEOUT_MS },
            );
          },
    // `start` is derived from the draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- start follows draft
    [client, connId, stream, draft, decode, filter, subjectProblem],
  );
  const tail = useLiveTail(services, open, note, onLive, active);
  registerActions({ primary: () => tail.start(tail.status === "ended"), stop: tail.stop, pause: tail.pause });
  const check = useCallback((f: api.Filter) => client.messaging.filter.check({ filter: f }), [client]);
  const loadFull = useCallback(
    async (m: { sequence: string | null }) => {
      if (m.sequence === null) throw new Error("This message has no sequence.");
      const full = await client.nats.js.streams.getMessage({ connId, stream, sequence: Number(m.sequence), decode });
      const s = atob(full.payloadRaw);
      return Uint8Array.from(s, (c) => c.charCodeAt(0));
    },
    [client, connId, stream, decode],
  );
  const loadSchema = useCallback(
    async (ref: { schema: api.SchemaRef; messageType: string | null }) => {
      const out = await client.messaging.schemas.inspect({ connId, schema: ref.schema, messageType: ref.messageType });
      return out.text || JSON.stringify(out.jsonSchema, null, 2);
    },
    [client, connId],
  );
  const running = tail.status === "live" || tail.status === "paused";
  const problem = "error" in start ? start.error : subjectProblem ? `Subject filter: ${subjectProblem}` : null;
  const stopsAt = lastSequence !== null && lastSequence > 0 ? `it stops at seq ${formatCount(lastSequence)} unless Follow is on` : "it ends at the last message unless Follow is on";
  const controls = (
    <>
      <div className="flex flex-wrap items-end gap-inline-sm border-b border-border-subtle px-inset-sm py-inset-xs" aria-label="Browse">
        <Field className="w-auto">
          <FieldLabel>From</FieldLabel>
          <ToggleGroup aria-label="Browse from" size="small" value={[draft.from]} onValueChange={(v) => v[0] && set({ from: v[0] as BrowseFrom })} disabled={running}>
            <ToggleGroupItem value="first">First</ToggleGroupItem>
            <ToggleGroupItem value="last">Last n</ToggleGroupItem>
            <ToggleGroupItem value="sequence">Sequence</ToggleGroupItem>
            <ToggleGroupItem value="time">Time</ToggleGroupItem>
          </ToggleGroup>
        </Field>
        {draft.from === "last" ? (
          <Field className="w-auto">
            <FieldLabel>n</FieldLabel>
            <Input size="small" className="w-control-lg font-mono" value={draft.n} onValueChange={(n) => set({ n })} inputMode="numeric" disabled={running} />
          </Field>
        ) : null}
        {draft.from === "sequence" ? (
          <Field className="w-auto">
            <FieldLabel>Sequence</FieldLabel>
            <Input size="small" className="font-mono" value={draft.sequence} onValueChange={(sequence) => set({ sequence })} inputMode="numeric" placeholder="1" disabled={running} />
          </Field>
        ) : null}
        {draft.from === "time" ? (
          <Field className="w-auto">
            <FieldLabel>Stored at or after</FieldLabel>
            <Input size="small" type="datetime-local" step={1} value={draft.time} onValueChange={(time) => set({ time })} disabled={running} />
          </Field>
        ) : null}
        <Field className="w-auto" invalid={subjectProblem !== null}>
          <FieldLabel>Subject filter</FieldLabel>
          <Input size="small" className="font-mono" value={draft.subject} onValueChange={(subject) => set({ subject })} placeholder="e.g. orders.paid" autoComplete="off" spellCheck={false} disabled={running} />
        </Field>
        <Field className="w-auto">
          <FieldLabel>
            <Switch checked={draft.follow} onCheckedChange={(follow) => set({ follow })} disabled={running} /> Follow
          </FieldLabel>
        </Field>
        <CodecMenu label="Value codec" value={decode.value ?? { codec: "auto" }} onChange={(value) => setDecode((d) => ({ ...d, value }))} schemas={decoding?.choices ?? []} onManage={decoding?.onManage} />
        <span className="flex-1" />
        <Button size="small" appearance="primary" disabled={problem !== null || running} onClick={() => tail.start()}>
          <Icon icon={Play} /> Browse
        </Button>
      </div>
      {problem ? (
        <p role="alert" className="px-inset-sm py-inset-xs text-caption-1 text-danger-fg">
          {problem}
        </p>
      ) : null}
      <FilterBar system="jetstream" applied={filter} onApply={setFilter} check={check} />
    </>
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <MessageViewer system="jetstream" tail={tail} maxMessages={state.settings.liveBuffer} controls={controls} onLoadFull={loadFull} loadSchema={loadSchema} {...(decoding?.decodeAs ? { decodeAs: decoding.decodeAs } : {})} />
      <PageFooter>
        <span>Ordered consumer, no acks; {stopsAt}.</span>
      </PageFooter>
    </div>
  );
}
