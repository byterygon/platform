// TSK-84, LangGraph (Mightyconsole spec section 18, against the lab). The server's checks are
// wired: tests/langgraph.rs against a stand-in server, tests/langgraph_lab.rs (feature
// lab-tests) against the lab's `langgraph dev`. The UI's (tests, a browser walk with
// screenshots) come with the UI batch. Run
// `pnpm --filter @byterygon/mightyconsole acceptance langgraph --lab-up --strict`.
import { cargo, type Checklist } from "../checklist.mts";

const lab = (filter: string) => cargo(filter, { features: ["lab-tests"] });

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
      checks: [
        cargo("connect_sends_the_api_key_and_headers_and_maps_auth_and_reach_errors"),
        cargo("https_verifies_against_the_pinned_ca_and_the_expected_name"),
        cargo("assistants_graph_and_schemas"),
        lab("lab_connect_assistants_and_the_xray_graph"),
      ],
    },
    {
      id: "threads",
      text: "Threads: search, create, delete; state and checkpoint history.",
      lab: true,
      checks: [cargo("threads_state_history_and_fork"), lab("lab_threads_search_create_delete_state_and_history")],
    },
    {
      id: "runs",
      text: "A run streams values, updates and messages, highlights the active node, stops at the interrupt, and resumes with a value; stop and rollback work.",
      lab: true,
      checks: [
        cargo("a_run_streams_its_events_as_json_lines"),
        cargo("disconnecting_ends_a_run_stream"),
        lab("lab_a_run_streams_stops_at_the_interrupt_and_resumes"),
        lab("lab_stop_and_rollback_a_run"),
      ],
    },
    {
      id: "time-travel",
      text: "Fork from a checkpoint (update state) and run from a checkpoint (time travel) produce new checkpoints in the history.",
      lab: true,
      checks: [lab("lab_fork_and_time_travel_make_new_checkpoints")],
    },
    {
      id: "reconnect-store",
      text: "A run survives a server reconnect by joining it; the store browser lists, searches, puts and deletes items.",
      lab: true,
      checks: [
        cargo("a_run_stream_follows_the_credits_and_joins_from_the_last_event"),
        lab("lab_a_run_is_joined_after_a_reconnect"),
        cargo("the_store_lists_searches_puts_and_deletes"),
        lab("lab_the_store_lists_searches_puts_and_deletes"),
      ],
    },
    {
      id: "components",
      text: "GraphView is in packages/ui; CI green.",
      checks: [],
    },
  ],
} satisfies Checklist;
