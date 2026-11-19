// Create a consumer (§6.4 "Consumer: create (Sheet)", §6.5 pull or push): the name, durable or
// ephemeral, the filter subjects, where delivery starts, the ack policy and wait, the limits, and
// for a push consumer the deliver subject and queue group. The server's error marks its field.
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { MightyClient } from "@/app/client";
import { formatDurationText, parseDuration } from "@/app/duration";
import { Fold, Required } from "@/app/form-parts";
import type { NatsAckPolicy, NatsConsumerConfig, NatsConsumerInfo, NatsDeliverFrom, NatsReplayPolicy } from "@/gen/api";
import { describeError } from "@/messaging/compose-helpers";
import { Add } from "@/lib/icons";
import { SubjectsInput } from "./SubjectsInput";
import { validateSubject } from "./profile";
import { parseCount } from "./stream-form";

export interface ConsumerDraft {
  name: string;
  durable: boolean;
  description: string;
  filterSubjects: string[];
  deliver: NatsDeliverFrom;
  startSequence: string;
  startTime: string;
  ackPolicy: NatsAckPolicy;
  ackWait: string;
  maxDeliver: string;
  maxAckPending: string;
  kind: "pull" | "push";
  maxWaiting: string;
  deliverSubject: string;
  deliverGroup: string;
  inactiveThreshold: string;
  replay: NatsReplayPolicy;
  headersOnly: boolean;
}

export type ConsumerField = keyof ConsumerDraft;

export const EMPTY_CONSUMER: ConsumerDraft = {
  name: "",
  durable: true,
  description: "",
  filterSubjects: [],
  deliver: "all",
  startSequence: "",
  startTime: "",
  ackPolicy: "explicit",
  ackWait: "30s",
  maxDeliver: "",
  maxAckPending: "",
  kind: "pull",
  maxWaiting: "",
  deliverSubject: "",
  deliverGroup: "",
  inactiveThreshold: "",
  replay: "instant",
  headersOnly: false,
};

const DELIVER: Record<NatsDeliverFrom, string> = {
  all: "All: from the first message",
  last: "Last: the last message, then new ones",
  new: "New: only messages stored from now",
  byStartSequence: "From a sequence",
  byStartTime: "From a time",
  lastPerSubject: "Last per subject, then new ones",
};
const ACK: Record<NatsAckPolicy, string> = { explicit: "Explicit: each message", all: "All: a message and those before it", none: "None: no acknowledgements" };

const NAME = /^[^\s.*>/\\]+$/;

export function consumerErrors(d: ConsumerDraft): Partial<Record<ConsumerField, string>> {
  const out: Partial<Record<ConsumerField, string>> = {};
  if (d.name.trim() === "") out.name = "A consumer name is required.";
  else if (!NAME.test(d.name.trim())) out.name = "No spaces and none of . * > / \\";
  if (d.deliver === "byStartSequence") {
    const s = parseCount(d.startSequence);
    if (s === null || Number.isNaN(s) || s < 1) out.startSequence = "A sequence from 1.";
  }
  if (d.deliver === "byStartTime" && (d.startTime === "" || Number.isNaN(Date.parse(d.startTime)))) out.startTime = "A date and time.";
  const wait = parseDuration(d.ackWait);
  if (d.ackPolicy !== "none" && (wait === null || wait === "invalid" || wait === 0)) out.ackWait = "A duration such as 30s or 5m.";
  for (const f of ["maxDeliver", "maxAckPending", "maxWaiting"] as const) {
    const n = parseCount(d[f]);
    if (n !== null && (Number.isNaN(n) || n <= 0)) out[f] = "A whole number above 0, or empty for the default.";
  }
  if (d.kind === "push") {
    if (d.deliverSubject.trim() === "") out.deliverSubject = "A push consumer needs a deliver subject.";
    else {
      const p = validateSubject(d.deliverSubject.trim());
      if (p) out.deliverSubject = p;
    }
  }
  if (!d.durable) {
    const t = parseDuration(d.inactiveThreshold);
    if (t === "invalid" || t === 0) out.inactiveThreshold = "A duration such as 5m, or empty for 5 minutes.";
  }
  return out;
}

