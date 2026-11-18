import { HexView } from "@/components/hex-view/hex-view";

const encoder = new TextEncoder();

/** The smallest useful HexView. */
export function HexViewMinimal() {
  return <HexView bytes={encoder.encode("Hello, Mightyconsole")} className="h-panel-xs" aria-label="Payload bytes" />;
}

/** A Kafka value in the Confluent wire format: magic byte 0, the schema id, then Avro bytes. */
export function HexViewRealistic() {
  const body = encoder.encode("\u0008o-17\u0006c-9\u0002\u0004ÒPAID");
  const bytes = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x07, ...body, ...Array.from({ length: 64 }, (_, i) => (i * 37) & 0xff)]);
  return <HexView bytes={bytes} className="h-panel-xs" aria-label="Raw value of record 41" />;
}
