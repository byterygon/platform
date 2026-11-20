// Add or edit a mapping (mockup frame codecs-mapping, DOC-21 §4.2, Open question 45 (p)): where
// (the system's targets: a NATS subject pattern, a stream or a KV bucket; a Kafka topic), the part,
// the codec, the schema and type, the wire format; then "Test on the last 20 messages" through the
// tool's `<tool>.schemas.test`, before saving: how many decode, each value or why it failed, and
// which subjects fail so a narrower mapping can go above this one.
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Combobox, ComboboxItem } from "@/components/ui/combobox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { MightyClient } from "@/app/client";
import { Required } from "@/app/form-parts";
import { useSheetGuard } from "@/app/leave-guard";
import type { CodecId, LocalSchema, MappingTarget, MappingTestOutput, Part, SchemaMapping, SchemaVersion, WireFormat } from "@/gen/api";
import { CheckmarkCircle, ErrorCircle, Play, Save } from "@/lib/icons";
import { CODEC_LABELS, PLAIN_CODECS, SCHEMA_CODECS, TARGET_LABELS, codecOfType, mappingCodec, needsSchema, targetProblem, targetText, withTargetText } from "./model";
import { issueText } from "./SchemaSheet";

/** How the Where select names each target. */
export const WHERE_LABELS: Record<MappingTarget["kind"], string> = {
  subject: "NATS subject (core and JetStream)",
  stream: "JetStream stream",
  kvBucket: "KV bucket",
  topic: "Kafka topic",
};

const PLACEHOLDER: Record<MappingTarget["kind"], string> = { subject: "orders.>", stream: "ORDERS", kvBucket: "sessions", topic: "orders" };

/** The tool's test of a mapping that may not be saved yet. */
export type MappingTest = (mapping: SchemaMapping, schemas: LocalSchema[]) => Promise<MappingTestOutput>;

export interface MappingSheetProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  /** The mapping being edited, or a new one's start (its id set). */
  mapping: SchemaMapping;
  isNew: boolean;
  schemas: readonly LocalSchema[];
  /** The targets this system maps, in the Where select's order. */
  targets: readonly MappingTarget["kind"][];
  /** Whether a mapping chooses key or value (Kafka); NATS maps values only. */
  parts: boolean;
  client: MightyClient;
  /** The connection, for the registry's subjects and versions. */
  connId: string | null;
  /** Whether the profile has a registry: schemas can then come from it. */
  hasRegistry: boolean;
  profileName: string;
  /** `null` without a connection: the test needs one. */
  test: MappingTest | null;
  onSave(mapping: SchemaMapping): Promise<void>;
}

/** Where a mapping's schema comes from. */
type SchemaSource = "local" | "subject" | "message";

const SOURCE_LABELS: Record<SchemaSource, string> = { local: "A local schema", subject: "A registry subject", message: "The id in each message" };

function sourceOf(m: SchemaMapping): SchemaSource {
  if (m.registry) return "subject";
  if (!m.schemaId && m.wireFormat === "confluent" && m.codec && needsSchema(m.codec)) return "message";
  return "local";
}

const versionOf = (m: SchemaMapping): string => (m.registry && "subject" in m.registry ? String(m.registry.version) : "latest");