export function consumerConfigOf(d: ConsumerDraft): NatsConsumerConfig {
  const n = (t: string) => {
    const v = parseCount(t);
    return v === null || Number.isNaN(v) ? undefined : v;
  };
  const ms = (t: string) => {
    const v = parseDuration(t);
    return v === null || v === "invalid" ? undefined : v;
  };
  const out: NatsConsumerConfig = {
    name: d.name.trim(),
    durable: d.durable,
    filterSubjects: d.filterSubjects,
    deliver: d.deliver,
    ackPolicy: d.ackPolicy,
    ackWaitMs: ms(d.ackWait) ?? 30_000,
    replay: d.replay,
    headersOnly: d.headersOnly,
  };
  const set = <K extends keyof NatsConsumerConfig>(k: K, v: NatsConsumerConfig[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("description", d.description.trim() || undefined);
  if (d.deliver === "byStartSequence") set("startSequence", n(d.startSequence));
  if (d.deliver === "byStartTime") set("startTimeUs", Number.isNaN(Date.parse(d.startTime)) ? undefined : Date.parse(d.startTime) * 1000);
  set("maxDeliver", n(d.maxDeliver));
  set("maxAckPending", n(d.maxAckPending));
  if (d.kind === "pull") set("maxWaiting", n(d.maxWaiting));
  if (d.kind === "push") {
    set("deliverSubject", d.deliverSubject.trim() || undefined);
    set("deliverGroup", d.deliverGroup.trim() || undefined);
  }
  if (!d.durable) set("inactiveThresholdMs", ms(d.inactiveThreshold));
  return out;
}

export interface ConsumerSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  stream: string;
  profileName: string;
  connId: string;
  client: MightyClient;
  onCreated(info: NatsConsumerInfo): void;
}

export function ConsumerSheet({ open, onOpenChange, stream, profileName, connId, client, onCreated }: ConsumerSheetProps) {
  const [d, setD] = useState<ConsumerDraft>(EMPTY_CONSUMER);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<{ title: string; field: string | null } | null>(null);
  useEffect(() => {
    if (!open) return;
    setD(EMPTY_CONSUMER);
    setTried(false);
    setServer(null);
  }, [open]);
  const set = (patch: Partial<ConsumerDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setServer((s) => (s && s.field && s.field in patch ? null : s));
  };
  const errors = consumerErrors(d);
  const fieldOf = (server: string | undefined): string | null => {
    if (!server) return null;
    const map: Record<string, ConsumerField> = { ackWaitMs: "ackWait", startTimeUs: "startTime", inactiveThresholdMs: "inactiveThreshold" };
    return map[server] ?? server;
  };
  const errorOf = (f: ConsumerField): string | null => (server?.field === f ? server.title : tried ? (errors[f] ?? null) : null);
  const save = async () => {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setServer(null);
    try {
      const info = await client.nats.js.consumers.create({ connId, stream, config: consumerConfigOf(d) });
      onCreated(info);
      onOpenChange(false);
    } catch (e) {
      const err = describeError(e);
      setServer({ title: err.title, field: fieldOf(err.field) });
    } finally {
      setBusy(false);
    }
  };
  const text = (f: ConsumerField, label: string, placeholder: string, description?: string, extra: { mono?: boolean; numeric?: boolean } = {}) => (
    <Field invalid={errorOf(f) !== null}>
      <FieldLabel>{label}</FieldLabel>
      <Input
        value={d[f] as string}
        onValueChange={(v) => set({ [f]: v } as Partial<ConsumerDraft>)}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        {...(extra.mono ? { className: "font-mono" } : {})}
        {...(extra.numeric ? { inputMode: "numeric" as const } : {})}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {errorOf(f) ? <FieldError match>{errorOf(f)}</FieldError> : null}
    </Field>
  );
  const ackLine = d.ackPolicy === "none" ? "no acks" : `ack ${d.ackPolicy}, wait ${d.ackWait || "30s"}${d.maxDeliver ? `, max deliver ${d.maxDeliver}` : ""}`;
  const deliveryLine = d.kind === "push" ? `push to ${d.deliverSubject || "…"}${d.deliverGroup ? ` (group ${d.deliverGroup})` : ""}` : `pull${d.maxWaiting ? `, ${d.maxWaiting} waiting pulls` : ""}`;
  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent className="max-w-panel-sheet">
        <SheetHeader>
          <SheetTitle>New consumer of {stream}</SheetTitle>
          <SheetDescription>{profileName}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="consumer-form"
            aria-label="New consumer"
            className="flex flex-col gap-stack-lg"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
              <Field invalid={errorOf("name") !== null}>
                <FieldLabel>
                  Name
                  <Required />
                </FieldLabel>
                <Input value={d.name} onValueChange={(name) => set({ name })} autoComplete="off" spellCheck={false} className="font-mono" placeholder="billing" />
                {errorOf("name") ? <FieldError match>{errorOf("name")}</FieldError> : null}
              </Field>
              <Field>
                <FieldLabel>
                  <Switch checked={d.durable} onCheckedChange={(durable) => set({ durable })} /> Durable
                </FieldLabel>
                <FieldDescription>{d.durable ? "It stays, with its position, until it is deleted." : "It goes once no client has used it for the inactive threshold."}</FieldDescription>
              </Field>
              <div className="col-span-2">
                <SubjectsInput label="Filter subjects" value={d.filterSubjects} onChange={(filterSubjects) => set({ filterSubjects })} placeholder="All the stream's subjects" />
              </div>
              <Field>
                <FieldLabel>Deliver</FieldLabel>
                <Select<NatsDeliverFrom> items={(Object.keys(DELIVER) as NatsDeliverFrom[]).map((v) => ({ value: v, label: DELIVER[v] }))} value={d.deliver} onValueChange={(deliver) => set({ deliver: deliver ?? "all" })}>
                  {(Object.keys(DELIVER) as NatsDeliverFrom[]).map((v) => (
                    <SelectItem key={v} value={v}>
                      {DELIVER[v]}
                    </SelectItem>
                  ))}
                </Select>
              </Field>
              {d.deliver === "byStartSequence" ? text("startSequence", "Start sequence", "1", undefined, { mono: true, numeric: true }) : null}
              {d.deliver === "byStartTime" ? (
                <Field invalid={errorOf("startTime") !== null}>
                  <FieldLabel>Start time</FieldLabel>
                  <Input type="datetime-local" step={1} value={d.startTime} onValueChange={(startTime) => set({ startTime })} />
                  {errorOf("startTime") ? <FieldError match>{errorOf("startTime")}</FieldError> : null}
                </Field>
              ) : null}
            </div>
            <Fold title="Acknowledgements" value={ackLine} open>
              <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
                <Field>
                  <FieldLabel>Ack policy</FieldLabel>
                  <Select<NatsAckPolicy> items={(Object.keys(ACK) as NatsAckPolicy[]).map((v) => ({ value: v, label: ACK[v] }))} value={d.ackPolicy} onValueChange={(ackPolicy) => set({ ackPolicy: ackPolicy ?? "explicit" })}>
                    {(Object.keys(ACK) as NatsAckPolicy[]).map((v) => (
                      <SelectItem key={v} value={v}>
                        {ACK[v]}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
                {d.ackPolicy !== "none" ? text("ackWait", "Ack wait", "30s", "Unacknowledged after it, a message is delivered again.") : <span />}
                {text("maxDeliver", "Max deliver", "No limit", "Deliveries of one message, the first included.", { numeric: true })}
                {text("maxAckPending", "Max ack pending", "Server default", "Delivered and not acknowledged at once.", { numeric: true })}
              </div>
            </Fold>
            <Fold title="Delivery" value={deliveryLine} open={d.kind === "push"}>
              <ToggleGroup aria-label="Pull or push" value={[d.kind]} onValueChange={(v) => v[0] && set({ kind: v[0] as ConsumerDraft["kind"] })}>
                <ToggleGroupItem value="pull">Pull</ToggleGroupItem>
                <ToggleGroupItem value="push">Push</ToggleGroupItem>
              </ToggleGroup>
              <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
                {d.kind === "pull" ? text("maxWaiting", "Max waiting pulls", "Server default", undefined, { numeric: true }) : null}
                {d.kind === "push" ? text("deliverSubject", "Deliver subject", "deliver.billing", "Where the server sends the messages.", { mono: true }) : null}
                {d.kind === "push" ? text("deliverGroup", "Queue group", "None", "Clients of the group share the messages.", { mono: true }) : null}
                {!d.durable ? text("inactiveThreshold", "Inactive threshold", formatDurationText(300_000), "Deleted after this long without a client.") : null}
              </div>
            </Fold>
            <Fold title="Options" value={`replay ${d.replay}${d.headersOnly ? " · headers only" : ""}`}>
              <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
                <Field>
                  <FieldLabel>Replay</FieldLabel>
                  <ToggleGroup aria-label="Replay" value={[d.replay]} onValueChange={(v) => v[0] && set({ replay: v[0] as NatsReplayPolicy })}>
                    <ToggleGroupItem value="instant">Instant</ToggleGroupItem>
                    <ToggleGroupItem value="original">Original pace</ToggleGroupItem>
                  </ToggleGroup>
                </Field>
                <Field>
                  <FieldLabel>
                    <Switch checked={d.headersOnly} onCheckedChange={(headersOnly) => set({ headersOnly })} /> Headers only
                  </FieldLabel>
                  <FieldDescription>Deliver the headers and the size, not the payload.</FieldDescription>
                </Field>
              </div>
            </Fold>
          </form>
          {server ? (
            <Alert intent="danger" className="mt-stack-md">
              <AlertDescription>
                {server.field ? <strong className="font-mono">{server.field}: </strong> : null}
                {server.title}
              </AlertDescription>
            </Alert>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button appearance="primary" type="submit" form="consumer-form" loading={busy}>
            <Icon icon={Add} /> Create consumer
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
