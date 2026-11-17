// TSK-84, LangGraph (Mightyconsole spec section 18, against the lab). Not wired yet: TSK-84 adds the
// checks of each item (cargo tests with the lab-tests feature, UI tests, a browser walk with
// screenshots: see foundation.mts) before it closes, then runs
// `pnpm --filter @byterygon/mightyconsole acceptance langgraph --lab-up --strict`.
import type { Checklist } from "../checklist.mts";

export default {
  id: "langgraph",
  task: "TSK-84",
  title: "LangGraph",
  builtWhen: "apps/mightyconsole/server/src/tools/langgraph",
  lab: ["langgraph"],
  items: [
    {
      id: "connect",
      text: "Connect with and without an API key; assistants by graph; the graph in the GraphView with xray for the subgraph.",
      lab: true,
      checks: [],
    },
    {
      id: "threads",
      text: "Threads: search, create, delete; state and checkpoint history.",
      lab: true,
      checks: [],
    },
    {
      id: "runs",
      text: "A run streams values, updates and messages, highlights the active node, stops at the interrupt, and resumes with a value; stop and rollback work.",
      lab: true,
      checks: [],
    },
    {
      id: "time-travel",
      text: "Fork from a checkpoint (update state) and run from a checkpoint (time travel) produce new checkpoints in the history.",
      lab: true,
      checks: [],
    },
    {
      id: "reconnect-store",
      text: "A run survives a server reconnect by joining it; the store browser lists, searches, puts and deletes items.",
      lab: true,
      checks: [],
    },
    {
      id: "components",
      text: "GraphView is in packages/ui; CI green.",
      checks: [],
    },
  ],
} satisfies Checklist;
