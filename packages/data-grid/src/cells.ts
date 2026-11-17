// Cell values read straight from Arrow buffers (DBee spec §6, Decision 18). A `ColumnFormat` is
// built once per schema field and then reads any batch's column of that field: validity through
// `arrowIsValid`, then the typed buffer. Nothing is boxed per row: a cell becomes a string only
// when it is about to be shown or copied.
//
// - Int64 / Uint64 are BigInt (`toString`), never Number.
// - Utf8 is decoded per cell; the display cuts at 1,000 UTF-16 units with an ellipsis and shows
//   newlines as ↵; `value` is the full text (viewer, copy).
// - NULL is `null` (the grid shows the text NULL); the empty string stays "".
// - Dates and times are computed with integer arithmetic (no `Date`), so every Int32 day and
//   Int64 microsecond the driver can send has a text. The driver sends PostgreSQL's ±infinity as
//   the type's minimum and maximum; they read "-infinity" / "infinity".
import { type ArrowData, type ArrowField, arrowIsValid } from "@byterygon/ambidex/arrow";

/** The data.type.* role family of a column (header glyph and colour). */
export type TypeFamily = "integer" | "decimal" | "text" | "boolean" | "datetime" | "json" | "binary" | "uuid";

export type CellAlign = "start" | "end" | "center";

/** How one column is read and shown. */
export interface ColumnFormat {
  readonly family: TypeFamily;
  readonly align: CellAlign;
  /**
   * The type the header shows, as users name it (TSK-64): `pg.type_name` metadata when present, else
   * the PostgreSQL name of a built-in type OID (`bigint`, `timestamptz`), else a name derived from
   * the Arrow type (`integer`, `text`); a type the grid does not know keeps its Arrow name.
   */
  readonly label: string;
  /** The Arrow type as the stream carries it (`Int64`, `Dictionary<Int32, Utf8>`), for the header's tooltip. */
  readonly arrowType: string;
  /** The text in the cell, or `null` for NULL. Cut to `DISPLAY_LIMIT` with newlines as ↵. */
  display(data: ArrowData, row: number): string | null;
  /** The full value (viewer, copy), or `null` for NULL. */
  value(data: ArrowData, row: number): string | null;
}

/** Display cut for text cells, in UTF-16 code units. */
export const DISPLAY_LIMIT = 1000;
/** Bytes of a binary value shown in the cell. */
export const BINARY_PREVIEW = 32;

/** apache-arrow's `Type` enum, the values `ArrowField.typeId` carries. */
const TypeId = {
  Null: 1,
  Int: 2,
  Float: 3,
  Binary: 4,
  Utf8: 5,
  Bool: 6,
  Date: 8,
  Time: 9,
  Timestamp: 10,
  FixedSizeBinary: 15,
  LargeBinary: 19,
  LargeUtf8: 20,
  Dictionary: -1,
} as const;

/** The metadata key the PostgreSQL driver puts the type OID under (`TYPE_OID_METADATA`). */
export const PG_TYPE_OID = "byterygon.pg.type_oid";
/** The PostgreSQL type name, when the driver sends it (Decision 20). */
export const PG_TYPE_NAME = "pg.type_name";
const EXTENSION = "ARROW:extension:name";

const JSON_OIDS = new Set(["114", "3802"]);

/**
 * Names of PostgreSQL's built-in types by OID (pg_type.dat; these OIDs are fixed across versions).
 * Extension types (PostGIS geometry) have per-database OIDs and are not here.
 */
const PG_TYPE_NAMES: Readonly<Record<string, string>> = {
  "16": "boolean", "17": "bytea", "18": "char", "19": "name", "20": "bigint", "21": "smallint", "23": "integer", "25": "text", "26": "oid",
  "114": "json", "142": "xml", "650": "cidr", "700": "real", "701": "double precision", "790": "money", "829": "macaddr", "869": "inet",
  "1042": "character", "1043": "varchar", "1082": "date", "1083": "time", "1114": "timestamp", "1184": "timestamptz", "1186": "interval",
  "1266": "timetz", "1560": "bit", "1562": "varbit", "1700": "numeric", "2950": "uuid", "3614": "tsvector", "3802": "jsonb",
  "199": "json[]", "1000": "boolean[]", "1005": "smallint[]", "1007": "integer[]", "1009": "text[]", "1015": "varchar[]", "1016": "bigint[]",
  "1021": "real[]", "1022": "double precision[]", "1115": "timestamp[]", "1182": "date[]", "1185": "timestamptz[]", "1231": "numeric[]",
  "2951": "uuid[]", "3807": "jsonb[]",
};

