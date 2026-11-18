// The column set and the words of each system's message view (Mightyconsole spec §5.1, §5.9):
// the UI never says "topic" for NATS or "subject" for Kafka. The shared components take both.

/** Which system's view: the grid shows its columns, the panes use its words. */
export type MessageSystem = "kafka" | "nats" | "jetstream" | "kv";

/** The grid's columns per system (names of the §5.1 schema). */
export const COLUMNS: Record<MessageSystem, readonly string[]> = {
  kafka: ["partition", "offset", "timestamp", "keyText", "payloadText"],
  nats: ["subject", "timestamp", "payloadText"],
  jetstream: ["sequence", "subject", "timestamp", "payloadText"],
  kv: ["subject", "sequence", "operation", "payloadText"],
};

/** The words a view uses. */
export interface MessageLabels {
  /** What one item is called: "record", "message", "entry". */
  item: string;
  items: string;
  /** The key: "Key" (Kafka, KV). */
  key: string;
  /** The position: "Offset", "Sequence", "Revision". */
  position: string;
  /** Where it lives: "Topic", "Subject", "Stream", "Bucket". */
  source: string;
}

export const LABELS: Record<MessageSystem, MessageLabels> = {
  kafka: { item: "record", items: "records", key: "Key", position: "Offset", source: "Topic" },
  nats: { item: "message", items: "messages", key: "Subject", position: "Sequence", source: "Subject" },
  jetstream: { item: "message", items: "messages", key: "Subject", position: "Sequence", source: "Stream" },
  kv: { item: "entry", items: "entries", key: "Key", position: "Revision", source: "Bucket" },
};
