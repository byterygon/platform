// The codec selects of a message view (Mightyconsole spec §5.2 "Override"): Auto plus every codec,
// for the key and the value; the choice goes into the stream's `decode` and stays with the tab.
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectItem } from "@/components/ui/select";
import type { CodecChoice, CodecId } from "@/gen/api";

export const CODECS: readonly { id: CodecId | "auto"; label: string }[] = [
  { id: "auto", label: "Auto" },
  { id: "utf8", label: "UTF-8 text" },
  { id: "json", label: "JSON" },
  { id: "hex", label: "Hex" },
  { id: "base64", label: "Base64" },
  { id: "msgpack", label: "MessagePack" },
  { id: "cbor", label: "CBOR" },
  { id: "avro", label: "Avro" },
  { id: "protobuf", label: "Protobuf" },
  { id: "jsonschema", label: "JSON Schema" },
];

export function CodecSelect({ label, value, onChange }: { label: string; value: CodecChoice; onChange(choice: CodecChoice): void }) {
  const current = (value.codec ?? "auto") as CodecId | "auto";
  return (
    <Field className="w-auto">
      <FieldLabel>{label}</FieldLabel>
      <Select<CodecId | "auto">
        size="small"
        items={CODECS.map((c) => ({ value: c.id, label: c.label }))}
        value={current}
        onValueChange={(next) => onChange({ ...value, codec: (next ?? "auto") as NonNullable<CodecChoice["codec"]> })}
      >
        {CODECS.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.label}
          </SelectItem>
        ))}
      </Select>
    </Field>
  );
}