/** A user-facing name from the Arrow type when no PostgreSQL name is known. */
function arrowLabel(type: string, family: TypeFamily): string {
  if (family === "uuid") return "uuid";
  if (family === "json") return "json";
  if (/^(Large)?Utf8$/.test(type)) return "text";
  if (type === "Bool") return "boolean";
  if (type === "Int16") return "smallint";
  if (type === "Int32") return "integer";
  if (type === "Int64") return "bigint";
  if (/^U?Int(8|16|32|64)$/.test(type)) return "integer";
  if (type === "Float32") return "real";
  if (type === "Float64") return "double precision";
  if (/^Decimal/.test(type)) return "numeric";
  if (/^Date/.test(type)) return "date";
  if (/^Time(32|64)?</.test(type) || /^Time(32|64)$/.test(type)) return "time";
  if (/^Timestamp</.test(type)) return /, [^>]+>$/.test(type) ? "timestamptz" : "timestamp";
  if (/^(Large)?Binary$|^FixedSizeBinary/.test(type)) return "binary";
  return type;
}
const NUMERIC_OID = "1700";

type Read = (data: ArrowData, i: number) => string;

const utf8 = new TextDecoder();

const HEX: string[] = Array.from({ length: 256 }, (_, b) => b.toString(16).padStart(2, "0"));

function hex(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += HEX[bytes[i]!]!;
  return out;
}

/** The element's slice `[start, end)` of `values` for Utf8 and Binary (`i` includes the offset). */
function bounds(data: ArrowData, i: number): [number, number] {
  const offsets = data.offsets!;
  const start = Number(offsets[i]!);
  return [start, Number(offsets[i + 1] ?? start)];
}

const NEWLINES = /\r\n|[\n\r]/g;

/** Cut to `DISPLAY_LIMIT` units (never between a surrogate pair) and show newlines as ↵. */
export function displayText(text: string, cut = false): string {
  let out = text;
  if (out.length > DISPLAY_LIMIT) {
    let end = DISPLAY_LIMIT;
    const unit = out.charCodeAt(end - 1);
    if (unit >= 0xd800 && unit <= 0xdbff) end -= 1;
    out = out.slice(0, end);
    cut = true;
  }
  if (out.indexOf("\n") >= 0 || out.indexOf("\r") >= 0) out = out.replace(NEWLINES, "↵");
  return cut ? `${out}…` : out;
}

const utf8Value: Read = (data, i) => {
  const [start, end] = bounds(data, i);
  return utf8.decode((data.values as Uint8Array).subarray(start, end));
};

// At most 4 bytes per code point: decoding 4 * limit + 4 bytes yields more than `limit` units
// whenever the value is longer, so a 10 MB text costs a few kB to display.
const utf8Display: Read = (data, i) => {
  const [start, end] = bounds(data, i);
  const max = 4 * DISPLAY_LIMIT + 4;
  const values = data.values as Uint8Array;
  if (end - start <= max) return displayText(utf8.decode(values.subarray(start, end)));
  return displayText(utf8.decode(values.subarray(start, start + max)), true);
};

const binaryValue: Read = (data, i) => {
  const [start, end] = bounds(data, i);
  return `\\x${hex(data.values as Uint8Array, start, end)}`;
};

const binaryDisplay: Read = (data, i) => {
  const [start, end] = bounds(data, i);
  const n = end - start;
  const shown = `\\x${hex(data.values as Uint8Array, start, start + Math.min(n, BINARY_PREVIEW))}`;
  return n > BINARY_PREVIEW ? `${shown}… (${n} bytes)` : shown;
};

function fixedBinary(width: number, preview: boolean): Read {
  return (data, i) => {
    const start = i * width;
    const values = data.values as Uint8Array;
    if (!preview || width <= BINARY_PREVIEW) return `\\x${hex(values, start, start + width)}`;
    return `\\x${hex(values, start, start + BINARY_PREVIEW)}… (${width} bytes)`;
  };
}

const uuidRead: Read = (data, i) => {
  const v = data.values as Uint8Array;
  const s = i * 16;
  return `${hex(v, s, s + 4)}-${hex(v, s + 4, s + 6)}-${hex(v, s + 6, s + 8)}-${hex(v, s + 8, s + 10)}-${hex(v, s + 10, s + 16)}`;
};

const boolRead: Read = (data, i) => (((data.values as Uint8Array)[i >> 3]! & (1 << (i & 7))) !== 0 ? "true" : "false");

const numberRead: Read = (data, i) => String((data.values as ArrayLike<number | bigint>)[i]);

/** Shortest text that reads back as the same double (JavaScript's own), keeping -0. */
export function formatFloat64(x: number): string {
  return Object.is(x, -0) ? "-0" : String(x);
}

/** Shortest text that reads back as the same float32 (a widened float32 would print 17 digits). */
export function formatFloat32(x: number): string {
  if (!Number.isFinite(x) || x === 0) return formatFloat64(x);
  for (let p = 1; p < 10; p++) {
    const n = Number(x.toPrecision(p));
    if (Math.fround(n) === x) return String(n);
  }
  return String(x);
}

