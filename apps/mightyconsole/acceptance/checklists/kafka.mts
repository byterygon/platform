// TSK-86, Kafka and Schema Registry (Mightyconsole spec section 18, against the lab). Not wired yet: TSK-86 adds the
// checks of each item (cargo tests with the lab-tests feature, UI tests, a browser walk with
// screenshots: see foundation.mts) before it closes, then runs
// `pnpm --filter @byterygon/mightyconsole acceptance kafka --lab-up --strict`.
import type { Checklist } from "../checklist.mts";

export default {
  id: "kafka",
  task: "TSK-86",
  title: "Kafka and Schema Registry",
  builtWhen: "apps/mightyconsole/server/src/tools/kafka",
  lab: ["kafka"],
  items: [
    {
      id: "spike",
      text: "The spike's result and the chosen client are recorded in 7.6 and Open question 2 is closed.",
      checks: [],
    },
    {
      id: "connect",
      text: "Connect over PLAINTEXT, SASL SCRAM-SHA-512 and SSL; wrong credentials give Auth.",
      lab: true,
      checks: [],
    },
    {
      id: "topics",
      text: "Cluster and brokers; topics list, describe (partitions, watermarks, configs), create, delete with the typed name.",
      lab: true,
      checks: [],
    },
    {
      id: "consume",
      text: "Consume from latest n, earliest, latest, an offset, offsets per partition and a time, to the end at start or following, on every compression codec, with filter and codecs; pausing stops fetching.",
      lab: true,
      checks: [],
    },
    {
      id: "registry-codecs",
      text: "Avro and Protobuf values from the registry decode; produce through the Composer encodes with the registry (wire format) and the message reads back identical; a tombstone on payments.",
      lab: true,
      checks: [],
    },
    {
      id: "groups",
      text: "Consumer groups list and describe with lag per partition; reset offsets previews and applies on the Empty group and refuses the active one.",
      lab: true,
      checks: [],
    },
    {
      id: "registry",
      text: "Registry: subjects, versions, schema with references, compatibility check (incompatible change rejected with messages), register a new version, set the level; topics for a subject; CI green.",
      lab: true,
      checks: [],
    },
  ],
} satisfies Checklist;
