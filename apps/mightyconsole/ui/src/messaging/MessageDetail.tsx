// The detail pane of MessageViewer (Mightyconsole spec §5.6): Value, Key, Headers, Raw, Schema and
// Metadata of one message, all read from its batch (Load full payload and the schema text are the
// only calls).
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/ui/code-block";
import { CodeEditor } from "@/components/ui/code-editor";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { HexView } from "@/components/ui/hex-view";
import { JsonView } from "@/app/json-view";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyLine } from "@/app/states";
import type { MessageRow } from "./arrow";
import { timestampText } from "./arrow";
import type { MessageLabels } from "./columns";
import { parseSchemaRef } from "./schema-ref";
import { type DecodeAs, DecodeAsPanel } from "./schemas/DecodeAs";

/** Fetches a schema's text for the Schema tab (the tool's `messaging.schemas.inspect`). */
export type SchemaLoader = (ref: NonNullable<ReturnType<typeof parseSchemaRef>>) => Promise<string>;

const JSON_CODECS = new Set(["json", "cbor", "msgpack", "avro", "protobuf", "jsonschema"]);

/** A schema's text: a JSON value (JSON Schema, Avro) in the JSON view, anything else (Protobuf) as plain text. */
function SchemaText({ text }: { text: string }) {
  const json = useMemo(() => {
    try {
      return { value: JSON.parse(text) as unknown };
    } catch {
      return null;
    }
  }, [text]);
  return json ? <JsonView modeKey="messaging.message.schema" defaultMode="text" value={json.value} aria-label="Schema" className="max-h-panel-md" /> : <CodeBlock code={text} language="text" aria-label="Schema" />;
}

function ValueView({ text, codec, raw, label }: { text: string | null; codec: string | null; raw: Uint8Array | null; label: string }) {
  if (raw === null && text === null) return <EmptyLine>No {label.toLowerCase()}.</EmptyLine>;
  if (text !== null && codec !== null && JSON_CODECS.has(codec)) return <JsonView modeKey="messaging.message.value" aria-label={label} text={text} defaultExpandDepth={2} className="min-h-0 flex-1" />;
  // The Text view: read-only Monaco (TSK-93), with find, selection and line numbers.
  if (text !== null && codec !== "hex") return <CodeEditor language="plaintext" readOnly variant="ghost" aria-label={label} value={text} className="h-auto min-h-0 flex-1" />;
  return <HexView aria-label={label} bytes={raw ?? new Uint8Array()} className="min-h-0 flex-1" />;
}

export interface MessageDetailProps {
  message: MessageRow;
  labels: MessageLabels;
  onCompose?: ((message: MessageRow) => void) | undefined;
  onLoadFull?: ((message: MessageRow) => Promise<Uint8Array>) | null | undefined;
  loadSchema?: SchemaLoader | undefined;
  rowActions?: readonly { label: string; run(message: MessageRow): void }[] | undefined;
  /** "Decode as…" on a message that did not decode: the tool's codecs and its mapping targets. */
  decodeAs?: DecodeAs | undefined;
}

