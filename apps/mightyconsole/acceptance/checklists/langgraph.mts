// TSK-84, LangGraph (Mightyconsole spec section 18, against the lab's `langgraph dev`). The
// server's checks: tests/langgraph.rs against a stand-in server, tests/langgraph_lab.rs (feature
// lab-tests) against the lab. The UI's: test/langgraph.test.tsx (jsdom), and a walk through the
// tool in a browser with screenshots. Run
// `pnpm --filter @byterygon/mightyconsole acceptance langgraph --lab-up --strict`.
import { browser, type BrowserContext, cargo, type Checklist, command, manual, vitest } from "../checklist.mts";
import { APPEARANCES, appearance, openSuggestions, suggestionRows, suggestionsOnTop, typeInEditor } from "../editors.mts";

const lab = (filter: string) => cargo(filter, { features: ["lab-tests"] });

/** The run toolbar's button (the Run sub-tab is a button too). */
/** A button of the Run bar on screen (other thread tabs stay mounted, hidden; their own view panels are not marked hidden). */
const runBar = (label: string) => `[...document.querySelectorAll('[aria-label="Run actions"] button')].find((b) => b.checkVisibility() && b.textContent.trim() === ${JSON.stringify(label)})`;

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
      // The sheet's own button: a hidden tab of another tool may have a button of the same name.
      await until(`(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) return false; const r = b.getBoundingClientRect(); return b.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); })()`, `the pointer reaching ${label}`, 2_000);
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
      text: "Threads: search, create, delete; state and checkpoint history. TSK-105 (DOC-21 §3.7): a thread opened from the list takes a step in the same tab; the navigation row shows the profile, Threads, the thread and its view; the thread segment lists the recent threads.",
      lab: true,
      checks: [
        cargo("threads_state_history_and_fork"),
        lab("lab_threads_search_create_delete_state_and_history"),
        vitest("test/langgraph.test.tsx", "threads: search by status"),
        vitest("test/nav-row.test.tsx"),
        browser("a thread in the same tab, its crumbs, Back, the recent threads", async ({ page, origin, until, run, shot }) => {
          const row = `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) [role=toolbar][aria-label=Location]")].find((r) => r.offsetParent !== null)`;
          const crumbs = `[...${row}.querySelectorAll("[data-slot=breadcrumb-item]")].map((el) => el.textContent.trim()).join(" / ")`;
          const press = (el: string) =>
            `(() => { const t = ${el}; if (!t) throw new Error("nothing to press"); for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) t.dispatchEvent(new (k.startsWith("pointer") ? PointerEvent : MouseEvent)(k, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); return true; })()`;
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Threads"))`);
          await until(`location.pathname === "/langgraph/lab/threads" && ${row} && [...document.querySelectorAll("[role=tabpanel]:not([hidden]) button.font-mono")].length > 0`, "the threads");
          await shot("the threads");
          await run(press(`[...document.querySelectorAll("[role=tabpanel]:not([hidden]) button.font-mono")][0]`));
          await until(`/^\\/langgraph\\/lab\\/threads\\/[^/]+\\/run$/.test(location.pathname) && ${crumbs}.startsWith("lab / Threads / ")`, "the thread in the same tab");
          await shot("the navigation row on a thread");
          await run(press(`[...${row}.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Back")`));
          await until(`location.pathname === "/langgraph/lab/threads"`, "Back to the threads");
          await run(press(`[...${row}.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "Forward")`));
          await until(`/\\/threads\\/[^/]+\\/run$/.test(location.pathname)`, "Forward to the thread");
          await run(press(`${row}.querySelectorAll("[data-slot=breadcrumb-item]")[2].querySelector("button")`));
          await until(`__mc.has("Recent threads")`, "the thread segment's siblings");
          await shot("the recent threads");
        }),
      ],
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
          await run(`__mc.click([...document.querySelectorAll("button")].find((b) => b.checkVisibility() && b.textContent.trim() === "Resume"))`);
          await until(`__mc.has("Final: Here is what I found")`, "the resumed run's final message");
          await shot("resumed to the end");
          await run(`__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.checkVisibility() && t.textContent.trim() === "History"))`);
          await until(`__mc.button("Fork from here")`, "the checkpoint history");
          await shot("history");
        }),
        // TSK-94: the Run form as the mockup's langgraph-thread frame. The lab's graph has a
        // context schema, so the Context field shows; the schema's problems are listed under a
        // field, and JSON completion names each property's type.
        browser("the Run form: Input and Context checked against the assistant's schemas (TSK-94)", async (ctx) => {
          const { page, origin, until, run, shot } = ctx;
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Threads"))`);
          await until(`__mc.button("New thread")`, "the Threads tab");
          // The metadata filter's suggestions (the keys seen) paint over the threads table's header.
          await until(`document.querySelector('[aria-label="Threads"] thead')`, "the threads table");
          await typeInEditor(ctx, "Metadata (JSON)", '{ "');
          await openSuggestions(ctx);
          if (!(await suggestionsOnTop(ctx))) throw new Error("a metadata suggestion row is covered by the threads table");
          await shot("metadata suggestions over the threads table");
          await typeInEditor(ctx, "Metadata (JSON)", "");
          await run(`__mc.click(__mc.button("New thread"))`);
          await until(`${runBar("Run")} && !${runBar("Run")}.disabled`, "the new thread's Run form with an assistant");
          await until(`[...document.querySelectorAll("[role=tabpanel]:not([hidden]) label")].some((l) => l.textContent.trim() === "Context")`, "the Context field (the graph's context schema)");
          await typeInEditor(ctx, "Context", "{}");
          await until(`[...document.querySelectorAll("[role=tabpanel]:not([hidden]) [data-schema-problems]")].some((p) => /1 problem: missing property "user_id" \\(required by [^)]+'s context schema\\)/.test(p.textContent))`, "the context schema's problem listed under the field");
          await typeInEditor(ctx, "Input", '{\n  "messages": [{ "role": "human", "content": "Charged twice" }],\n  ""\n}');
          // The cursor between the quotes of line 3, where a property name goes.
          for (const press of ["ArrowUp", "End", "ArrowLeft"]) {
            const code = { ArrowUp: 38, End: 35, ArrowLeft: 37 }[press]!;
            for (const type of ["rawKeyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: press, code: press, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
          }
          for (const [theme, density] of APPEARANCES) {
            await appearance(ctx, theme, density);
            await openSuggestions(ctx);
            const rows = await suggestionRows(ctx);
            if (!rows.some((r) => r.includes("approved") && r.includes("boolean"))) throw new Error(`JSON completion does not name the type: ${JSON.stringify(rows)}`);
            if (!(await suggestionsOnTop(ctx))) throw new Error(`${theme}/${density}: a suggestion row is covered`);
            await shot(`input suggestions, ${theme}, ${density}`);
          }
          await appearance(ctx, "light", "comfortable");
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