export function MappingSheet({ open, onOpenChange, mapping, isNew, schemas, targets, parts, client, connId, hasRegistry, profileName, test, onSave }: MappingSheetProps) {
  const [kind, setKind] = useState<MappingTarget["kind"]>(mapping.target.kind);
  const [text, setText] = useState(targetText(mapping.target));
  const [part, setPart] = useState<Part>(mapping.part);
  const [codec, setCodec] = useState<CodecId>(mappingCodec(mapping, schemas) ?? "json");
  const [schemaId, setSchemaId] = useState<string | null>(mapping.schemaId ?? null);
  const [messageType, setMessageType] = useState<string | null>(mapping.messageType ?? null);
  const [wire, setWire] = useState<WireFormat>(mapping.wireFormat ?? "none");
  const [source, setSource] = useState<SchemaSource>(sourceOf(mapping));
  const [subject, setSubject] = useState(mapping.registry && "subject" in mapping.registry ? mapping.registry.subject : "");
  const [version, setVersion] = useState(versionOf(mapping));
  const [subjects, setSubjects] = useState<string[]>([]);
  const [versions, setVersions] = useState<number[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [tried, setTried] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [result, setResult] = useState<MappingTestOutput | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const generation = useRef(0);
  // A changed draft guards the tab (DOC-21 §3.7).
  const releaseGuard = useSheetGuard(open, { kind, text, part, codec, schemaId, messageType, wire, source, subject, version });
  useEffect(() => {
    if (!open) return;
    setKind(mapping.target.kind);
    setText(targetText(mapping.target));
    setPart(mapping.part);
    setCodec(mappingCodec(mapping, schemas) ?? "json");
    setSchemaId(mapping.schemaId ?? null);
    setMessageType(mapping.messageType ?? null);
    setWire(mapping.wireFormat ?? "none");
    setSource(sourceOf(mapping));
    setSubject(mapping.registry && "subject" in mapping.registry ? mapping.registry.subject : "");
    setVersion(versionOf(mapping));
    setTried(false);
    setFailure(null);
    setResult(null);
    setTestError(null);
  }, [open, mapping, schemas]);

  const offered = schemas.filter((s) => codecOfType(s.type) === codec);
  const schema = schemas.find((s) => s.id === schemaId) ?? null;
  // The schema's message types, compiled from the profile's text (no connection needed).
  useEffect(() => {
    setTypes([]);
    if (!open || !schema || schema.type !== "protobuf") return;
    let live = true;
    client.messaging.schemas.inspect({ schema }).then(
      (out) => {
        if (live) setTypes(out.messageTypes);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, schema, client]);

  // The registry's subjects, and the chosen subject's versions (a connection is needed).
  const fromRegistry = needsSchema(codec) && source === "subject";
  useEffect(() => {
    if (!open || !fromRegistry || connId === null) return;
    let live = true;
    client.messaging.registry.subjects({ connId }).then(
      (list) => {
        if (live) setSubjects(list);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, fromRegistry, connId, client]);
  const chosenSubject = subject.trim();
  useEffect(() => {
    setVersions([]);
    if (!open || !fromRegistry || connId === null || chosenSubject === "") return;
    let live = true;
    client.messaging.registry.versions({ connId, subject: chosenSubject }).then(
      (list) => {
        if (live) setVersions(list);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [open, fromRegistry, connId, chosenSubject, client]);
  const sources: SchemaSource[] = hasRegistry || source !== "local" ? ["local", "subject", "message"] : ["local"];

  const target = withTargetText(kind, text.trim());
  const registryVersion: SchemaVersion = version === "latest" ? "latest" : Number(version);
  const draft = (): SchemaMapping => {
    const withSchema = needsSchema(codec);
    return {
      id: mapping.id,
      target,
      part: parts ? part : "value",
      codec,
      schemaId: withSchema && source === "local" ? schemaId : null,
      registry: withSchema && source === "subject" ? { subject: chosenSubject, version: registryVersion } : null,
      messageType: withSchema && codec === "protobuf" ? messageType : null,
      wireFormat: wire === "confluent" || (withSchema && source === "message") ? "confluent" : null,
    };
  };
  const whereError = targetProblem(target);
  const schemaError = !needsSchema(codec)
    ? null
    : source === "subject"
      ? chosenSubject === ""
        ? "Choose a registry subject."
        : null
      : source === "message"
        ? null
        : !schema
          ? offered.length === 0
            ? `No ${CODEC_LABELS[codec]} schema yet: add one first${hasRegistry ? ", or take it from the registry" : ""}.`
            : "Choose a schema."
          : null;
  const invalid = whereError !== null || schemaError !== null;
  const changed = () => {
    setResult(null);
    setTestError(null);
    setFailure(null);
  };

  const runTest = async () => {
    if (!test || invalid) return;
    const mine = ++generation.current;
    setTesting(true);
    setTestError(null);
    try {
      const out = await test(draft(), [...schemas]);
      if (mine === generation.current) setResult(out);
    } catch (e) {
      if (mine === generation.current) setTestError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === generation.current) setTesting(false);
    }
  };
  const save = async () => {
    setTried(true);
    if (invalid) return;
    setSaving(true);
    try {
      releaseGuard();
      await onSave(draft());
      onOpenChange(false);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const failing = useMemo(() => [...new Set((result?.rows ?? []).filter((r) => r.error).map((r) => r.subject))], [result]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange} size="lg">
      <SheetContent>
        <SheetHeader>
          <SheetTitle>{isNew ? "Map messages to a codec" : "Edit the mapping"}</SheetTitle>
          <SheetDescription>{profileName} · the first mapping that matches wins</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form
            id="mapping-form"
            aria-label="Mapping"
            className="grid grid-cols-2 gap-x-inline-md gap-y-stack-md"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field>
              <FieldLabel>Where</FieldLabel>
              <Select<MappingTarget["kind"]>
                items={targets.map((t) => ({ value: t, label: WHERE_LABELS[t] }))}
                value={kind}
                onValueChange={(k) => {
                  if (!k) return;
                  setKind(k);
                  changed();
                }}
              >
                {targets.map((t) => (
                  <SelectItem key={t} value={t}>
                    {WHERE_LABELS[t]}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Field invalid={tried && whereError !== null}>
              <FieldLabel>
                {kind === "subject" ? "Pattern" : `The ${TARGET_LABELS[kind]}`}
                <Required />
              </FieldLabel>
              <Input
                value={text}
                onValueChange={(v) => {
                  setText(v);
                  changed();
                }}
                placeholder={PLACEHOLDER[kind]}
                className="font-mono"
                autoComplete="off"
                spellCheck={false}
              />
              <FieldDescription>{kind === "subject" ? "Wildcards * and >." : "Its name."}</FieldDescription>
              {tried && whereError ? <FieldError match>{whereError}</FieldError> : null}
            </Field>
            {parts ? (
              <Field>
                <FieldLabel>Part</FieldLabel>
                <ToggleGroup aria-label="Part" value={[part]} onValueChange={(v) => v[0] && (setPart(v[0] as Part), changed())}>
                  <ToggleGroupItem value="value">Value</ToggleGroupItem>
                  <ToggleGroupItem value="key">Key</ToggleGroupItem>
                </ToggleGroup>
              </Field>
            ) : null}
            <Field>
              <FieldLabel>Codec</FieldLabel>
              <Select<CodecId>
                items={[...PLAIN_CODECS, ...SCHEMA_CODECS].map((c) => ({ value: c, label: CODEC_LABELS[c] }))}
                value={codec}
                onValueChange={(c) => {
                  if (!c) return;
                  setCodec(c);
                  const first = schemas.find((s) => codecOfType(s.type) === c);
                  setSchemaId(first?.id ?? null);
                  if (source === "local" && !first && hasRegistry) setSource("subject");
                  setMessageType(null);
                  changed();
                }}
              >
                {[...PLAIN_CODECS, ...SCHEMA_CODECS].map((c) => (
                  <SelectItem key={c} value={c}>
                    {CODEC_LABELS[c]}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            {needsSchema(codec) && sources.length > 1 ? (
              <Field className="col-span-2">
                <FieldLabel>Schema from</FieldLabel>
                <ToggleGroup
                  aria-label="Schema from"
                  value={[source]}
                  onValueChange={(v) => {
                    const next = v[0] as SchemaSource | undefined;
                    if (!next) return;
                    setSource(next);
                    if (next === "message") setWire("confluent");
                    changed();
                  }}
                >
                  {sources.map((x) => (
                    <ToggleGroupItem key={x} value={x}>
                      {SOURCE_LABELS[x]}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                {source === "message" ? <FieldDescription>The Confluent wire format: the registry's schema for the id each message starts with; for Protobuf, its message indexes name the type.</FieldDescription> : null}
              </Field>
            ) : null}
            {needsSchema(codec) && source === "local" ? (
              <Field invalid={tried && schemaError !== null}>
                <FieldLabel>
                  Schema
                  <Required />
                </FieldLabel>
                <Select<string>
                  items={offered.map((s) => ({ value: s.id, label: s.name }))}
                  value={schemaId}
                  placeholder={offered.length === 0 ? "None of this type" : "Choose a schema"}
                  onValueChange={(id) => {
                    setSchemaId(id);
                    setMessageType(null);
                    changed();
                  }}
                >
                  {offered.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </Select>
                {tried && schemaError ? <FieldError match>{schemaError}</FieldError> : null}
              </Field>
            ) : null}
            {needsSchema(codec) && source === "subject" ? (
              <>
                <Field invalid={tried && schemaError !== null}>
                  <FieldLabel>
                    Registry subject
                    <Required />
                  </FieldLabel>
                  <Combobox<string>
                    items={subjects}
                    inputValue={subject}
                    onInputValueChange={(v) => {
                      setSubject(v);
                      setVersion("latest");
                      changed();
                    }}
                    placeholder="orders-value"
                    emptyMessage={connId === null ? "Connect to list the subjects; any name is accepted." : "No such subject; any name is accepted."}
                    className="font-mono"
                  >
                    {(item: string) => (
                      <ComboboxItem key={item} value={item}>
                        {item}
                      </ComboboxItem>
                    )}
                  </Combobox>
                  {tried && schemaError ? <FieldError match>{schemaError}</FieldError> : null}
                </Field>
                <Field>
                  <FieldLabel>Version</FieldLabel>
                  <Select<string>
                    items={[{ value: "latest", label: "Latest" }, ...versions.map((v) => ({ value: String(v), label: `Version ${v}` }))]}
                    value={version}
                    onValueChange={(v) => {
                      if (!v) return;
                      setVersion(v);
                      changed();
                    }}
                  >
                    <SelectItem value="latest">Latest</SelectItem>
                    {(versions.includes(Number(version)) || version === "latest" ? versions : [...versions, Number(version)]).map((v) => (
                      <SelectItem key={v} value={String(v)}>
                        Version {v}
                      </SelectItem>
                    ))}
                  </Select>
                  <FieldDescription>Latest follows new versions as they are registered.</FieldDescription>
                </Field>
              </>
            ) : null}
            {codec === "protobuf" && source === "local" && schema ? (
              <Field className="col-span-2">
                <FieldLabel>Message type</FieldLabel>
                <Select<string>
                  items={types.map((t) => ({ value: t, label: t }))}
                  value={messageType}
                  placeholder={types[0] ? `${types[0]} (the first)` : "The schema's first"}
                  onValueChange={(t) => {
                    setMessageType(t);
                    changed();
                  }}
                >
                  {types.map((t) => (
                    <SelectItem key={t} value={t}>
                      <span className="font-mono">{t}</span>
                    </SelectItem>
                  ))}
                </Select>
              </Field>
            ) : null}
            {codec === "protobuf" && source === "subject" && wire !== "confluent" ? (
              <Field className="col-span-2">
                <FieldLabel>Message type</FieldLabel>
                <Input
                  value={messageType ?? ""}
                  onValueChange={(v) => {
                    setMessageType(v.trim() === "" ? null : v.trim());
                    changed();
                  }}
                  placeholder="The schema's first message"
                  className="font-mono"
                  autoComplete="off"
                  spellCheck={false}
                />
                <FieldDescription>Raw bytes name no type: give its full name when it is not the first.</FieldDescription>
              </Field>
            ) : null}
            <Field className="col-span-2">
              <FieldLabel>Wire format</FieldLabel>
              <ToggleGroup aria-label="Wire format" value={[wire]} disabled={needsSchema(codec) && source === "message"} onValueChange={(v) => v[0] && (setWire(v[0] as WireFormat), changed())}>
                <ToggleGroupItem value="none">None (raw bytes)</ToggleGroupItem>
                <ToggleGroupItem value="confluent">Confluent (magic byte + id)</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>Confluent: the magic byte, the schema id and, for Protobuf, the message indexes come first and are skipped.</FieldDescription>
            </Field>
          </form>

          <section aria-label="Test" className="mt-stack-lg flex flex-col gap-stack-sm border-t border-border-subtle pt-stack-md">
            <div className="flex flex-wrap items-center gap-inline-md">
              <h3 className="text-body-1-strong text-fg">Test on the last 20 messages{whereError ? "" : ` of ${targetText(target)}`}</h3>
              {result ? (
                <span className="text-caption-1 text-fg-muted">
                  {result.source ? `${result.source} · ` : ""}
                  {result.decoded} decoded · {result.failed} failed
                </span>
              ) : null}
              <span className="min-w-0 flex-1" />
              <Button size="small" onClick={() => void runTest()} loading={testing} disabled={!test || invalid}>
                <Icon icon={Play} /> {result ? "Test again" : "Run the test"}
              </Button>
            </div>
            {!test ? <p className="text-caption-1 text-fg-muted">Connect the profile to test the mapping on its messages.</p> : null}
            {testError ? (
              <Alert intent="danger">
                <AlertDescription>{testError}</AlertDescription>
              </Alert>
            ) : null}
            {result && result.issues.length > 0 ? (
              <Alert intent="danger">
                <AlertDescription>{result.issues.map(issueText).join("; ")}</AlertDescription>
              </Alert>
            ) : null}
            {result && result.rows.length === 0 ? <p className="text-caption-1 text-fg-muted">{result.note ?? "No messages to test on."}</p> : null}
            {result && result.rows.length > 0 ? (
              <Table aria-label="Test results" size="small">
                <TableBody>
                  {result.rows.map((r, i) => (
                    <TableRow key={`${r.subject}-${r.sequence ?? i}`} data-failed={r.error ? "" : undefined}>
                      <TableCell className="font-mono">{r.subject}</TableCell>
                      <TableCell>
                        <Icon icon={r.error ? ErrorCircle : CheckmarkCircle} className={r.error ? "text-danger-fg" : "text-success-fg"} aria-label={r.error ? "failed" : "decoded"} />
                      </TableCell>
                      <TableCell className="max-w-panel-sm truncate font-mono text-fg-muted" title={r.error ?? r.text}>
                        {r.error ? `${r.error} · ${r.text ?? ""}` : r.text}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : null}
            {failing.length > 0 ? (
              <p className="text-caption-1 text-fg-muted">
                The failures are on <span className="font-mono">{failing.slice(0, 3).join(", ")}</span>
                {failing.length > 3 ? ` and ${failing.length - 3} more` : ""}: add a narrower mapping above this one, or leave them as they are.
              </p>
            ) : null}
          </section>
          {failure ? (
            <Alert intent="danger" className="mt-stack-md">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
        </SheetBody>
        <SheetFooter>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button appearance="primary" type="submit" form="mapping-form" loading={saving}>
            <Icon icon={Save} /> Save mapping
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