export function MessageDetail({ message: m, labels, onCompose, onLoadFull, loadSchema, rowActions, decodeAs }: MessageDetailProps) {
  const [full, setFull] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [schemaText, setSchemaText] = useState<string | null>(null);
  const [decoding, setDecoding] = useState(false);
  useEffect(() => {
    setFull(null);
    setLoadError(null);
    setSchemaText(null);
    setDecoding(false);
  }, [m]);
  const failed = m.decodeError !== null && !m.payloadTruncated;
  const ref = parseSchemaRef(m.schemaRef);
  const loadFull = async () => {
    if (!onLoadFull) return;
    setLoading(true);
    try {
      setFull(await onLoadFull(m));
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };
  const showSchema = async () => {
    if (!ref || !loadSchema) return;
    try {
      setSchemaText(await loadSchema(ref));
    } catch (e) {
      setSchemaText(`Could not load the schema: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const raw = full ?? m.payloadRaw;
  const fullText = full ? new TextDecoder().decode(full) : null;

  return (
    <div data-slot="message-detail" className="flex size-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-inline-sm px-inset-sm py-inset-xs">
        <Badge appearance="tint" variant="neutral">{m.payloadCodec}</Badge>
        {m.schemaRef ? <Badge appearance="tint" variant="info">{m.schemaRef}</Badge> : null}
        <span className="min-w-0 flex-1" />
        {onCompose ? (
          <Button appearance="subtle" size="small" onClick={() => onCompose(m)}>
            Open in Composer
          </Button>
        ) : null}
        {rowActions?.map((a) => (
          <Button key={a.label} appearance="subtle" size="small" onClick={() => a.run(m)}>
            {a.label}
          </Button>
        ))}
        {decodeAs && failed ? (
          <Button appearance={decoding ? "secondary" : "primary"} size="small" aria-expanded={decoding} onClick={() => setDecoding((d) => !d)}>
            Decode as…
          </Button>
        ) : null}
      </div>
      {m.decodeError ? (
        <Alert intent={m.payloadTruncated ? "info" : "warning"} className="mx-inset-sm">
          <AlertTitle>{m.payloadTruncated ? "Payload cut" : "Not decoded as chosen"}</AlertTitle>
          <AlertDescription>{m.decodeError}</AlertDescription>
        </Alert>
      ) : null}
      {decodeAs && failed && decoding ? (
        <div className="min-h-0 shrink overflow-auto px-inset-sm pt-stack-xs">
          <DecodeAsPanel message={m} decodeAs={decodeAs} />
        </div>
      ) : null}
      <Tabs defaultValue="value" className="flex min-h-0 flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="value">Value</TabsTrigger>
          {m.keyRaw !== null ? <TabsTrigger value="key">{labels.key}</TabsTrigger> : null}
          <TabsTrigger value="headers">Headers</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
          <TabsTrigger value="schema">Schema</TabsTrigger>
          <TabsTrigger value="metadata">Metadata</TabsTrigger>
        </TabsList>
        <TabsContent value="value" className="flex min-h-0 flex-1 flex-col gap-stack-xs overflow-auto p-inset-sm">
          {m.payloadTruncated && !full ? (
            onLoadFull ? (
              <Button appearance="secondary" size="small" loading={loading} onClick={() => void loadFull()} className="self-start">
                Load full payload ({m.payloadSize.toLocaleString()} bytes)
              </Button>
            ) : (
              <p className="text-caption-1 text-fg-muted">This system cannot fetch the message again; the first {m.payloadRaw.length.toLocaleString()} bytes are shown.</p>
            )
          ) : null}
          {loadError ? <p className="text-caption-1 text-danger-fg">{loadError}</p> : null}
          <ValueView text={fullText ?? m.payloadText} codec={full ? "utf8" : m.payloadCodec} raw={raw} label="Value" />
        </TabsContent>
        {m.keyRaw !== null ? (
          <TabsContent value="key" className="flex min-h-0 flex-1 flex-col overflow-auto p-inset-sm">
            <ValueView text={m.keyText} codec={m.keyCodec} raw={m.keyRaw} label={labels.key} />
          </TabsContent>
        ) : null}
        <TabsContent value="headers" className="min-h-0 flex-1 overflow-auto p-inset-sm">
          {m.headers && m.headers.length > 0 ? (
            <DescriptionList>
              {m.headers.map(([name, value, encoding], i) => (
                <DescriptionListItem key={`${name}-${i}`}>
                  <DescriptionListTerm>{name}</DescriptionListTerm>
                  <DescriptionListDetails>
                    <span className="font-mono">{value}</span> {encoding === "base64" ? <Badge appearance="tint" variant="neutral">base64</Badge> : null}
                  </DescriptionListDetails>
                </DescriptionListItem>
              ))}
            </DescriptionList>
          ) : (
            <EmptyLine>No headers.</EmptyLine>
          )}
        </TabsContent>
        <TabsContent value="raw" className="flex min-h-0 flex-1 flex-col p-inset-sm">
          <HexView aria-label="Raw value" bytes={raw} className="min-h-0 flex-1" />
        </TabsContent>
        <TabsContent value="schema" className="flex min-h-0 flex-1 flex-col gap-stack-xs overflow-auto p-inset-sm">
          {m.schemaRef ? (
            <>
              <p className="text-body-1 text-fg">
                Decoded with <span className="font-mono">{m.schemaRef}</span>
                {ref?.messageType ? ` (message ${ref.messageType})` : ""}.
              </p>
              {loadSchema && ref ? (
                schemaText === null ? (
                  <Button appearance="secondary" size="small" className="self-start" onClick={() => void showSchema()}>
                    Show the schema
                  </Button>
                ) : (
                  <SchemaText text={schemaText} />
                )
              ) : null}
            </>
          ) : (
            <EmptyLine>No schema: decoded as {m.payloadCodec}.</EmptyLine>
          )}
        </TabsContent>
        <TabsContent value="metadata" className="min-h-0 flex-1 overflow-auto p-inset-sm">
          <DescriptionList>
            <Meta term={labels.source} value={m.source} />
            {m.subject !== null ? <Meta term={m.operation !== null ? "Key" : "Subject"} value={m.subject} /> : null}
            {m.partition !== null ? <Meta term="Partition" value={String(m.partition)} /> : null}
            {m.offset !== null ? <Meta term="Offset" value={m.offset} /> : null}
            {m.sequence !== null ? <Meta term={labels.position} value={m.sequence} /> : null}
            <Meta term="Timestamp" value={`${timestampText(m.timestampUs)} (${m.timestampKind})`} />
            <Meta term="Size" value={`${m.payloadSize.toLocaleString()} bytes${m.payloadTruncated ? ` (first ${m.payloadRaw.length.toLocaleString()} inline)` : ""}`} />
            {m.replyTo !== null ? <Meta term="Reply subject" value={m.replyTo} /> : null}
            {m.operation !== null ? <Meta term="Operation" value={m.operation} /> : null}
            <Meta term="Codecs" value={`value ${m.payloadCodec}${m.keyCodec ? `, key ${m.keyCodec}` : ""}`} />
          </DescriptionList>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Meta({ term, value }: { term: string; value: string }) {
  return (
    <DescriptionListItem>
      <DescriptionListTerm>{term}</DescriptionListTerm>
      <DescriptionListDetails className="font-mono">{value}</DescriptionListDetails>
    </DescriptionListItem>
  );
}
