// The Composer (Mightyconsole spec §5.7): one form for Kafka produce, NATS publish and request, and
// KV put. The tool gives its target fields; the Composer has the key, the headers and the payload
// in any codec: a schema codec takes a schema and, for Protobuf, a message type, and its JSON is
// checked in the editor against the schema's JSON Schema (messaging.schemas.inspect, which also
// gives "Insert example"). Validate encodes on the server (messaging.encode) and shows the size and
// the first bytes; Send (Mod+Enter) is the tool's. Templates are saved with the profile.
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useDraftChanged, useKeepTab } from "@/app/leave-guard";
import { Button } from "@/components/ui/button";
import { CodeEditor, type CodeDiagnostic } from "@/components/ui/code-editor";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { HexView } from "@/components/ui/hex-view";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { KeyValueEditor, type KeyValueEntry } from "@/components/ui/key-value-editor";
import { Select, SelectItem } from "@/components/ui/select";
import { ArrowUp as Send } from "@/lib/icons";
import type { CodecId, ComposePayload, EncodeOutput, HeaderInput, Inspection, SchemaRef } from "@/gen/api";
import { CODECS } from "./CodecSelect";

/** What the Composer holds. */
export interface ComposerDraft {
  key: ComposePayload | null;
  headers: KeyValueEntry[];
  value: ComposePayload;
}

/** A saved draft (spec §4.2, `Template`). */
export interface ComposerTemplate {
  id: string;
  name: string;
  draft: ComposerDraft;
}

/** A local schema the profile offers. */
export interface SchemaChoice {
  id: string;
  name: string;
  type: "avro" | "protobuf" | "jsonschema";
}

export const EMPTY_DRAFT: ComposerDraft = { key: null, headers: [], value: { codec: "json", text: "{\n  \n}" } };

const SCHEMA_CODECS = new Set<CodecId>(["avro", "protobuf", "jsonschema"]);
const JSON_TEXT = new Set<CodecId>(["json", "cbor", "msgpack", "avro", "protobuf", "jsonschema"]);
const VALUE_CODECS = CODECS.filter((c) => c.id !== "auto") as { id: CodecId; label: string }[];

/** The headers as the API takes them. */
export function headerInputs(entries: readonly KeyValueEntry[]): HeaderInput[] {
  return entries.filter((e) => e.key !== "").map((e) => ({ key: e.key, value: e.value, encoding: e.encoding ?? "text" }));
}

export interface ComposerProps {
  /** The tool's target fields (topic and partition, subject and reply, bucket and key). */
  target: ReactNode;
  /** Whether the system has a key apart from the target (Kafka). */
  withKey?: boolean;
  /** Whether messages carry headers; KV entries do not. */
  withHeaders?: boolean;
  keyLabel?: string;
  schemas: readonly SchemaChoice[];
  draft: ComposerDraft;
  onDraftChange(draft: ComposerDraft): void;
  /** `messaging.encode` for the value. */
  encode(payload: ComposePayload): Promise<EncodeOutput>;
  /** `messaging.schemas.inspect`. */
  inspect(schema: SchemaRef, messageType: string | null): Promise<Inspection>;
  /** Sends the draft; resolves to the result line ("partition 1, offset 41"). */
  onSend(draft: ComposerDraft): Promise<ReactNode>;
  templates?: readonly ComposerTemplate[];
  onSaveTemplate?: (name: string, draft: ComposerDraft) => void;
  /** Describes a failure as the UI shows it. */
  describe(error: unknown): { title: string; field?: string; line?: number; column?: number };
}

