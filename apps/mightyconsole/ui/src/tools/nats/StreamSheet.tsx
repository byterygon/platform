// Create or edit a stream (§6.3 "Stream form", §6.4; mockup frame nats-stream-form): name,
// subjects as tags, storage, retention, then Limits open and Replication and Options folded with
// their values. On edit, what the server cannot change after creation is read only with a lock
// and says so. The server's error marks the field it names and keeps the rest of the form.
import { useSheetGuard } from "@/app/leave-guard";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { MightyClient } from "@/app/client";
import { Fold, Required } from "@/app/form-parts";
import type { NatsStreamConfig, NatsStreamInfo } from "@/gen/api";
import { describeError } from "@/messaging/compose-helpers";
import { Code, LockClosed, Save } from "@/lib/icons";
import { SubjectsInput } from "./SubjectsInput";
import { EMPTY_STREAM, FIXED_AFTER_CREATE, configOf, draftField, draftOf, streamErrors, type StreamDraft, type StreamField } from "./stream-form";

export interface StreamSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The stream being edited; absent to create one. */
  stream?: NatsStreamConfig;
  profileName: string;
  connId: string;
  client: MightyClient;
  onSaved(info: NatsStreamInfo): void;
}

function Locked({ on }: { on: boolean }) {
  return on ? <Icon icon={LockClosed} size="sm" className="text-fg-muted" aria-label="Fixed after creation" /> : null;
}