const float64Read: Read = (data, i) => formatFloat64((data.values as Float64Array)[i]!);
const float32Read: Read = (data, i) => formatFloat32((data.values as Float32Array)[i]!);

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** Year, month, day of a day count from 1970-01-01 (proleptic Gregorian, any integer). */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [yoe + era * 400 + (m <= 2 ? 1 : 0), m, d];
}

/** `YYYY-MM-DD`; years before 1 are shown as PostgreSQL does, `YYYY-MM-DD BC` (year 0 is 1 BC). */
function isoDate(days: number): { text: string; bc: boolean } {
  const [y, m, d] = civilFromDays(days);
  const bc = y <= 0;
  const year = bc ? 1 - y : y;
  return { text: `${String(year).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`, bc };
}

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function date32(days: number): string {
  if (days === INT32_MIN) return "-infinity";
  if (days === INT32_MAX) return "infinity";
  const { text, bc } = isoDate(days);
  return bc ? `${text} BC` : text;
}

/** Units per second and fraction digits of an Arrow time unit name. */
function unitOf(name: string | undefined): { perSecond: bigint; digits: number } {
  switch (name) {
    case "SECOND":
      return { perSecond: 1n, digits: 0 };
    case "MILLISECOND":
      return { perSecond: 1000n, digits: 3 };
    case "NANOSECOND":
      return { perSecond: 1_000_000_000n, digits: 9 };
    default:
      return { perSecond: 1_000_000n, digits: 6 };
  }
}

