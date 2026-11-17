// TSK-80, Messaging core (Mightyconsole spec section 18, against the lab). Not wired yet: TSK-80 adds the
// checks of each item (cargo tests with the lab-tests feature, UI tests, a browser walk with
// screenshots: see foundation.mts) before it closes, then runs
// `pnpm --filter @byterygon/mightyconsole acceptance messaging --lab-up --strict`.
import type { Checklist } from "../checklist.mts";

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
      checks: [],
    },
    {
      id: "codecs",
      text: "Every codec of 5.2 decodes and encodes with round-trip tests, including the edge cases (integers beyond 2^53, Avro unions, decimals and logical types, Protobuf canonical JSON, MessagePack binary and ext); auto-detect follows the order of 5.2 on a fixture set of ambiguous payloads.",
      checks: [],
    },
    {
      id: "wire-format",
      text: "Confluent wire format for Avro, Protobuf (message indexes, imports through references) and JSON Schema works against the lab registry; the three naming strategies give the expected subjects.",
      lab: true,
      checks: [],
    },
    {
      id: "local-schemas",
      text: "Local schemas (Avro, several .proto files with imports, a descriptor set, JSON Schema) compile on the server; errors name the file and line.",
      checks: [],
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
