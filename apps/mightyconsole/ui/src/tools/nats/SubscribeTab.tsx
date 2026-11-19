// `nats.subscribe { subjects, queueGroup? }` (Mightyconsole spec §6.3 "Subscribe", mockup frame
// nats-subscribe): subjects and patterns as tags with the profile's bookmarks, an optional queue
// group, then the messaging core's MessageViewer in live tail with the value codec and the filter
// bar. Core NATS is push only: while paused the server buffers, then drops the oldest and counts
// them, and a subscription cannot replay, so Restart starts from now.
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Page, PageBar, PageHeader, PageRegion } from "@/app/page";
import { liveTimeout, useServices } from "@/app/client";
import { DisconnectedState, LiveBadge } from "@/app/states";
import { useStore } from "@/app/store";
import * as api from "@/gen/api";
import { Star } from "@/lib/icons";
import { CodecSelect } from "@/messaging/CodecSelect";
import { FilterBar } from "@/messaging/FilterBar";
import { MessageViewer } from "@/messaging/MessageViewer";
import { useLiveTail } from "@/messaging/useLiveTail";
import type { TabProps } from "../types";
import { bookmarksOf } from "./profile";
import { SubjectsInput } from "./SubjectsInput";

/** The tab's title: "Subscribe orders.>", "Subscribe orders.> +1". */
export function subscribeTitle(params: Record<string, unknown>): string {
  const subjects = subjectsOf(params);
  if (subjects.length === 0) return "Subscribe";
  return `Subscribe ${subjects[0]}${subjects.length > 1 ? ` +${subjects.length - 1}` : ""}`;
}

export function subjectsOf(params: Record<string, unknown>): string[] {
  const raw = params["subjects"];
  return Array.isArray(raw) ? raw.filter((s): s is string => typeof s === "string" && s !== "") : [];
}

export function SubscribeTab({ tab, profile, connId, client, useTabActions, onLive, note, updateProfile }: TabProps) {
  const services = useServices();
  const { state } = useStore();
  const [subjects, setSubjects] = useState<string[]>(() => subjectsOf(tab.params));
  const [queueGroup, setQueueGroup] = useState(() => (typeof tab.params["queueGroup"] === "string" ? tab.params["queueGroup"] : ""));
  const [decode, setDecode] = useState<api.DecodeOptions>({ key: { codec: "auto" }, value: { codec: "auto" } });
  const [filter, setFilter] = useState<api.Filter>({});
  const bookmarks = bookmarksOf(profile.extras);
  const open = useMemo(
    () =>
      connId === null || subjects.length === 0
        ? null
        : (streamId: string) =>
            client.nats.core.subscribe(
              { connId, streamId, subjects, queueGroup: queueGroup.trim() || null, decode, filter, maxScan: null, limit: null },
              liveTimeout(api.procedures.nats.core.subscribe),
            ),
    [client, connId, subjects, queueGroup, decode, filter],
  );
  const tail = useLiveTail(services, open, note, onLive);
  // Core NATS cannot replay: Restart is a new subscription from now.
  useTabActions({ primary: () => tail.start(false), stop: tail.stop, pause: tail.pause });
  const check = useCallback((f: api.Filter) => client.messaging.filter.check({ filter: f }), [client]);
  const loadSchema = useCallback(
    async (ref: { schema: api.SchemaRef; messageType: string | null }) => {
      const out = await client.messaging.schemas.inspect({ connId, schema: ref.schema, messageType: ref.messageType });
      return out.text || JSON.stringify(out.jsonSchema, null, 2);
    },
    [client, connId],
  );
  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const running = tail.status === "live" || tail.status === "paused";
  const unsaved = subjects.filter((s) => !bookmarks.includes(s));
  const p = tail.progress;
  const live = tail.status === "idle" ? null : tail.status === "ended" ? { status: "ended" as const } : { status: tail.status, ...(p ? { ratePerSec: p.ratePerSec, dropped: p.dropped } : {}) };
  const subtitle = [
    profile.name,
    subjects.length > 0 ? subjects.join(", ") : "no subjects yet",
    queueGroup.trim() ? `queue group ${queueGroup.trim()}` : "no queue group",
    p ? `${p.scanned.toLocaleString()} received` : null,
    p && p.dropped > 0 ? `${p.dropped.toLocaleString()} dropped while paused` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const controls = (
    <div className="flex flex-wrap items-end gap-inline-sm border-b border-border-subtle px-inset-sm py-inset-xs">
      <CodecSelect label="Value codec" value={decode.value ?? { codec: "auto" }} onChange={(value) => setDecode((d) => ({ ...d, value }))} />
    </div>
  );
  return (
    <Page>
      <PageHeader
        title="Subscribe"
        adornment={live ? <LiveBadge live={live} /> : null}
        subtitle={subtitle}
        actions={
          updateProfile ? (
            <Button
              appearance="subtle"
              disabled={unsaved.length === 0}
              onClick={() => void updateProfile((r) => ({ ...r, extras: { ...r.extras, subjects: [...bookmarksOf(r.extras), ...unsaved.filter((s) => !bookmarksOf(r.extras).includes(s))] } }))}
            >
              <Icon icon={Star} /> Bookmark {unsaved.length === 1 ? "subject" : "subjects"}
            </Button>
          ) : null
        }
      />
      <PageBar aria-label="Subscription">
        <SubjectsInput label="Subjects" value={subjects} onChange={setSubjects} suggestions={bookmarks} disabled={running} />
        <Field className="w-auto">
          <FieldLabel>Queue group</FieldLabel>
          <Input size="small" value={queueGroup} onValueChange={setQueueGroup} placeholder="Optional" disabled={running} autoComplete="off" spellCheck={false} />
        </Field>
      </PageBar>
      <PageRegion>
        <FilterBar system="nats" applied={filter} onApply={setFilter} check={check} />
        <MessageViewer system="nats" tail={tail} maxMessages={state.settings.liveBuffer} controls={controls} onLoadFull={null} loadSchema={loadSchema} />
        <p className="border-t border-border-subtle px-inset-lg py-stack-sm text-caption-1 text-fg-muted">
          {subjects.length === 0 ? "Add a subject or a pattern (orders.*, orders.>), then Start." : "Core NATS cannot replay: messages before Start are not shown. For stored messages, browse a stream."}
        </p>
      </PageRegion>
    </Page>
  );
}
