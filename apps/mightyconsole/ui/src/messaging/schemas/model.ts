// The decoding model of the messaging core (DOC-21 §4.2, §5.2; TSK-85 batch 4): a profile's local
// schemas (`extras.schemas`) and mappings (`extras.mappings`), subject matching as the server does
// it, the codec choices of the viewer's menu and of "Decode as…". Pure: NATS and Kafka share it.
import type { CodecChoice, CodecId, LocalSchema, MappingTarget, Part, SchemaMapping, SchemaType, Target } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { registryRefText } from "./registry";

export const CODEC_LABELS: Record<CodecId, string> = {
  utf8: "UTF-8 text",
  json: "JSON",
  hex: "Hex",
  base64: "Base64",
  msgpack: "MessagePack",
  cbor: "CBOR",
  avro: "Avro",
  protobuf: "Protobuf",
  jsonschema: "JSON Schema",
};

/** The codecs that need no schema, in the menu's order. */
export const PLAIN_CODECS: readonly CodecId[] = ["json", "cbor", "msgpack", "utf8", "hex", "base64"];
/** The codecs that read a schema. */
export const SCHEMA_CODECS: readonly CodecId[] = ["protobuf", "avro", "jsonschema"];

export const SCHEMA_TYPE_LABELS: Record<SchemaType, string> = { protobuf: "Protobuf", avro: "Avro", jsonschema: "JSON Schema" };

export function codecOfType(type: SchemaType): CodecId {
  return type;
}

export function needsSchema(codec: CodecId): boolean {
  return SCHEMA_CODECS.includes(codec);
}

// --- The profile's extras ------------------------------------------------------------------------

export function schemasOf(record: ProfileRecord): LocalSchema[] {
  const raw = record.extras["schemas"];
  return Array.isArray(raw) ? (raw as LocalSchema[]) : [];
}

export function mappingsOf(record: ProfileRecord): SchemaMapping[] {
  const raw = record.extras["mappings"];
  return Array.isArray(raw) ? (raw as SchemaMapping[]) : [];
}

export function withDecoding(record: ProfileRecord, schemas: readonly LocalSchema[], mappings: readonly SchemaMapping[]): ProfileRecord {
  return { ...record, extras: { ...record.extras, schemas: [...schemas], mappings: [...mappings] } };
}

/** A new id, unique within `taken`. */
export function newId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let n = 1; ; n += 1) {
    const id = `${prefix}${n}`;
    if (!used.has(id)) return id;
  }
}

// --- Matching (as `message_codecs::schema`) ------------------------------------------------------

/** NATS subject matching: tokens split on `.`, `*` one token, `>` (last) one or more. */
export function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; ; i += 1) {
    const a = p[i];
    const b = s[i];
    if (a === ">" && b !== undefined) return i === p.length - 1;
    if (a === undefined || b === undefined) return a === b;
    if (a !== "*" && a !== b) return false;
  }
}

export function mappingMatches(target: MappingTarget, where: Target): boolean {
  switch (target.kind) {
    case "subject":
      return where.kind === "subject" && subjectMatches(target.pattern, where.subject);
    case "stream":
      return where.kind === "subject" && where.stream === target.name;
    case "topic":
      return where.kind === "topic" && where.name === target.name;
    case "kvBucket":
      return where.kind === "kvBucket" && where.bucket === target.bucket;
  }
}

/** The first mapping that decodes a message (the server's rule: the first match wins). */
export function firstMapping(mappings: readonly SchemaMapping[], where: Target, part: Part): number {
  return mappings.findIndex((m) => m.part === part && mappingMatches(m.target, where));
}

/** Adds a mapping just above the one that decodes `where` now (at the end when none does). */
export function insertAbove(mappings: readonly SchemaMapping[], mapping: SchemaMapping, where: Target): SchemaMapping[] {
  const at = firstMapping(mappings, where, mapping.part);
  const out = [...mappings];
  out.splice(at < 0 ? out.length : at, 0, mapping);
  return out;
}

export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length || from === to) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item!);
  return out;
}

// --- Words ---------------------------------------------------------------------------------------

/** What a mapping applies to, in the system's words. */
export const TARGET_LABELS: Record<MappingTarget["kind"], string> = { subject: "subject", stream: "stream", kvBucket: "KV bucket", topic: "topic" };

export function targetText(t: MappingTarget): string {
  switch (t.kind) {
    case "subject":
      return t.pattern;
    case "stream":
      return t.name;
    case "topic":
      return t.name;
    case "kvBucket":
      return t.bucket;
  }
}

export function schemaSource(s: LocalSchema): string {
  if (!Array.isArray(s.files)) return "descriptor set";
  if (s.files.length === 1) return s.files[0]!.path;
  return `${s.files.length} files`;
}

