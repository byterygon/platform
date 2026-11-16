// Cell values straight from Arrow buffers (DBee spec §6, Decision 18) for the minimal results table
// that stands in until the data grid (TSK-39): Int64 as BigInt, Utf8 decoded per cell, NULL from
// the validity bitmap, timestamps in UTC. Types this reader does not know show their Arrow type.
import { type ArrowData, type ArrowField, arrowIsValid } from "@byterygon/ambidex/arrow";

export type Cell = { kind: "null" } | { kind: "value"; text: string; align: "start" | "end" } | { kind: "other"; type: string };

const utf8 = new TextDecoder();

/** The TypeBadge family of an Arrow field (spec §6 table). */
/** `Dictionary<Int32, Utf8>` is read as its value type. */
const valueType = (t: string): string => /^Dictionary<[^,]+, (.+)>$/.exec(t)?.[1] ?? t;

export function typeFamily(field: ArrowField): "integer" | "decimal" | "text" | "boolean" | "datetime" | "json" | "binary" | "uuid" {
  const t = valueType(field.type);
  const meta = field.metadata["pg.type_name"] ?? "";
  if (/^Int|^Uint/.test(t)) return "integer";
  if (/^Float|^Decimal/.test(t)) return "decimal";
  if (t === "Bool") return "boolean";
  if (/^Timestamp|^Date|^Time|^Duration|^Interval/.test(t)) return "datetime";
  if (/json/i.test(meta) || field.metadata["ARROW:extension:name"] === "arrow.json") return "json";
  if (/^Binary|^LargeBinary|^FixedSizeBinary/.test(t)) return meta === "uuid" || field.metadata["ARROW:extension:name"] === "arrow.uuid" ? "uuid" : "binary";
  return "text";
}

/** The type shown in the header: the PostgreSQL type when the driver sent it, else the Arrow type. */
export function typeLabel(field: ArrowField): string {
  return field.metadata["pg.type_name"] ?? valueType(field.type);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function timestamp(value: bigint, unit: string, zoned: boolean): string {
  let ms: bigint;
  let fraction = "";
  switch (unit) {
    case "SECOND":
      ms = value * 1000n;
      break;
    case "MILLISECOND":
      ms = value;
      break;
    case "MICROSECOND":
      ms = value / 1000n;
      fraction = pad(Number(((value % 1000n) + 1000n) % 1000n), 3);
      break;
    default:
      ms = value / 1_000_000n;
      fraction = pad(Number(((value % 1_000_000n) + 1_000_000n) % 1_000_000n), 6);
  }
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return value.toString();
  const text = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}${fraction ? `.${fraction}` : ""}`;
  return zoned ? `${text} UTC` : text;
}

function hex(bytes: Uint8Array): string {
  let out = "\\x";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function uuid(bytes: Uint8Array): string {
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function sliceVariable(data: ArrowData, row: number): Uint8Array | undefined {
  const offsets = data.offsets;
  const values = data.values;
  if (offsets === undefined || !(values instanceof Uint8Array)) return undefined;
  const i = data.offset + row;
  const start = Number(offsets[i] ?? 0);
  const end = Number(offsets[i + 1] ?? start);
  return values.subarray(start, end);
}

/** Decimal128 or 256 as text: the little-endian two's-complement integer scaled by `scale`. */
function decimal(values: ArrowData["values"], row: number, offset: number, bytes: number, scale: number): string | undefined {
  if (!(values instanceof Uint8Array) && !(values instanceof Uint32Array) && !(values instanceof Int32Array) && !(values instanceof BigInt64Array) && !(values instanceof BigUint64Array)) return undefined;
  const raw = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const start = (offset + row) * bytes;
  const slice = raw.subarray(start, start + bytes);
  if (slice.length !== bytes) return undefined;
  let n = 0n;
  for (let i = bytes - 1; i >= 0; i--) n = (n << 8n) | BigInt(slice[i] ?? 0);
  if (slice[bytes - 1]! & 0x80) n -= 1n << BigInt(bytes * 8);
  const negative = n < 0n;
  let digits = (negative ? -n : n).toString();
  if (scale > 0) {
    digits = digits.padStart(scale + 1, "0");
    digits = `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  }
  return `${negative ? "-" : ""}${digits}`;
}

