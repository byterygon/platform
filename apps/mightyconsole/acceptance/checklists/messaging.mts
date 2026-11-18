// TSK-80, Messaging core (Mightyconsole spec section 18, against the lab). Batch 1 (crates/message-codecs)
// wires the crate, codecs, wire-format and local-schemas items; batches 2 and 3 wire the rest (the
// server's messaging procedures, the UI tests and a browser walk) before the task closes with
// `pnpm --filter @byterygon/mightyconsole acceptance messaging --lab-up --strict`.
import { type Checklist, command } from "../checklist.mts";

// The crate's own tests (the harness's `cargo` checks run mightyconsole-server's).
const codecs = (label: string, ...args: string[]) =>
  command(label, ["cargo", "test", "-p", "message-codecs", "--locked", ...args]);

export default {
  id: "messaging",
  task: "TSK-80",
  title: "Messaging core",
  builtWhen: "crates/message-codecs",
  lab: ["kafka"],
  items: [
    {
      id: "crate",
      text: "crates/message-codecs is MIT OR Apache-2.0 and depends on nothing in apps/.",
      checks: [
        command("check-licenses", ["node", "scripts/check-licenses.mjs"]),
        command("cargo deny check licenses bans sources", ["cargo", "deny", "check", "licenses", "bans", "sources"], { requires: ["cargo-deny"] }),
      ],
    },
    {
      id: "codecs",
      text: "Every codec of 5.2 decodes and encodes with round-trip tests, including the edge cases (integers beyond 2^53, Avro unions, decimals and logical types, Protobuf canonical JSON, MessagePack binary and ext); auto-detect follows the order of 5.2 on a fixture set of ambiguous payloads.",
      checks: [
        codecs("every codec's unit tests (edge cases)", "--lib", "codec::"),
        codecs("auto-detect on ambiguous payloads", "--test", "codecs", "auto_detect_order_on_ambiguous_payloads"),
        codecs("every codec through the engine", "--test", "codecs", "every_codec_round_trips_through_the_engine"),
      ],
    },
    {
      id: "wire-format",
      text: "Confluent wire format for Avro, Protobuf (message indexes, imports through references) and JSON Schema works against the lab registry; the three naming strategies give the expected subjects.",
      lab: true,
      checks: [
        codecs("wire format through a fake registry", "--test", "codecs", "wire_format_through_a_registry"),
        command("against the lab registry", ["cargo", "test", "-p", "message-codecs", "--locked", "--test", "registry_lab"], {
          env: { MESSAGE_CODECS_REGISTRY_URL: "http://127.0.0.1:8081", BYTERYGON_REQUIRE_LAB: "1" },
        }),
        codecs("naming strategies", "--lib", "naming::"),
      ],
    },
    {
      id: "local-schemas",
      text: "Local schemas (Avro, several .proto files with imports, a descriptor set, JSON Schema) compile on the server; errors name the file and line.",
      checks: [
        codecs("local schemas and mappings", "--test", "codecs", "local_schemas_and_mappings"),
        codecs("a descriptor set", "--test", "codecs", "descriptor_set_local_schema"),
        codecs("errors with file and line", "--lib", "errors_name"),
      ],
    },
    {
      id: "filter",
      text: "The filter's parts each work; jq runs through jaq and its licence passes check-licenses and cargo deny; errors carry positions; maxScan ends a scan with the counts.",
      checks: [],
    },
    {
      id: "arrow",
      text: "Messages travel as Arrow batches with the 5.1 schema, decode in the Worker and show in the data grid; a payload over 1 MiB is truncated with its full size.",
      checks: [],
    },
    {
      id: "live-tail",
      text: "Live tail on the test backend: pause stops a pull-able source from reading (credits counted), a push-only source drops oldest and reports it, rate and counters update, the view keeps its limit, Stop, Clear and Restart from lastPositions work.",
      checks: [],
    },
    {
      id: "components",
      text: "MessageViewer, Composer and FilterBar work on the test backend; CodeEditor, HexView and KeyValueEditor are in packages/ui with manifests, examples, tests and registry items, synced into the app.",
      checks: [],
    },
    {
      id: "procedures",
      text: "The messaging.* procedures of 5.8 exist; CI green.",
      checks: [],
    },
  ],
} satisfies Checklist;