export function StreamSheet({ open, onOpenChange, stream, profileName, connId, client, onSaved }: StreamSheetProps) {
  const editing = stream !== undefined;
  const [d, setD] = useState<StreamDraft>(EMPTY_STREAM);
  const releaseGuard = useSheetGuard(open, d);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<{ title: string; field: StreamField | null } | null>(null);
  const [asJson, setAsJson] = useState(false);
  useEffect(() => {
    if (!open) return;
    setD(stream ? draftOf(stream) : EMPTY_STREAM);
    setTried(false);
    setServer(null);
    setAsJson(false);
  }, [open, stream]);
  const set = (patch: Partial<StreamDraft>) => {
    setD((x) => ({ ...x, ...patch }));
    setServer((s) => (s && s.field && s.field in patch ? null : s));
  };
  const errors = streamErrors(d);
  const fixed = (f: StreamField) => editing && FIXED_AFTER_CREATE.includes(f);
  const errorOf = (f: StreamField): string | null => (server?.field === f ? server.title : tried ? (errors[f] ?? null) : null);
  const config = configOf(d, stream);

  const save = async () => {
    setTried(true);
    if (Object.keys(errors).length > 0) return;
    setBusy(true);
    setServer(null);
    try {
      const info = editing ? await client.nats.js.streams.update({ connId, config }) : await client.nats.js.streams.create({ connId, config });
      releaseGuard();
      onSaved(info);
      onOpenChange(false);
    } catch (e) {
      const err = describeError(e);
      setServer({ title: err.title, field: draftField(err.field) });
    } finally {
      setBusy(false);
    }
  };

  const limitsLine =
    [d.maxBytes && `bytes ${d.maxBytes}`, d.maxMessages && `messages ${d.maxMessages}`, d.maxAge && `age ${d.maxAge}`, `discard ${d.discard}`].filter(Boolean).join(" · ") || "no limits";
  const replicationLine = `${d.replicas || "1"} ${d.replicas === "1" ? "replica" : "replicas"} · duplicate window ${d.duplicateWindow || "2m (server default)"}`;
  const optionsLine = [`direct get ${d.allowDirect ? "on" : "off"}`, `rollup ${d.allowRollup ? "on" : "off"}`, `deny delete ${d.denyDelete ? "on" : "off"}`, `deny purge ${d.denyPurge ? "on" : "off"}`, d.compression === "s2" ? "s2 compression" : "no compression"].join(" · ");

  const text = (f: StreamField, label: string, placeholder: string, description?: string) => (
    <Field invalid={errorOf(f) !== null}>
      <FieldLabel>{label}</FieldLabel>
      <Input value={d[f] as string} onValueChange={(v) => set({ [f]: v } as Partial<StreamDraft>)} placeholder={placeholder} autoComplete="off" spellCheck={false} className="font-mono" />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {errorOf(f) ? <FieldError match>{errorOf(f)}</FieldError> : null}
    </Field>
  );
  const toggle = (f: "allowDirect" | "allowRollup" | "denyDelete" | "denyPurge" | "discardNewPerSubject", label: string, description: string, disabled = false) => (
    <Field invalid={errorOf(f) !== null}>
      <FieldLabel>
        <Switch checked={d[f]} onCheckedChange={(v) => set({ [f]: v } as Partial<StreamDraft>)} disabled={disabled} /> {label}
      </FieldLabel>
      <FieldDescription>{description}</FieldDescription>
      {errorOf(f) ? <FieldError match>{errorOf(f)}</FieldError> : null}
    </Field>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent className="max-w-panel-sheet">
        <SheetHeader>
          <SheetTitle>{editing ? `Edit stream ${stream.name}` : "New stream"}</SheetTitle>
          <SheetDescription>{editing ? `${profileName} · fields the server cannot change are read only` : profileName}</SheetDescription>
        </SheetHeader>
        <SheetBody>
          {asJson ? (
            <CodeBlock aria-label="Stream configuration as JSON" code={JSON.stringify(config, null, 2)} language="json" copyable />
          ) : (
            <form
              id="stream-form"
              aria-label={editing ? "Edit stream" : "New stream"}
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
                  <div className="flex items-center gap-inline-sm">
                    <Input value={d.name} onValueChange={(name) => set({ name })} readOnly={fixed("name")} autoComplete="off" spellCheck={false} className="font-mono" placeholder="ORDERS" />
                    <Locked on={fixed("name")} />
                  </div>
                  {fixed("name") ? <FieldDescription>Fixed after creation.</FieldDescription> : null}
                  {errorOf("name") ? <FieldError match>{errorOf("name")}</FieldError> : null}
                </Field>
                <Field>
                  <FieldLabel>Description</FieldLabel>
                  <Input value={d.description} onValueChange={(description) => set({ description })} autoComplete="off" />
                </Field>
                <div className="col-span-2 flex flex-col gap-stack-xs">
                  <SubjectsInput label="Subjects" value={d.subjects} onChange={(subjects) => set({ subjects })} placeholder="orders.>" />
                  {errorOf("subjects") ? (
                    <p role="alert" className="text-caption-1 text-danger-fg">
                      {errorOf("subjects")}
                    </p>
                  ) : null}
                </div>
                <Field invalid={errorOf("storage") !== null}>
                  <FieldLabel>Storage</FieldLabel>
                  <div className="flex items-center gap-inline-sm">
                    <ToggleGroup aria-label="Storage" value={[d.storage]} onValueChange={(v) => v[0] && set({ storage: v[0] as StreamDraft["storage"] })} disabled={fixed("storage")}>
                      <ToggleGroupItem value="file">File</ToggleGroupItem>
                      <ToggleGroupItem value="memory">Memory</ToggleGroupItem>
                    </ToggleGroup>
                    <Locked on={fixed("storage")} />
                  </div>
                  {fixed("storage") ? <FieldDescription>Fixed after creation.</FieldDescription> : null}
                  {errorOf("storage") ? <FieldError match>{errorOf("storage")}</FieldError> : null}
                </Field>
                <Field invalid={errorOf("retention") !== null}>
                  <FieldLabel>Retention</FieldLabel>
                  <div className="flex items-center gap-inline-sm">
                    <ToggleGroup aria-label="Retention" value={[d.retention]} onValueChange={(v) => v[0] && set({ retention: v[0] as StreamDraft["retention"] })} disabled={fixed("retention")}>
                      <ToggleGroupItem value="limits">Limits</ToggleGroupItem>
                      <ToggleGroupItem value="interest">Interest</ToggleGroupItem>
                      <ToggleGroupItem value="workQueue">Work queue</ToggleGroupItem>
                    </ToggleGroup>
                    <Locked on={fixed("retention")} />
                  </div>
                  <FieldDescription>{fixed("retention") ? "Fixed after creation." : "Limits keeps messages up to the limits; interest while a consumer wants them; work queue until one acknowledges."}</FieldDescription>
                  {errorOf("retention") ? <FieldError match>{errorOf("retention")}</FieldError> : null}
                </Field>
              </div>
              <Fold title="Limits" value={`${limitsLine} · empty means no limit`} open>
                <div className="grid grid-cols-3 gap-x-inline-xl gap-y-stack-md">
                  {text("maxBytes", "Max bytes", "No limit")}
                  {text("maxMessages", "Max messages", "No limit")}
                  {text("maxAge", "Max age", "No limit", "Such as 24h or 7d.")}
                  {text("maxMessageSize", "Max message size", "No limit")}
                  {text("maxMessagesPerSubject", "Per subject", "No limit", "Messages kept per subject.")}
                  {text("maxConsumers", "Max consumers", "No limit")}
                </div>
                <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
                  <Field>
                    <FieldLabel>Discard</FieldLabel>
                    <Select<StreamDraft["discard"]>
                      items={[
                        { value: "old", label: "Old: drop the oldest messages" },
                        { value: "new", label: "New: refuse new messages" },
                      ]}
                      value={d.discard}
                      onValueChange={(discard) => set({ discard: discard ?? "old" })}
                    >
                      <SelectItem value="old">Old: drop the oldest messages</SelectItem>
                      <SelectItem value="new">New: refuse new messages</SelectItem>
                    </Select>
                    <FieldDescription>What happens at a limit.</FieldDescription>
                  </Field>
                  {d.discard === "new" ? toggle("discardNewPerSubject", "Per subject too", "The per-subject limit refuses new messages as well.") : null}
                </div>
              </Fold>
              <Fold title="Replication" value={replicationLine}>
                <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
                  {text("replicas", "Replicas", "1", "1 to 5; a cluster needs as many servers.")}
                  {text("duplicateWindow", "Duplicate window", "2m", "Messages with the same Nats-Msg-Id inside it are stored once.")}
                </div>
              </Fold>
              <Fold title="Options" value={optionsLine}>
                <div className="grid grid-cols-2 gap-x-inline-xl gap-y-stack-md">
                  {toggle("allowDirect", "Allow direct get", "Any replica answers reads of one message (Load full payload uses it).")}
                  {toggle("allowRollup", "Allow rollup", "A message with Nats-Rollup replaces the subject's earlier ones.")}
                  {toggle("denyDelete", "Deny delete", "Messages cannot be deleted one by one.")}
                  {toggle("denyPurge", "Deny purge", "The stream cannot be purged.")}
                  <Field>
                    <FieldLabel>Compression</FieldLabel>
                    <ToggleGroup aria-label="Compression" value={[d.compression]} onValueChange={(v) => v[0] && set({ compression: v[0] as StreamDraft["compression"] })}>
                      <ToggleGroupItem value="none">None</ToggleGroupItem>
                      <ToggleGroupItem value="s2">S2</ToggleGroupItem>
                    </ToggleGroup>
                    <FieldDescription>File storage only.</FieldDescription>
                  </Field>
                </div>
              </Fold>
              {editing && stream.sources.length > 0 ? (
                <p className="text-body-1 text-fg-muted">Sources ({stream.sources.map((s) => s.name).join(", ")}) are kept as they are.</p>
              ) : null}
            </form>
          )}
          {server ? (
            <Alert intent="danger" className="mt-stack-md">
              <AlertDescription>
                {server.field ? <strong className="font-mono">{server.field}: </strong> : null}
                {server.title}
                {server.field ? <span className="block text-fg-muted">The field the server names is marked; the rest of the form is kept.</span> : null}
              </AlertDescription>
            </Alert>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button appearance="subtle" onClick={() => setAsJson((j) => !j)}>
            <Icon icon={Code} /> {asJson ? "Show the form" : "Show as JSON"}
          </Button>
          <span className="flex-1" />
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button appearance="primary" type="submit" form="stream-form" loading={busy} disabled={asJson}>
            <Icon icon={Save} /> {editing ? "Update stream" : "Create stream"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
