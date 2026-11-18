// TSK-84, LangGraph (Mightyconsole spec section 18, against the lab's `langgraph dev`). The
// server's checks: tests/langgraph.rs against a stand-in server, tests/langgraph_lab.rs (feature
// lab-tests) against the lab. The UI's: test/langgraph.test.tsx (jsdom), and a walk through the
// tool in a browser with screenshots. Run
// `pnpm --filter @byterygon/mightyconsole acceptance langgraph --lab-up --strict`.
import { browser, type BrowserContext, cargo, type Checklist, command, manual, vitest } from "../checklist.mts";

const lab = (filter: string) => cargo(filter, { features: ["lab-tests"] });

/** The run toolbar's button (the Run sub-tab is a button too). */
const runBar = (label: string) => `[...document.querySelectorAll('[aria-label="Run actions"] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;

/** Opens the LangGraph tool and the lab profile's resource tree, adding the profile first when
 * this browser has none (its defaults point at the lab). A reloaded page reconnects the profile
 * by itself (its restored tab is active) but may leave it collapsed: a double click connects or
 * expands it. */
async function labTree({ until, run, shot }: Pick<BrowserContext, "until" | "run" | "shot">): Promise<void> {
  await until(`__mc.button("LangGraph")`, "the tool rail");
  await run(`__mc.click(__mc.button("LangGraph"))`);
  await until(`__mc.has("No LangGraph connections yet") || __mc.item("lab")`, "the LangGraph connection list");
  if (!(await run<boolean>(`Boolean(__mc.item("lab"))`))) {
    await run(`__mc.click(__mc.button("Add connection"))`);
    await until(`__mc.field("Name")`, "the profile sheet");
    await shot("profile sheet");
    await run(`__mc.type(__mc.field("Name"), "lab")`);
    // A pointer reaches Save and Cancel (clicks from script skip hit-testing; an empty toast
    // region once covered the sheet's footer).
    for (const label of ["Save", "Cancel"]) {
      await until(`(() => { const b = __mc.button(${JSON.stringify(label)}); const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`, `the pointer reaching ${label}`, 2_000);
    }
    await run(`__mc.click(__mc.button("Save"))`);
    await until(`__mc.item("lab")`, "the saved profile");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await until(`__mc.item("Threads")`, "the resource tree", 4_000);
      return;
    } catch {
      await run(`__mc.dblclick(__mc.item("lab"))`);
    }
  }
  await until(`__mc.item("Threads")`, "the resource tree");
}

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
        vitest("test/langgraph.test.tsx", "an assistant's graph with xray"),
        vitest("test/langgraph.test.tsx", "validates the URL and the header lines"),
        browser("connect to the lab, the assistants, the xray graph", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Assistants"))`);
          await until(`__mc.has("agent-strict")`, "the assistants of graph agent");
          await shot("assistants");
          await run(`__mc.click(__mc.button("agent"))`);
          await until(`document.querySelector('[data-graph-node="summarize:remember"]')`, "the graph with the subgraph's nodes (xray)");
          await shot("assistant graph, xray");
        }),
      ],
    },
    {
      id: "threads",
      text: "Threads: search, create, delete; state and checkpoint history.",
      lab: true,
      checks: [cargo("threads_state_history_and_fork"), lab("lab_threads_search_create_delete_state_and_history"), vitest("test/langgraph.test.tsx", "threads: search by status")],
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
        vitest("test/langgraph.test.tsx", "run events"),
        vitest("test/langgraph.test.tsx", "a run streams to the interrupt"),
        browser("a run to the interrupt, the graph lit, resumed", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Threads"))`);
          await until(`__mc.button("New thread")`, "the Threads tab");
          await run(`__mc.click(__mc.button("New thread"))`);
          await until(`${runBar("Run")} && !${runBar("Run")}.hasAttribute("data-disabled") && !${runBar("Run")}.disabled`, "the new thread's Run form with an assistant");
          await run(`__mc.click(${runBar("Run")})`);
          await shot("run started");
          await until(`__mc.has("The run is waiting at an interrupt")`, "the run stopped at approve's interrupt");
          await until(`document.querySelector('[data-graph-node="plan"][data-visited]')`, "the nodes that ran, lit in the graph");
          await shot("run at the interrupt");
          await run(`__mc.click(__mc.button("Resume"))`);
          await until(`__mc.has("Final: Here is what I found")`, "the resumed run's final message");
          await shot("resumed to the end");
          await run(`__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "History"))`);
          await until(`__mc.button("Fork from here")`, "the checkpoint history");
          await shot("history");
        }),
      ],
    },
    {
      id: "time-travel",
      text: "Fork from a checkpoint (update state) and run from a checkpoint (time travel) produce new checkpoints in the history.",
      lab: true,
      checks: [lab("lab_fork_and_time_travel_make_new_checkpoints"), vitest("test/langgraph.test.tsx", "history: fork from a checkpoint and run from it")],
    },
    {
      id: "reconnect-store",
      text: "A run survives a server reconnect by joining it; the store browser lists, searches, puts and deletes items.",
      lab: true,
      checks: [
        cargo("a_run_stream_follows_the_credits_and_joins_from_the_last_event"),
        lab("lab_a_run_is_joined_after_a_reconnect"),
        vitest("test/langgraph.test.tsx", "a run lost with the connection is joined again"),
        cargo("the_store_lists_searches_puts_and_deletes"),
        lab("lab_the_store_lists_searches_puts_and_deletes"),
        vitest("test/langgraph.test.tsx", "the store lists namespaces and items"),
        browser("the store browser", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Store"))`);
          await until(`__mc.button("lab.answers")`, "the namespaces (the lab's runs write lab.answers)");
          await run(`__mc.click(__mc.button("lab.answers"))`);
          await until(`[...document.querySelectorAll("button")].some((b) => b.textContent.startsWith("answer-"))`, "the items of lab.answers");
          await shot("store");
        }),
      ],
    },
    {
      id: "components",
      text: "GraphView is in packages/ui; CI green.",
      checks: [
        command("GraphView's tests in packages/ui (behaviour; the conventions suite runs in CI)", ["pnpm", "--filter", "@byterygon/ui", "exec", "vitest", "run", "src/components/graph-view"]),
        manual("the CI run of the task's last PR is green (link it)"),
      ],
    },
  ],
} satisfies Checklist;
