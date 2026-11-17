// Every type of the DBee spec §6 table, read from buffers the real decoder produced.
import type { ArrowData, ArrowField } from "@byterygon/ambidex/arrow";
import { describe, expect, test } from "vitest";
import { BatchIndex, civilFromDays, columnFormat, DISPLAY_LIMIT, displayText, formatFloat32 } from "../src/index.ts";
import { decoded, driverTable } from "./support.ts";

const { fields, batches } = await decoded(driverTable());
const batch = batches[0]!;

function column(name: string): { field: ArrowField; data: ArrowData } {
  const i = fields.findIndex((f) => f.name === name);
  return { field: fields[i]!, data: batch.columns[i]! };
}

function shown(name: string): (string | null)[] {
  const { field, data } = column(name);
  const format = columnFormat(field);
  return Array.from({ length: batch.numRows }, (_, row) => format.display(data, row));
}

function values(name: string): (string | null)[] {
  const { field, data } = column(name);
  const format = columnFormat(field);
  return Array.from({ length: batch.numRows }, (_, row) => format.value(data, row));
}

const hex = (bytes: Iterable<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const isoDay = (days: number) => new Date(days * 86_400_000).toISOString().slice(0, 10);

describe("the driver's types", () => {
  test("the decoder hands the grid one batch with every column", () => {
    expect(batches).toHaveLength(1);
    expect(batch.numRows).toBe(4);
    expect(fields.map((f) => f.type)).toEqual([
      "Bool",
      "Int16",
      "Int32",
      "Int64",
      "Uint32",
      "Float32",
      "Float64",
      "Utf8",
      "Binary",
      "FixedSizeBinary[16]",
      "Date32<DAY>",
      "Time64<MICROSECOND>",
      "Timestamp<MICROSECOND>",
      "Timestamp<MICROSECOND, UTC>",
    ]);
  });

  test("bool reads the bit-packed values", () => {
    expect(shown("b")).toEqual(["true", "false", null, "true"]);
  });

  test("integers are decimal, without grouping", () => {
    expect(shown("i2")).toEqual(["-32768", "0", null, "32767"]);
    expect(shown("i4")).toEqual(["-2147483648", "42", null, "2147483647"]);
    expect(shown("oid")).toEqual(["4294967295", "26", null, "0"]);
  });

  test("Int64 is BigInt: no precision lost past 2^53", () => {
    expect(column("i8").data.values).toBeInstanceOf(BigInt64Array);
    expect(shown("i8")).toEqual(["9223372036854775807", "-9223372036854775808", null, "9007199254740993"]);
  });

  test("floats are the shortest round-trip text; NaN, Infinity and -0 as text", () => {
    expect(shown("f4")).toEqual(["0.1", "-0", null, "NaN"]);
    expect(shown("f8")).toEqual(["0.1", "-0", "Infinity", "-Infinity"]);
    expect(formatFloat32(Math.fround(1 / 3))).toBe("0.33333334");
    expect(formatFloat32(Math.fround(16_777_217))).toBe("16777216");
    expect(formatFloat32(Math.fround(3.4e38))).toBe("3.4e+38");
  });

  test("Utf8: newlines as ↵, cut at 1,000 with an ellipsis; the value is the full text", () => {
    const long = "x".repeat(1200);
    expect(shown("t")).toEqual(["hello↵world", "", null, `${"x".repeat(DISPLAY_LIMIT)}…`]);
    expect(values("t")).toEqual(["hello\nworld", "", null, long]);
  });

  test("NULL is distinct from the empty string", () => {
    const t = shown("t");
    expect(t[1]).toBe("");
    expect(t[2]).toBeNull();
  });

  test("bytea: \\x hex of the first 32 bytes and the length", () => {
    const all = Array.from({ length: 40 }, (_, i) => i);
    expect(shown("by")).toEqual(["\\xdead", `\\x${hex(all.slice(0, 32))}… (40 bytes)`, null, "\\x"]);
    expect(values("by")[1]).toBe(`\\x${hex(all)}`);
  });

  test("uuid from the extension metadata, 8-4-4-4-12 lowercase", () => {
    expect(shown("u")).toEqual(["123e4567-e89b-12d3-a456-426614174000", null, "123e4567-e89b-12d3-a456-426614174000", null]);
  });

  test("date: ISO, and PostgreSQL's infinities", () => {
    expect(shown("d")).toEqual(["1970-01-01", isoDay(19_000), "-infinity", "infinity"]);
  });

  test("time: HH:MM:SS.ffffff with trailing zeros trimmed; 24:00:00 exists", () => {
    expect(shown("tm")).toEqual(["00:00:00", "12:34:56.123456", null, "24:00:00"]);
  });

  test("timestamp: no zone; timestamptz: UTC with +00:00", () => {
    expect(shown("ts")).toEqual(["2024-02-29 13:45:01.5", "1970-01-01 00:00:00", "-infinity", "infinity"]);
    expect(shown("tz")).toEqual(["1999-12-31 23:59:59.123456+00:00", null, "1969-12-31 23:59:59.999999+00:00", "2000-01-01 00:00:00+00:00"]);
  });

  test("families, alignment and header labels", () => {
    const of = (name: string) => {
      const f = columnFormat(column(name).field);
      return [f.family, f.align, f.label];
    };
    // The driver's fields carry the type OID: the label is the PostgreSQL name (TSK-64).
    expect(of("b")).toEqual(["boolean", "center", "boolean"]);
    expect(of("i8")).toEqual(["integer", "end", "bigint"]);
    expect(of("f8")).toEqual(["decimal", "end", "double precision"]);
    expect(of("t")).toEqual(["text", "start", "text"]);
    expect(of("by")).toEqual(["binary", "start", "bytea"]);
    expect(of("u")).toEqual(["uuid", "start", "uuid"]);
    expect(of("ts")[2]).toBe("timestamp");
    expect(of("tz")).toEqual(["datetime", "start", "timestamptz"]);
    expect(columnFormat(column("tz").field).arrowType).toBe("Timestamp<MICROSECOND, UTC>");
  });
});

describe("other columns", () => {
  const field = (type: string, typeId: number, metadata: Record<string, string> = {}): ArrowField => ({ name: "c", type, typeId, nullable: true, children: [], metadata });
  const utf8Data = (texts: string[]): ArrowData => {
    const enc = new TextEncoder();
    const parts = texts.map((t) => enc.encode(t));
    const offsets = new Int32Array(parts.length + 1);
    parts.forEach((p, i) => (offsets[i + 1] = offsets[i]! + p.length));
    const values = new Uint8Array(offsets[parts.length]!);
    parts.forEach((p, i) => values.set(p, offsets[i]!));
    return { type: "Utf8", typeId: 5, length: texts.length, nullCount: 0, offset: 0, offsets, values, children: [] };
  };

  test("json and numeric arrive as text; the OID gives the family", () => {
    expect(columnFormat(field("Utf8", 5, { "byterygon.pg.type_oid": "3802" })).family).toBe("json");
    const numeric = columnFormat(field("Utf8", 5, { "byterygon.pg.type_oid": "1700" }));
    expect([numeric.family, numeric.align]).toEqual(["decimal", "end"]);
    expect(numeric.display(utf8Data(["12.50"]), 0)).toBe("12.50");
  });

  test("pg.type_name, when the driver sends it, is the header label", () => {
    expect(columnFormat(field("Utf8", 5, { "pg.type_name": "numeric(12,2)" })).label).toBe("numeric(12,2)");
  });

  test("a built-in PostgreSQL type OID names the type; the Arrow type stays for the tooltip", () => {
    const of = (type: string, typeId: number, oid: string) => columnFormat(field(type, typeId, { "byterygon.pg.type_oid": oid }));
    expect(of("Int64", 2, "20").label).toBe("bigint");
    expect(of("Int32", 2, "23").label).toBe("integer");
    expect(of("Timestamp<MICROSECOND, UTC>", 10, "1184").label).toBe("timestamptz");
    expect(of("Utf8", 5, "1700").label).toBe("numeric");
    expect(of("Utf8", 5, "3802").label).toBe("jsonb");
    expect(of("Utf8", 5, "1043").label).toBe("varchar");
    const dict = of("Dictionary<Int32, Utf8>", -1, "25");
    expect([dict.label, dict.arrowType]).toEqual(["text", "Dictionary<Int32, Utf8>"]);
    // An extension type (PostGIS geometry: a per-database OID) falls back to the Arrow-derived name.
    expect(of("Utf8", 5, "18342").label).toBe("text");
  });

  test("a type the grid does not read shows its Arrow type", () => {
    const f = columnFormat(field("List<Int32>", 12));
    const data: ArrowData = { type: "List<Int32>", typeId: 12, length: 1, nullCount: 0, offset: 0, children: [] };
    expect(f.display(data, 0)).toBe("<List<Int32>>");
  });

  test("an array offset is honoured", () => {
    const data = { ...utf8Data(["a", "b", "c"]), offset: 1, length: 2 };
    const f = columnFormat(field("Utf8", 5));
    expect([f.display(data, 0), f.display(data, 1)]).toEqual(["b", "c"]);
  });

  test("dictionary-encoded text reads through the dictionary", () => {
    const dictionary = utf8Data(["red", "green"]);
    const data: ArrowData = { type: "Dictionary<Int32, Utf8>", typeId: -1, length: 3, nullCount: 0, offset: 0, values: Int32Array.of(1, 0, 1), children: [], dictionary: [dictionary] };
    const f = columnFormat(field("Dictionary<Int32, Utf8>", -1));
    expect([0, 1, 2].map((r) => f.display(data, r))).toEqual(["green", "red", "green"]);
  });
});

describe("helpers", () => {
  test("civilFromDays agrees with Date over centuries", () => {
    for (let days = -800_000; days <= 800_000; days += 997) {
      const d = new Date(days * 86_400_000);
      expect(civilFromDays(days)).toEqual([d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]);
    }
  });

  test("dates before year 1 read as PostgreSQL's BC", () => {
    const days = Date.parse("0000-12-31T00:00:00Z") / 86_400_000;
    const f = columnFormat({ name: "d", type: "Date32<DAY>", typeId: 8, nullable: true, children: [], metadata: {} });
    const data: ArrowData = { type: "Date32<DAY>", typeId: 8, length: 1, nullCount: 0, offset: 0, values: Int32Array.of(days), children: [] };
    expect(f.display(data, 0)).toBe("0001-12-31 BC");
  });

  test("the display cut never splits a surrogate pair", () => {
    const text = `${"a".repeat(DISPLAY_LIMIT - 1)}😀tail`;
    const out = displayText(text);
    expect(out).toBe(`${"a".repeat(DISPLAY_LIMIT - 1)}…`);
  });

  test("a long text is decoded only up to what the cell shows", async () => {
    const { fields, batches } = await decoded(driverTable());
    const index = new BatchIndex();
    index.append(batches[0]!);
    const t = fields.findIndex((f) => f.name === "t");
    expect(columnFormat(fields[t]!).display(batches[0]!.columns[t]!, 3)!.length).toBe(DISPLAY_LIMIT + 1);
  });
});