/** Whether a mapping reads its schema from the registry: by subject or id, or the id in each message. */
export function usesRegistry(m: SchemaMapping): boolean {
  return Boolean(m.registry) || (!m.schemaId && m.wireFormat === "confluent" && m.codec !== undefined && m.codec !== null && needsSchema(m.codec));
}

/** The codec a mapping decodes with: its own, else its schema's. */
export function mappingCodec(m: SchemaMapping, schemas: readonly LocalSchema[]): CodecId | null {
  if (m.codec) return m.codec;
  const s = schemas.find((x) => x.id === m.schemaId);
  return s ? codecOfType(s.type) : null;
}

export function mappingSchemaText(m: SchemaMapping, schemas: readonly LocalSchema[]): string {
  if (m.registry) return m.messageType ? `${registryRefText(m.registry)} · ${m.messageType}` : registryRefText(m.registry);
  if (!m.schemaId) return m.wireFormat === "confluent" && m.codec && needsSchema(m.codec) ? "registry id in each message" : "—";
  const name = schemas.find((x) => x.id === m.schemaId)?.name ?? `${m.schemaId} (missing)`;
  return m.messageType ? `${name} · ${m.messageType}` : name;
}

// --- Codec choices ------------------------------------------------------------------------------

/** A schema as the menus offer it: its name, type and message types (Protobuf). */
export interface SchemaChoice {
  id: string;
  name: string;
  type: SchemaType;
  messageTypes: readonly string[];
}

/** One flat choice of "Decode as…" and the mapping sheet's preview. */
export interface DecodeChoice {
  key: string;
  label: string;
  choice: CodecChoice;
}

export function choiceKey(c: CodecChoice): string {
  const codec = c.codec ?? "auto";
  const schema = c.schema && "local" in c.schema ? c.schema.local : "";
  return [codec, schema, c.messageType ?? ""].join("|");
}

/** Every codec, then every schema (and Protobuf type) as a choice. */
export function decodeChoices(schemas: readonly SchemaChoice[]): DecodeChoice[] {
  const out: DecodeChoice[] = PLAIN_CODECS.map((codec) => ({ key: choiceKey({ codec }), label: CODEC_LABELS[codec], choice: { codec } }));
  for (const s of schemas) {
    const codec = codecOfType(s.type);
    const types = s.type === "protobuf" ? s.messageTypes : [];
    if (types.length === 0) {
      const choice: CodecChoice = { codec, schema: { local: s.id } };
      out.push({ key: choiceKey(choice), label: `${CODEC_LABELS[codec]} · ${s.name}`, choice });
    }
    for (const t of types) {
      const choice: CodecChoice = { codec, schema: { local: s.id }, messageType: t };
      out.push({ key: choiceKey(choice), label: `${CODEC_LABELS[codec]} · ${s.name} · ${t}`, choice });
    }
  }
  return out;
}

/** The text of a codec choice, for the menu's trigger. */
export function choiceText(c: CodecChoice, schemas: readonly SchemaChoice[]): string {
  const codec = c.codec ?? "auto";
  if (codec === "auto") return "Auto (mappings)";
  const local = c.schema && "local" in c.schema ? c.schema.local : null;
  if (!local) return CODEC_LABELS[codec];
  const name = schemas.find((s) => s.id === local)?.name ?? local;
  return [CODEC_LABELS[codec], name, c.messageType].filter(Boolean).join(" · ");
}

/** A mapping that keeps a codec choice for one message's place (the result of "Decode as…"). */
export function mappingFromChoice(id: string, target: MappingTarget, part: Part, c: CodecChoice): SchemaMapping {
  const codec = c.codec && c.codec !== "auto" ? c.codec : "utf8";
  const schemaId = c.schema && "local" in c.schema ? c.schema.local : null;
  return { id, target, part, codec, schemaId, registry: null, messageType: c.messageType ?? null, wireFormat: null };
}

/** Why a mapping's subject pattern, stream, bucket or topic cannot be saved, or null. */
export function targetProblem(t: MappingTarget): string | null {
  const text = targetText(t).trim();
  if (text === "") return t.kind === "subject" ? "A subject pattern is required." : `A ${TARGET_LABELS[t.kind]} name is required.`;
  if (/\s/.test(text)) return "No spaces.";
  if (t.kind === "subject") {
    const tokens = text.split(".");
    if (tokens.some((x) => x === "")) return "No empty tokens (..).";
    if (tokens.slice(0, -1).includes(">")) return "> comes last.";
  } else if (/[.*>]/.test(text) && t.kind !== "topic") return "A name without dots or wildcards.";
  return null;
}

/** A target with its text replaced. */
export function withTargetText(kind: MappingTarget["kind"], text: string): MappingTarget {
  switch (kind) {
    case "subject":
      return { kind, pattern: text };
    case "stream":
      return { kind, name: text };
    case "topic":
      return { kind, name: text };
    case "kvBucket":
      return { kind, bucket: text };
  }
}
