// Export and Copy of loaded messages (Mightyconsole spec §5.6): JSON Lines of
// `{ source, subject, partition, offset, sequence, timestamp, headers, key, value, keyCodec,
// valueCodec }`, client-side; raw bytes as base64 when they are not text.
import { type MessageRow, timestampText } from "./arrow";

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

/** A decoded JSON value when the codec gave JSON, else the text, else `{ base64 }` of the bytes. */
function part(text: string | null, codec: string | null, raw: Uint8Array | null): unknown {
  if (text !== null && codec !== null && ["json", "msgpack", "avro", "protobuf", "jsonschema"].includes(codec)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (text !== null && codec !== "hex" && codec !== "base64") return text;
  return raw === null ? null : { base64: toBase64(raw) };
}

/** One message as an export object. */
export function exportObject(m: MessageRow): Record<string, unknown> {
  return {
    source: m.source,
    subject: m.subject,
    partition: m.partition,
    offset: m.offset,
    sequence: m.sequence,
    timestamp: timestampText(m.timestampUs),
    headers: m.headers?.map(([name, value, encoding]) => (encoding === "text" ? { name, value } : { name, base64: value })) ?? null,
    key: m.keyRaw === null ? null : part(m.keyText, m.keyCodec, m.keyRaw),
    value: part(m.payloadText, m.payloadCodec, m.payloadRaw),
    keyCodec: m.keyCodec,
    valueCodec: m.payloadCodec,
  };
}

/** Messages as JSON Lines. */
export function toJsonLines(messages: Iterable<MessageRow>): string {
  let out = "";
  for (const m of messages) out += `${JSON.stringify(exportObject(m))}\n`;
  return out;
}

export { toBase64 };
