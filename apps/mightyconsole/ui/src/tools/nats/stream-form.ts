// The stream form's model (§6.3 "Stream form", mockup frame nats-stream-form): a draft of text
// fields as typed, the configuration it makes, and the fields the server cannot change once the
// stream exists. Sizes take binary units ("1 GiB", "512 MiB", "1048576"); durations the servers'
// text ("24h", "2m", "90s"); empty is "no limit" (or the server's default).
import { formatDurationText, parseDuration } from "@/app/duration";
import type { NatsCompression, NatsDiscard, NatsRetention, NatsStorage, NatsStreamConfig } from "@/gen/api";
import { validatePattern } from "./profile";

export interface StreamDraft {
  name: string;
  description: string;
  subjects: string[];
  storage: NatsStorage;
  retention: NatsRetention;
  discard: NatsDiscard;
  discardNewPerSubject: boolean;
  maxMessages: string;
  maxBytes: string;
  maxAge: string;
  maxMessageSize: string;
  maxMessagesPerSubject: string;
  maxConsumers: string;
  replicas: string;
  duplicateWindow: string;
  allowDirect: boolean;
  allowRollup: boolean;
  denyDelete: boolean;
  denyPurge: boolean;
  compression: NatsCompression;
}

export type StreamField = keyof StreamDraft;

/** Fixed once the stream exists (nats-server refuses to change them). */
export const FIXED_AFTER_CREATE: readonly StreamField[] = ["name", "storage", "retention"];

export const EMPTY_STREAM: StreamDraft = {
  name: "",
  description: "",
  subjects: [],
  storage: "file",
  retention: "limits",
  discard: "old",
  discardNewPerSubject: false,
  maxMessages: "",
  maxBytes: "",
  maxAge: "",
  maxMessageSize: "",
  maxMessagesPerSubject: "",
  maxConsumers: "",
  replicas: "1",
  duplicateWindow: "",
  allowDirect: true,
  allowRollup: false,
  denyDelete: false,
  denyPurge: false,
  compression: "none",
};

const UNITS: Record<string, number> = { b: 1, k: 1024, kb: 1024, kib: 1024, m: 1024 ** 2, mb: 1024 ** 2, mib: 1024 ** 2, g: 1024 ** 3, gb: 1024 ** 3, gib: 1024 ** 3, t: 1024 ** 4, tb: 1024 ** 4, tib: 1024 ** 4 };

/** Bytes from "1 GiB", "512MiB", "1.5 g" or "1048576"; null when empty, NaN when not a size. */
export function parseSize(text: string): number | null {
  const t = text.trim().replace(/[,_]/g, "");
  if (t === "") return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-zA-Z]*)$/.exec(t);
  if (!m) return Number.NaN;
  const unit = UNITS[(m[2] || "b").toLowerCase()];
  if (unit === undefined) return Number.NaN;
  return Math.round(Number(m[1]) * unit);
}

/** A whole number from "5,000,000" or "5 000 000"; null when empty, NaN when not one. */
export function parseCount(text: string): number | null {
  const t = text.trim().replace(/[,_\s]/g, "");
  if (t === "") return null;
  return /^\d+$/.test(t) ? Number(t) : Number.NaN;
}

const count = (n: number | undefined) => (n === undefined ? "" : String(n));
/** A size the form can read back exactly: the largest binary unit that divides it, else bytes. */
export function exactSize(n: number): string {
  for (const [unit, f] of [["TiB", 1024 ** 4], ["GiB", 1024 ** 3], ["MiB", 1024 ** 2], ["KiB", 1024]] as const) {
    if (n >= f && n % f === 0) return `${n / f} ${unit}`;
  }
  return String(n);
}
const size = (n: number | undefined) => (n === undefined ? "" : exactSize(n));
const duration = (ms: number | undefined) => (ms === undefined ? "" : formatDurationText(ms));

/** The form's text for a stream's configuration. */
export function draftOf(c: NatsStreamConfig): StreamDraft {
  return {
    name: c.name,
    description: c.description ?? "",
    subjects: [...c.subjects],
    storage: c.storage,
    retention: c.retention,
    discard: c.discard,
    discardNewPerSubject: c.discardNewPerSubject,
    maxMessages: count(c.maxMessages),
    maxBytes: size(c.maxBytes),
    maxAge: duration(c.maxAgeMs),
    maxMessageSize: size(c.maxMessageSize),
    maxMessagesPerSubject: count(c.maxMessagesPerSubject),
    maxConsumers: count(c.maxConsumers),
    replicas: String(c.replicas),
    duplicateWindow: duration(c.duplicateWindowMs),
    allowDirect: c.allowDirect,
    allowRollup: c.allowRollup,
    denyDelete: c.denyDelete,
    denyPurge: c.denyPurge,
    compression: c.compression,
  };
}

