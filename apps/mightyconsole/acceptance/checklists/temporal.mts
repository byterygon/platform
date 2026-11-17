// TSK-83, Temporal (Mightyconsole spec section 18, against the lab). Not wired yet: TSK-83 adds the
// checks of each item (cargo tests with the lab-tests feature, UI tests, a browser walk with
// screenshots: see foundation.mts) before it closes, then runs
// `pnpm --filter @byterygon/mightyconsole acceptance temporal --lab-up --strict`.
import type { Checklist } from "../checklist.mts";

export default {
  id: "temporal",
  task: "TSK-83",
  title: "Temporal",
  builtWhen: "apps/mightyconsole/server/src/tools/temporal",
  lab: ["temporal"],
  items: [
    {
      id: "workflows",
      text: "Namespaces; the workflow list with visibility queries, status chips, count and paging.",
      lab: true,
      checks: [],
    },
    {
      id: "detail",
      text: "Workflow detail: Timeline and history (paged and followed live), input and result, pending activities with the retrying one, stack trace through the worker; payloads decoded by encoding (the Protobuf one through the codecs once TSK-80 is on main).",
      lab: true,
      checks: [],
    },
    {
      id: "actions",
      text: "Signal, query, request cancellation, terminate and reset, each confirmed as specified, with the effect visible in the history.",
      lab: true,
      checks: [],
    },
    {
      id: "schedules",
      text: "Schedules: list, describe, pause, unpause, trigger, delete; task queue pollers.",
      lab: true,
      checks: [],
    },
    {
      id: "components",
      text: "Timeline is in packages/ui; CI green.",
      checks: [],
    },
  ],
} satisfies Checklist;