/** `HH:MM:SS[.fraction]` of a non-negative count of units since midnight, trailing zeros trimmed. */
function timeOfDay(units: bigint, perSecond: bigint, digits: number): string {
  const seconds = units / perSecond;
  const fraction = units % perSecond;
  const s = Number(seconds);
  const text = `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;
  if (fraction === 0n || digits === 0) return text;
  return `${text}.${fraction.toString().padStart(digits, "0").replace(/0+$/, "")}`;
}

function toBigInt(x: number | bigint): bigint {
  return typeof x === "bigint" ? x : BigInt(x);
}

function timeRead(unit: string | undefined): Read {
  const { perSecond, digits } = unitOf(unit);
  return (data, i) => timeOfDay(toBigInt((data.values as ArrayLike<number | bigint>)[i]!), perSecond, digits);
}

function timestampRead(unit: string | undefined, zoned: boolean): Read {
  const { perSecond, digits } = unitOf(unit);
  const perDay = perSecond * 86_400n;
  return (data, i) => {
    const v = toBigInt((data.values as ArrayLike<number | bigint>)[i]!);
    if (v === INT64_MIN) return "-infinity";
    if (v === INT64_MAX) return "infinity";
    let days = v / perDay;
    let rest = v % perDay;
    if (rest < 0n) {
      rest += perDay;
      days -= 1n;
    }
    const { text, bc } = isoDate(Number(days));
    const out = `${text} ${timeOfDay(rest, perSecond, digits)}${zoned ? "+00:00" : ""}`;
    return bc ? `${out} BC` : out;
  };
}

/** The type name without a dictionary wrapper: `Dictionary<Int32, Utf8>` is read as `Utf8`. */
function familyOf(field: ArrowField, type: string, typeId: number): TypeFamily {
  const oid = field.metadata[PG_TYPE_OID];
  const pgName = field.metadata[PG_TYPE_NAME];
  if (field.metadata[EXTENSION] === "arrow.uuid" || pgName === "uuid") return "uuid";
  if (field.metadata[EXTENSION] === "arrow.json" || (oid !== undefined && JSON_OIDS.has(oid)) || pgName === "json" || pgName === "jsonb") return "json";
  if (oid === NUMERIC_OID || (pgName !== undefined && /^numeric|^decimal/.test(pgName))) return "decimal";
  switch (typeId) {
    case TypeId.Int:
      return "integer";
    case TypeId.Float:
      return "decimal";
    case TypeId.Bool:
      return "boolean";
    case TypeId.Date:
    case TypeId.Time:
    case TypeId.Timestamp:
      return "datetime";
    case TypeId.Binary:
    case TypeId.LargeBinary:
    case TypeId.FixedSizeBinary:
      return "binary";
    default:
      if (/^Decimal/.test(type)) return "decimal";
      if (/^(Duration|Interval)/.test(type)) return "datetime";
      return "text";
  }
}

function alignOf(family: TypeFamily): CellAlign {
  if (family === "integer" || family === "decimal") return "end";
  if (family === "boolean") return "center";
  return "start";
}

interface Readers {
  display: Read;
  value: Read;
}

const same = (read: Read): Readers => ({ display: read, value: read });

/** The readers of a type, or `undefined` when the grid cannot read it. */
function readersOf(field: ArrowField, type: string, typeId: number): Readers | undefined {
  switch (typeId) {
    case TypeId.Bool:
      return same(boolRead);
    case TypeId.Int:
      return same(numberRead);
    case TypeId.Float:
      if (type === "Float32") return same(float32Read);
      if (type === "Float64") return same(float64Read);
      return same(numberRead);
    case TypeId.Utf8:
    case TypeId.LargeUtf8:
      return { display: utf8Display, value: utf8Value };
    case TypeId.Binary:
    case TypeId.LargeBinary:
      return { display: binaryDisplay, value: binaryValue };
    case TypeId.FixedSizeBinary: {
      const width = Number(/\[(\d+)\]|<(\d+)>/.exec(type)?.slice(1).find((x) => x !== undefined) ?? 0);
      if (width === 16 && field.metadata[EXTENSION] === "arrow.uuid") return same(uuidRead);
      return { display: fixedBinary(width, true), value: fixedBinary(width, false) };
    }
    case TypeId.Date:
      if (/MILLISECOND/.test(type)) {
        return same((data, i) => {
          const ms = toBigInt((data.values as ArrayLike<number | bigint>)[i]!);
          let days = ms / 86_400_000n;
          if (ms % 86_400_000n < 0n) days -= 1n;
          return date32(Number(days));
        });
      }
      return same((data, i) => date32((data.values as Int32Array)[i]!));
    case TypeId.Time:
      return same(timeRead(/<(\w+)>/.exec(type)?.[1]));
    case TypeId.Timestamp: {
      const m = /^Timestamp<(\w+)(?:, (.+))?>$/.exec(type);
      return same(timestampRead(m?.[1], m?.[2] !== undefined));
    }
    default:
      return undefined;
  }
}

/** A cell of a type the grid does not read: its Arrow type in angle brackets. */
const unknownReaders = (type: string): Readers => same(() => `<${type}>`);

const dictionaryValueType = (type: string): string | undefined => /^Dictionary<[^,]+, (.+)>$/.exec(type)?.[1];

/** The column format of `field`; read every batch's column of that field with it. */
export function columnFormat(field: ArrowField): ColumnFormat {
  const dictValue = field.typeId === TypeId.Dictionary ? dictionaryValueType(field.type) : undefined;
  const type = dictValue ?? field.type;
  // A dictionary's values carry their own type id; derive it from the printed name.
  const typeId = dictValue === undefined ? field.typeId : typeIdOfName(dictValue);
  const family = familyOf(field, type, typeId);
  const inner = typeId === TypeId.Null ? undefined : (readersOf(field, type, typeId) ?? unknownReaders(type));
  const oid = field.metadata[PG_TYPE_OID];
  const label = field.metadata[PG_TYPE_NAME] ?? (oid !== undefined ? PG_TYPE_NAMES[oid] : undefined) ?? arrowLabel(type, family);

  const read = (pick: keyof Readers) => {
    if (inner === undefined) return () => null;
    const direct = inner[pick];
    return (data: ArrowData, row: number): string | null => {
      if (!arrowIsValid(data, row)) return null;
      const i = data.offset + row;
      if (data.dictionary === undefined) return direct(data, i);
      // Dictionary-encoded: the value sits in the dictionary at the index stored here.
      let rest = Number((data.values as ArrayLike<number | bigint>)[i]);
      for (const chunk of data.dictionary) {
        if (rest < chunk.length) return arrowIsValid(chunk, rest) ? direct(chunk, chunk.offset + rest) : null;
        rest -= chunk.length;
      }
      return null;
    };
  };
  return { family, align: alignOf(family), label, arrowType: field.type, display: read("display"), value: read("value") };
}

function typeIdOfName(type: string): number {
  if (/^U?[Ii]nt(8|16|32|64)$/.test(type)) return TypeId.Int;
  if (/^Float/.test(type)) return TypeId.Float;
  if (type === "Utf8") return TypeId.Utf8;
  if (type === "LargeUtf8") return TypeId.LargeUtf8;
  if (type === "Binary") return TypeId.Binary;
  if (type === "Bool") return TypeId.Bool;
  if (/^Date/.test(type)) return TypeId.Date;
  if (/^Time\d/.test(type)) return TypeId.Time;
  if (/^Timestamp/.test(type)) return TypeId.Timestamp;
  return 0;
}

/** The glyph shown before a column's name, per family; the type is also in text (never colour alone). */
export const TYPE_GLYPHS: Readonly<Record<TypeFamily, string>> = {
  integer: "#",
  decimal: "#.#",
  text: "Aa",
  boolean: "T/F",
  datetime: "◷",
  json: "{}",
  binary: "01",
  uuid: "id",
};
