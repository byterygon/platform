// "Decode as…" (DOC-21 Open question 45 (p), mockup frame codecs-viewer): on a message that did not
// decode, try a codec, a schema and a type on its bytes (`messaging.decode`), then keep the choice
// as a mapping for its subject, stream or bucket, placed above the mapping that failed so it wins.
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { JsonView } from "@/app/json-view";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectSeparator } from "@/components/ui/select";
import type { CodecChoice, DecodeOutput, MappingTarget, Target } from "@/gen/api";
import { Save } from "@/lib/icons";
import type { MessageRow } from "../arrow";
import { type DecodeChoice, type SchemaChoice, decodeChoices } from "./model";

/** Where a message lives, for the mapping "Decode as…" keeps. */
export interface DecodePlace {
  /** The new mapping's target. */
  target: MappingTarget;
  /** Where the message lives, to find the mapping that applies to it now. */
  where: Target;
  /** In the system's words: "subject orders.legacy", "bucket sessions". */
  label: string;
}

/** What a tool gives the viewer for "Decode as…". */
export interface DecodeAs {
  choices: readonly SchemaChoice[];
  /** The mapping's target for a message; `null` when it cannot be mapped. */
  placeOf(message: MessageRow): DecodePlace | null;
  /** Decodes the bytes with a choice (`messaging.decode` on the connection). */
  preview(bytes: Uint8Array, choice: CodecChoice): Promise<DecodeOutput>;
  /** Saves the mapping (profile and server). */
  keep(message: MessageRow, place: DecodePlace, choice: CodecChoice): Promise<void>;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const JSON_CODECS = new Set(["json", "cbor", "msgpack", "avro", "protobuf", "jsonschema"]);

export function DecodeAsPanel({ message, decodeAs }: { message: MessageRow; decodeAs: DecodeAs }) {
  const options = useMemo(() => decodeChoices(decodeAs.choices), [decodeAs.choices]);
  const [picked, setPicked] = useState<DecodeChoice | null>(null);
  const [result, setResult] = useState<DecodeOutput | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const generation = useRef(0);
  const place = decodeAs.placeOf(message);
  useEffect(() => {
    setPicked(null);
    setResult(null);
    setFailure(null);
    setSaved(null);
  }, [message]);
  const pick = (key: string | null) => {
    const next = options.find((o) => o.key === key) ?? null;
    setPicked(next);
    setResult(null);
    setFailure(null);
    setSaved(null);
    if (!next) return;
    const mine = ++generation.current;
    decodeAs.preview(message.payloadRaw, next.choice).then(
      (r) => {
        if (mine === generation.current) setResult(r);
      },
      (e: unknown) => {
        if (mine === generation.current) setFailure(e instanceof Error ? e.message : String(e));
      },
    );
  };
  const keep = async () => {
    if (!picked || !place) return;
    setSaving(true);
    try {
      await decodeAs.keep(message, place, picked.choice);
      setSaved(`Kept as a mapping for ${place.label}. Messages read from now on decode with it.`);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const plain = options.filter((o) => !o.choice.schema);
  const withSchema = options.filter((o) => o.choice.schema);
  const decoded = result && !result.error;
  return (
    <section aria-label="Decode as" data-slot="decode-as" className="flex flex-col gap-stack-xs rounded-md border border-border-subtle p-inset-sm">
      <Field>
        <FieldLabel>Decode as</FieldLabel>
        <Select<string> size="small" items={options.map((o) => ({ value: o.key, label: o.label }))} value={picked?.key ?? null} onValueChange={pick} placeholder="Choose a codec or a schema">
          <SelectGroup>
            <SelectGroupLabel>No schema</SelectGroupLabel>
            {plain.map((o) => (
              <SelectItem key={o.key} value={o.key}>
                {o.label}
              </SelectItem>
            ))}
          </SelectGroup>
          {withSchema.length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectGroupLabel>With a schema</SelectGroupLabel>
                {withSchema.map((o) => (
                  <SelectItem key={o.key} value={o.key}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
        </Select>
        <FieldDescription>
          {place ? `Try it on this message, then keep it as a mapping for ${place.label}, above the one that applies now.` : "Try it on this message."}
        </FieldDescription>
      </Field>
      {failure ? (
        <Alert intent="danger">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
      {result?.error ? <p className="text-caption-1 text-danger-fg">{result.error}</p> : null}
      {decoded && result.text !== undefined ? (
        JSON_CODECS.has(result.codec) ? (
          <JsonView modeKey="messaging.decode-as" aria-label="Decoded as chosen" text={result.text} defaultExpandDepth={1} className="max-h-panel-xs" />
        ) : (
          <pre className="max-h-panel-xs overflow-auto font-mono text-caption-1 text-fg">{result.text}</pre>
        )
      ) : null}
      {saved ? <p className="text-caption-1 text-success-fg">{saved}</p> : null}
      {place ? (
        <Button appearance="primary" size="small" className="self-start" disabled={!decoded || saved !== null} loading={saving} onClick={() => void keep()}>
          <Icon icon={Save} /> Keep as a mapping for {place.label}
        </Button>
      ) : null}
    </section>
  );
}