/** The text of cell `row` of column `data` (its schema field is `field`). */
export function readCell(field: ArrowField, data: ArrowData, row: number): Cell {
  if (!arrowIsValid(data, row)) return { kind: "null" };
  const t = data.type;
  const i = data.offset + row;
  const v = data.values;
  const num = (text: string): Cell => ({ kind: "value", text, align: "end" });
  const str = (text: string): Cell => ({ kind: "value", text, align: "start" });
  if (t === "Null") return { kind: "null" };
  if (data.dictionary !== undefined) {
    // Dictionary-encoded: the value sits in the dictionary at the index stored here.
    const index = v === undefined ? undefined : v[i];
    if (index === undefined) return { kind: "other", type: t };
    let rest = Number(index);
    for (const chunk of data.dictionary) {
      if (rest < chunk.length) return readCell(field, chunk, rest);
      rest -= chunk.length;
    }
    return { kind: "other", type: t };
  }
  if (t === "Bool") {
    if (!(v instanceof Uint8Array)) return { kind: "other", type: t };
    return str(((v[i >> 3] ?? 0) & (1 << (i & 7))) !== 0 ? "true" : "false");
  }
  if (/^(Int|Uint)(8|16|32)$/.test(t) || /^Float(16|32|64)$/.test(t)) {
    const x = v === undefined ? undefined : v[i];
    return x === undefined ? { kind: "other", type: t } : num(typeof x === "bigint" ? x.toString() : String(x));
  }
  if (t === "Int64" || t === "Uint64") {
    const x = v === undefined ? undefined : v[i];
    return x === undefined ? { kind: "other", type: t } : num(x.toString());
  }
  if (t === "Utf8" || t === "LargeUtf8") {
    const bytes = sliceVariable(data, row);
    return bytes === undefined ? { kind: "other", type: t } : str(utf8.decode(bytes));
  }
  if (t === "Binary" || t === "LargeBinary") {
    const bytes = sliceVariable(data, row);
    return bytes === undefined ? { kind: "other", type: t } : str(hex(bytes));
  }
  const fixed = /^FixedSizeBinary<(\d+)>$/.exec(t);
  if (fixed && v instanceof Uint8Array) {
    const width = Number(fixed[1]);
    const bytes = v.subarray(i * width, (i + 1) * width);
    const isUuid = width === 16 && (field.metadata["ARROW:extension:name"] === "arrow.uuid" || field.metadata["pg.type_name"] === "uuid");
    return str(isUuid ? uuid(bytes) : hex(bytes));
  }
  const ts = /^Timestamp<(\w+)(?:, (.+))?>$/.exec(t);
  if (ts) {
    const x = v === undefined ? undefined : v[i];
    if (x === undefined) return { kind: "other", type: t };
    return str(timestamp(typeof x === "bigint" ? x : BigInt(x), ts[1] ?? "MICROSECOND", ts[2] !== undefined));
  }
  if (t === "Date32") {
    const x = v === undefined ? undefined : v[i];
    if (x === undefined) return { kind: "other", type: t };
    const d = new Date(Number(x) * 86_400_000);
    return str(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  if (t === "Date64") {
    const x = v === undefined ? undefined : v[i];
    if (x === undefined) return { kind: "other", type: t };
    const d = new Date(Number(x));
    return str(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`);
  }
  const dec = /^Decimal(128|256)?\[(\d+)e(-?\d+)\]$|^Decimal<(\d+), (-?\d+)(?:, (\d+))?>$/.exec(t);
  if (dec) {
    const bits = dec[1] !== undefined ? Number(dec[1]) : dec[6] !== undefined ? Number(dec[6]) : 128;
    const scale = Number(dec[3] ?? dec[5] ?? 0);
    const text = decimal(v, row, data.offset, bits / 8, Math.abs(scale));
    return text === undefined ? { kind: "other", type: t } : num(text);
  }
  return { kind: "other", type: t };
}