export function Composer({ target, withKey = false, withHeaders = true, keyLabel = "Key", schemas, draft, onDraftChange, encode, inspect, onSend, templates, onSaveTemplate, describe }: ComposerProps) {
  // A draft changed since the tab showed it is state to lose: a preview tab is kept (DOC-21 §3.2.1).
  useKeepTab(useDraftChanged(true, draft));
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [diagnostics, setDiagnostics] = useState<CodeDiagnostic[]>([]);
  const [validated, setValidated] = useState<EncodeOutput | null>(null);
  const [problem, setProblem] = useState<ReturnType<ComposerProps["describe"]> | null>(null);
  const [result, setResult] = useState<ReactNode>(null);
  const [busy, setBusy] = useState(false);
  const [templateName, setTemplateName] = useState("");
  const value = draft.value;
  const schemaCodec = SCHEMA_CODECS.has(value.codec);
  const schemaId = value.schema && "local" in value.schema ? value.schema.local : "";
  const offered = schemas.filter((s) => s.type === value.codec);

  const setValue = (patch: Partial<ComposePayload>) => {
    setValidated(null);
    setProblem(null);
    onDraftChange({ ...draft, value: { ...value, ...patch } });
  };

  // The schema's JSON Schema and example for the editor.
  useEffect(() => {
    setInspection(null);
    if (!schemaCodec || !value.schema) return;
    let stale = false;
    inspect(value.schema, value.messageType ?? null).then(
      (i) => {
        if (!stale) setInspection(i);
      },
      (e: unknown) => {
        if (!stale) setProblem(describe(e));
      },
    );
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemaCodec, JSON.stringify(value.schema), value.messageType]);

  const validate = async () => {
    setProblem(null);
    try {
      setValidated(await encode(value));
    } catch (e) {
      setValidated(null);
      setProblem(describe(e));
    }
  };
  const send = async () => {
    setBusy(true);
    setProblem(null);
    setResult(null);
    try {
      setResult(await onSend(draft));
    } catch (e) {
      setProblem(describe(e));
    } finally {
      setBusy(false);
    }
  };
  const markers = useMemo(
    () => (problem?.field === "value" && problem.line ? [{ line: problem.line, column: problem.column ?? 1, message: problem.title }] : []),
    [problem],
  );
  const firstBytes = validated ? base64Bytes(validated.bytes).subarray(0, 256) : null;

  return (
    <form
      data-slot="composer"
      aria-label="Composer"
      className="flex min-h-0 flex-1 flex-col gap-stack-md overflow-auto p-inset-md"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {templates && templates.length > 0 ? (
        <Field className="w-auto">
          <FieldLabel>Template</FieldLabel>
          <Select<string>
            size="small"
            placeholder="Choose a template"
            items={templates.map((t) => ({ value: t.id, label: t.name }))}
            onValueChange={(id) => {
              const t = templates.find((x) => x.id === id);
              if (t) onDraftChange(structuredClone(t.draft));
            }}
          >
            {templates.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.name}
              </SelectItem>
            ))}
          </Select>
        </Field>
      ) : null}
      <fieldset className="flex flex-wrap gap-inline-md">{target}</fieldset>
      {withKey ? (
        <div className="flex flex-wrap items-end gap-inline-sm">
          <Field className="min-w-0 flex-1">
            <FieldLabel>{keyLabel}</FieldLabel>
            <Input
              value={draft.key?.text ?? ""}
              placeholder="No key"
              className="font-mono"
              onValueChange={(text) => onDraftChange({ ...draft, key: text === "" ? null : { codec: draft.key?.codec ?? "utf8", text } })}
            />
          </Field>
          <Field className="w-auto">
            <FieldLabel>{keyLabel} codec</FieldLabel>
            <Select<CodecId>
              size="medium"
              items={VALUE_CODECS.filter((c) => !SCHEMA_CODECS.has(c.id)).map((c) => ({ value: c.id, label: c.label }))}
              value={draft.key?.codec ?? "utf8"}
              onValueChange={(codec) => draft.key && onDraftChange({ ...draft, key: { ...draft.key, codec: codec ?? "utf8" } })}
            >
              {VALUE_CODECS.filter((c) => !SCHEMA_CODECS.has(c.id)).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.label}
                </SelectItem>
              ))}
            </Select>
          </Field>
        </div>
      ) : null}
      {withHeaders ? (
        <Field>
          <FieldLabel>Headers</FieldLabel>
          <KeyValueEditor aria-label="Headers" keyLabel="Name" value={draft.headers} onChange={(headers) => onDraftChange({ ...draft, headers })} valueEncodings={["text", "base64"]} addLabel="Add header" size="small" />
        </Field>
      ) : null}
      <div className="flex flex-wrap items-end gap-inline-sm">
        <Field className="w-auto">
          <FieldLabel>Codec</FieldLabel>
          <Select<CodecId> items={VALUE_CODECS.map((c) => ({ value: c.id, label: c.label }))} value={value.codec} onValueChange={(codec) => setValue({ codec: codec ?? "json", schema: null, messageType: null })}>
            {VALUE_CODECS.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </Select>
        </Field>
        {schemaCodec ? (
          <Field className="w-auto">
            <FieldLabel>Schema</FieldLabel>
            <Select<string>
              placeholder={offered.length ? "Choose a schema" : "No local schema of this type"}
              items={offered.map((s) => ({ value: s.id, label: s.name }))}
              value={schemaId || null}
              onValueChange={(id) => setValue({ schema: id ? { local: id } : null, messageType: null })}
            >
              {offered.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </Select>
          </Field>
        ) : null}
        {value.codec === "protobuf" && inspection && inspection.messageTypes.length > 0 ? (
          <Field className="w-auto">
            <FieldLabel>Message type</FieldLabel>
            <Select<string> items={inspection.messageTypes.map((t) => ({ value: t, label: t }))} value={value.messageType ?? inspection.messageTypes[0]!} onValueChange={(t) => setValue({ messageType: t })}>
              {inspection.messageTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </Select>
          </Field>
        ) : null}
        <Button type="button" appearance="subtle" disabled={!inspection} onClick={() => inspection && setValue({ text: inspection.example })}>
          Insert example
        </Button>
      </div>
      <Field invalid={problem?.field === "value"}>
        <FieldLabel>Payload</FieldLabel>
        <CodeEditor
          aria-label="Payload"
          language={JSON_TEXT.has(value.codec) ? "json" : "plaintext"}
          value={value.text}
          onValueChange={(text) => setValue({ text })}
          onSubmit={() => void send()}
          {...(inspection ? { jsonSchema: inspection.jsonSchema as object } : {})}
          markers={markers}
          onDiagnosticsChange={setDiagnostics}
          className="h-panel-sm"
        />
        <FieldDescription>
          {diagnostics.length > 0 ? `${diagnostics.length} problem(s): line ${diagnostics[0]!.line}: ${diagnostics[0]!.message}` : JSON_TEXT.has(value.codec) ? "JSON; Ctrl+Enter sends." : value.codec === "hex" ? "Hex bytes, spaces allowed; Ctrl+Enter sends." : value.codec === "base64" ? "Base64; Ctrl+Enter sends." : "Text; Ctrl+Enter sends."}
        </FieldDescription>
        {problem ? <FieldError match>{problem.title}</FieldError> : null}
      </Field>
      <div className="flex flex-wrap items-center gap-inline-sm">
        <Button type="submit" appearance="primary" loading={busy} aria-keyshortcuts="Control+Enter">
          <Icon icon={Send} /> Send
        </Button>
        <Button type="button" appearance="secondary" onClick={() => void validate()}>
          Validate
        </Button>
        {onSaveTemplate ? (
          <>
            <Input aria-label="Template name" size="small" value={templateName} placeholder="Template name" onValueChange={setTemplateName} className="w-auto" />
            <Button
              type="button"
              appearance="subtle"
              disabled={templateName.trim() === ""}
              onClick={() => {
                onSaveTemplate(templateName.trim(), draft);
                setTemplateName("");
              }}
            >
              Save as template
            </Button>
          </>
        ) : null}
      </div>
      {validated && firstBytes ? (
        <div data-slot="composer-validated" className="flex flex-col gap-stack-xs">
          <p className="text-body-1 text-fg" role="status">
            Valid: {validated.size.toLocaleString()} bytes{validated.schemaRef ? `, ${validated.schemaRef}` : ""}
            {validated.schemaId !== undefined ? ` (registry id ${validated.schemaId})` : ""}.
          </p>
          <HexView aria-label="Encoded bytes" bytes={firstBytes} className="h-panel-xs" />
        </div>
      ) : null}
      {result ? (
        <p data-slot="composer-result" role="status" className="text-body-1 text-fg">
          {result}
        </p>
      ) : null}
    </form>
  );
}

function base64Bytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}
