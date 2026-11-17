// TSK-85, NATS (Mightyconsole spec section 18, against the lab). Not wired yet: TSK-85 adds the
// checks of each item (cargo tests with the lab-tests feature, UI tests, a browser walk with
// screenshots: see foundation.mts) before it closes, then runs
// `pnpm --filter @byterygon/mightyconsole acceptance nats --lab-up --strict`.
import type { Checklist } from "../checklist.mts";

export default {
  id: "nats",
  task: "TSK-85",
  title: "NATS",
  builtWhen: "apps/mightyconsole/server/src/tools/nats",
  lab: ["nats"],
  items: [
    {
      id: "connect",
      text: "Connect with none, user and password, token, nkey and creds; wrong credentials give Auth; TLS against the lab CA.",
      lab: true,
      checks: [],
    },
    {
      id: "core",
      text: "Server info and JetStream account info; subscribe with wildcards and a queue group as a live tail with headers; publish with headers and a reply subject; request with a reply and with no responders.",
      lab: true,
      checks: [],
    },
    {
      id: "streams",
      text: "Streams: list, info, create, edit, purge (all, by subject, keep), delete with the typed name; browse from first, last, a sequence and a time, with follow; the full payload of a large message.",
      lab: true,
      checks: [],
    },
    {
      id: "consumers",
      text: "Consumers: list, info with pending and ack state, create, delete.",
      lab: true,
      checks: [],
    },
    {
      id: "kv-objects",
      text: "KV: buckets, keys, get, history, put with an expected revision (and its conflict), delete, purge, watch; Object Store: buckets, list, upload of the 5 MiB file in parts with progress, download, info, delete.",
      lab: true,
      checks: [],
    },
    {
      id: "services",
      text: "Services: the lab's echo is discovered with INFO, STATS and PING.",
      lab: true,
      checks: [],
    },
    {
      id: "schemas",
      text: "A local Protobuf schema mapped to orders.proto.> decodes those payloads; every destructive action is confirmed as in the pattern; CI green.",
      lab: true,
      checks: [],
    },
  ],
} satisfies Checklist;