const NAME = /^[^\s.*>/\\]+$/;

/** What the form says is wrong, by field; empty when it can be sent. */
export function streamErrors(d: StreamDraft): Partial<Record<StreamField, string>> {
  const out: Partial<Record<StreamField, string>> = {};
  if (d.name.trim() === "") out.name = "A stream name is required.";
  else if (!NAME.test(d.name.trim())) out.name = "No spaces and none of . * > / \\";
  if (d.subjects.length === 0) out.subjects = "Name at least one subject.";
  else {
    const bad = d.subjects.map((s) => [s, validatePattern(s)] as const).find(([, p]) => p);
    if (bad) out.subjects = `${bad[0]}: ${bad[1]}`;
  }
  for (const f of ["maxMessages", "maxMessagesPerSubject", "maxConsumers"] as const) {
    const n = parseCount(d[f]);
    if (n !== null && (Number.isNaN(n) || n <= 0)) out[f] = "A whole number above 0, or empty for no limit.";
  }
  for (const f of ["maxBytes", "maxMessageSize"] as const) {
    const n = parseSize(d[f]);
    if (n !== null && (Number.isNaN(n) || n <= 0)) out[f] = "A size such as 512 MiB or 1 GiB, or empty for no limit.";
  }
  for (const f of ["maxAge", "duplicateWindow"] as const) {
    const ms = parseDuration(d[f]);
    if (ms === "invalid" || ms === 0) out[f] = "A duration such as 90s, 30m or 24h, or empty.";
  }
  const replicas = parseCount(d.replicas);
  if (replicas === null || Number.isNaN(replicas) || replicas < 1 || replicas > 5) out.replicas = "1 to 5.";
  return out;
}

/** The configuration the draft makes, keeping the read-only parts of `base` (an edit). */
export function configOf(d: StreamDraft, base?: NatsStreamConfig): NatsStreamConfig {
  const n = (v: number | null) => (v === null || Number.isNaN(v) ? undefined : v);
  const ms = (t: string) => {
    const v = parseDuration(t);
    return v === null || v === "invalid" ? undefined : v;
  };
  const out: NatsStreamConfig = {
    name: d.name.trim(),
    subjects: d.subjects,
    storage: d.storage,
    retention: d.retention,
    discard: d.discard,
    discardNewPerSubject: d.discard === "new" && d.discardNewPerSubject,
    replicas: n(parseCount(d.replicas)) ?? 1,
    allowDirect: d.allowDirect,
    allowRollup: d.allowRollup,
    denyDelete: d.denyDelete,
    denyPurge: d.denyPurge,
    compression: d.compression,
    sealed: base?.sealed ?? false,
    sources: base?.sources ?? [],
  };
  const set = <K extends keyof NatsStreamConfig>(k: K, v: NatsStreamConfig[K] | undefined) => {
    if (v !== undefined) out[k] = v;
  };
  set("description", d.description.trim() || undefined);
  set("maxMessages", n(parseCount(d.maxMessages)));
  set("maxBytes", n(parseSize(d.maxBytes)));
  set("maxAgeMs", ms(d.maxAge));
  set("maxMessageSize", n(parseSize(d.maxMessageSize)));
  set("maxMessagesPerSubject", n(parseCount(d.maxMessagesPerSubject)));
  set("maxConsumers", n(parseCount(d.maxConsumers)));
  set("duplicateWindowMs", ms(d.duplicateWindow));
  set("mirror", base?.mirror);
  return out;
}

/** The server's field names (`maxAgeMs`) as the form's (`maxAge`). */
export function draftField(server: string | undefined): StreamField | null {
  if (!server) return null;
  const map: Record<string, StreamField> = { maxAgeMs: "maxAge", duplicateWindowMs: "duplicateWindow" };
  const f = map[server] ?? server;
  return f in EMPTY_STREAM ? (f as StreamField) : null;
}

/** Why a stream cannot be edited or purged here, or null (spec §6.3: sealed and mirror streams). */
export function readOnlyReason(c: NatsStreamConfig): { edit: string | null; purge: string | null } {
  if (c.sealed) return { edit: "The stream is sealed: nothing about it can change.", purge: "The stream is sealed: its messages cannot be removed." };
  if (c.mirror) return { edit: `A mirror of ${c.mirror.name}: its settings follow the origin (editing mirrors comes later).`, purge: `A mirror of ${c.mirror.name}: purge the origin instead.` };
  return { edit: null, purge: c.denyPurge ? "The stream denies purge." : null };
}
