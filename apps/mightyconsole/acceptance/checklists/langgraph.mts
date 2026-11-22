// TSK-84, LangGraph (Mightyconsole spec section 18, against the lab's `langgraph dev`). The
// server's checks: tests/langgraph.rs against a stand-in server, tests/langgraph_lab.rs (feature
// lab-tests) against the lab. The UI's: test/langgraph.test.tsx (jsdom), and a walk through the
// tool in a browser with screenshots. Run
// `pnpm --filter @byterygon/mightyconsole acceptance langgraph --lab-up --strict`.
import { browser, type BrowserContext, cargo, type Checklist, command, manual, vitest } from "../checklist.mts";
import { APPEARANCES, appearance, openSuggestions, suggestionRows, suggestionsOnTop, typeInEditor } from "../editors.mts";

const lab = (filter: string) => cargo(filter, { features: ["lab-tests"] });

/**
 * A button of the thread's header on screen: Stop, More actions, Run (TSK-95; the Run sub-tab is a
 * button too, and other thread tabs stay mounted, hidden).
 */
const runBar = (label: string) => `[...document.querySelectorAll("header button")].find((b) => b.checkVisibility() && (b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)}))`;
/** A visible button by its text. */
const visibleButton = (label: string) => `[...document.querySelectorAll("button")].find((b) => b.checkVisibility() && b.textContent.trim() === ${JSON.stringify(label)})`;
/** The Run form's Advanced row (TSK-95), folded at first. */
const advancedRow = `[...document.querySelectorAll("button[aria-expanded]")].find((b) => b.checkVisibility() && b.textContent.trim().startsWith("Advanced ·"))`;
/** An item of the open menu, by the start of its text. */
const menuItem = (label: string) => `[...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.trim().startsWith(${JSON.stringify(label)}))`;
/** Fires a pointer's events on an element, as a person's click does (Base UI opens on pointerdown). */
const press = (selector: string) =>
  `(() => {
    const el = ${selector};
    if (!el) throw new Error("nothing to press");
    el.focus();
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, isPrimary: true }) : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }));
    return true;
  })()`;

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
      text: "A run streams values, updates and messages, highlights the active node, stops at the interrupt, and resumes with a value; stop and rollback work. TSK-96: the events view (a run picker, chips per stream mode, times since the start, tokens folded per message with the model and tokens, the interrupt marked; a finished run lists its checkpoints) and Resume as a sheet (the interrupt's value first, its options suggested, the run options in a line).",
      lab: true,
      checks: [
        cargo("a_run_streams_its_events_as_json_lines"),
        cargo("disconnecting_ends_a_run_stream"),
        lab("lab_a_run_streams_stops_at_the_interrupt_and_resumes"),
        lab("lab_stop_and_rollback_a_run"),
        vitest("test/langgraph.test.tsx", "run events"),
        vitest("test/langgraph.test.tsx", "a run streams to the interrupt"),
        vitest("test/langgraph.test.tsx", "rows: tokens fold per message"),
        vitest("test/langgraph.test.tsx", "an interrupt's options are suggested"),
        vitest("test/langgraph.test.tsx", "Events: the run picker, chips that filter"),
        vitest("test/langgraph.test.tsx", "Resume is a sheet"),
        browser("a run to the interrupt, the graph lit, resumed", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Threads"))`);
          await until(visibleButton("New thread"), "the Threads tab");
          // The Threads tab's own: an assistant tab left open (hidden) has a New thread too (TSK-96).
          await run(`__mc.click(${visibleButton("New thread")})`);
          await until(`${runBar("Run")} && !${runBar("Run")}.hasAttribute("data-disabled") && !${runBar("Run")}.disabled`, "the new thread's Run form with an assistant");
          await run(`__mc.click(${runBar("Run")})`);
          await shot("run started");
          await until(`__mc.has("Waiting at ") && __mc.has("The graph asks:")`, "the run stopped at approve's interrupt");
          await until(`document.querySelector('[data-graph-node="plan"][data-visited]')`, "the nodes that ran, lit in the graph");
          await shot("run at the interrupt");
          // Resume… opens the form in a sheet (TSK-95, TSK-96); its Resume sends the value.
          await run(`__mc.click(${visibleButton("Resume…")})`);
          await until(`document.querySelector("[role=dialog]") && [...document.querySelectorAll("[role=dialog] button")].some((b) => b.textContent.trim() === "Resume")`, "the Resume dialog");
          await shot("the Resume dialog");
          await run(`__mc.click([...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Resume"))`);
          await until(`__mc.has("Final: Here is what I found")`, "the resumed run's final message");
          await shot("resumed to the end");
          await run(`__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.checkVisibility() && t.textContent.trim().startsWith("History")))`);
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
          await until(visibleButton("New thread"), "the Threads tab");
          // The metadata filter's suggestions (the keys seen) paint over the threads table's header.
          await until(`document.querySelector('[aria-label="Threads"] thead')`, "the threads table");
          await typeInEditor(ctx, "Metadata (JSON)", '{ "');
          await openSuggestions(ctx);
          if (!(await suggestionsOnTop(ctx))) throw new Error("a metadata suggestion row is covered by the threads table");
          await shot("metadata suggestions over the threads table");
          await typeInEditor(ctx, "Metadata (JSON)", "");
          // The Threads tab's own: an assistant tab left open (hidden) has a New thread too (TSK-96).
          await run(`__mc.click(${visibleButton("New thread")})`);
          await until(`${runBar("Run")} && !${runBar("Run")}.disabled`, "the new thread's Run form with an assistant");
          // Context sits in the Advanced fold (TSK-95).
          await until(advancedRow, "the Advanced row");
          await run(`__mc.click(${advancedRow})`);
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
        // TSK-95: the thread as the mockup's langgraph-thread frame (the header's Stop, "…" and
        // Run; the interrupt callout first; the Advanced row folded), and the threads list's
        // Advanced (sort and rows per page) as langgraph-threads.
        vitest("test/langgraph.test.tsx", "thread and threads on the mockup"),
        browser("the thread's header, the interrupt callout, the Advanced fold, the threads' Advanced (TSK-95)", async (ctx) => {
          const { page, origin, until, run, shot } = ctx;
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Threads"))`);
          await until(visibleButton("New thread"), "the Threads tab");
          // The Threads tab's own: an assistant tab left open (hidden) has a New thread too (TSK-96).
          await run(`__mc.click(${visibleButton("New thread")})`);
          await until(`${runBar("Run")} && !${runBar("Run")}.disabled`, "the new thread's Run form with an assistant");
          const summary = await run<string>(`${advancedRow}.textContent.trim()`);
          if (summary !== "Advanced · values, updates, messages · subgraphs on · no interrupts") throw new Error(`the Advanced row says ${JSON.stringify(summary)}`);
          await run(`__mc.click(${runBar("Run")})`);
          await until(`__mc.has("Waiting at ") && __mc.has("The graph asks:")`, "the interrupt callout");
          await until(`[...document.querySelectorAll("header")].some((h) => h.checkVisibility() && /checkpoint \\S+.*\\d+\\+? checkpoints?/.test(h.textContent))`, "the header's checkpoint and count");
          // The callout comes before the graph.
          const first = await run<boolean>(`(() => { const alert = [...document.querySelectorAll("[role=alert], [data-slot=alert]")].find((a) => a.checkVisibility() && a.textContent.includes("Waiting at")); const graph = [...document.querySelectorAll("[data-graph-node]")].find((n) => n.checkVisibility()); return Boolean(alert && graph && (alert.compareDocumentPosition(graph) & Node.DOCUMENT_POSITION_FOLLOWING)); })()`);
          if (!first) throw new Error("the interrupt callout is not before the graph");
          for (const [theme, density] of APPEARANCES) {
            await appearance(ctx, theme, density);
            await shot(`thread at the interrupt, ${theme}, ${density}`);
          }
          await appearance(ctx, "light", "comfortable");
          await run(`__mc.click(${advancedRow})`);
          await until(`${advancedRow}.getAttribute("aria-expanded") === "true" && __mc.has("Interrupt before")`, "the Advanced fold open");
          await shot("the Advanced fold open");
          await run(press(runBar("More actions")));
          await until(`${menuItem("Roll back the run")} && ${menuItem("Delete thread")}`, "the header's menu");
          await shot("the header's menu");
          await run(press(menuItem("Delete thread")));
          await until(`[...document.querySelectorAll("[role=alertdialog]")].some((d) => d.textContent.includes("Delete thread"))`, "the delete confirmation");
          await run(`__mc.click([...document.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent.trim() === "Delete thread"))`);
          await until(`__mc.button("New thread") && ${visibleButton("New thread")}`, "back on the threads list");
          // The threads list's Advanced: sort and rows per page.
          await run(press(`[...document.querySelectorAll("button")].find((b) => b.checkVisibility() && b.textContent.trim().startsWith("Advanced"))`));
          await until(`[...document.querySelectorAll("label")].some((l) => l.checkVisibility() && l.textContent.trim() === "Sort by")`, "the threads' Advanced");
          for (const [theme, density] of APPEARANCES) {
            await appearance(ctx, theme, density);
            await shot(`threads with Advanced open, ${theme}, ${density}`);
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
      id: "frame-limit",
      text: "TSK-108 (DOC-21 §9, replies and the frame limit): a thread with many runs or heavy states never fails with a frame-size error. History and the runs of a thread come in pages of at most 4 MiB with a token for the next; a value over its share (1 MiB in a list, 8 MiB for one state) is left out with a note (its size, type and start) that loads on request, from a reply of up to 12 MiB or from a stream; a run event over 4 MiB is a note too.",
      lab: true,
      checks: [
        cargo("json_len_matches_the_compact_text"),
        cargo("shrink_cuts_the_biggest_first_and_stops_at_the_share"),
        cargo("shrink_counts_the_rest_and_keeps_small_values"),
        cargo("a_page_takes_items_up_to_the_budget_and_always_the_first"),
        cargo("the_upstream_page_follows_the_weight"),
        cargo("runs_come_in_pages_of_bytes_and_the_pages_add_up_to_every_run"),
        cargo("a_run_with_big_metadata_is_cut_and_loaded_on_request"),
        cargo("the_history_of_heavy_checkpoints_comes_in_pages_with_notes"),
        cargo("a_heavy_page_is_asked_again_for_fewer_checkpoints"),
        cargo("a_small_history_is_one_page_with_nothing_left"),
        cargo("a_state_over_its_share_is_cut_then_loaded_then_streamed"),
        cargo("a_run_event_over_its_share_is_forwarded_as_a_note"),
        lab("lab_a_thread_with_many_heavy_runs_is_paged_by_bytes"),
        lab("lab_heavy_checkpoints_are_left_out_of_history_and_load_on_request"),
        vitest("test/langgraph.test.tsx", "history: pages follow the server's token"),
        vitest("test/langgraph.test.tsx", "a value over what one reply can carry is read as a stream"),
        browser("the heavy thread's History: a checkpoint's values left out with their size, then loaded (TSK-108)", async ({ page, origin, until, run, shot }) => {
          // The thread the lab seeds with checkpoints of up to 6 MiB (`lab seed langgraph`).
          const found = (await (await fetch("http://127.0.0.1:2024/threads/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { lab: "heavy-state" }, limit: 1 }) })).json()) as { thread_id: string }[];
          if (!found[0]) throw new Error("the lab has no heavy-state thread: run `lab seed langgraph`");
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await page.navigate(`${origin}/langgraph/lab/threads/${found[0].thread_id}/history`);
          // History opens on the selected checkpoint's diff (TSK-96); its full state has the note.
          await until(visibleButton("Full state"), "the checkpoint's pane", 30_000);
          await run(press(visibleButton("Full state")));
          const note = `[...document.querySelectorAll("[role=group]")].find((g) => g.checkVisibility() && g.getAttribute("aria-label") === "Values, left out")`;
          await until(note, "the newest checkpoint's values left out", 30_000);
          const text = await run<string>(`${note}.textContent`);
          if (!/Values is an object of \d+(\.\d)? MiB/.test(text)) throw new Error(`the note says ${JSON.stringify(text)}`);
          await shot("a checkpoint's values left out, with their size");
          const load = `[...document.querySelectorAll("button")].find((b) => b.checkVisibility() && /^Load \\d/.test(b.textContent.trim()))`;
          await run(`${load}.click()`);
          await until(`!(${note}) && [...document.querySelectorAll("[aria-label=Values]")].some((v) => v.checkVisibility())`, "the values loaded", 60_000);
          await shot("the values loaded");
        }),
      ],
    },
    {
      id: "runs-history-edit",
      text: "TSK-96 (DOC-21 §11.2.1, Open question 45 (n)): a thread's Runs tab lists its runs (status, assistant, start, duration, multitask strategy, a failed run's error, where an interrupted one waits) with Resume, Cancel and Run again with the same input; History shows a checkpoint against its parent (Diff, Full state, Graph) with a Source filter and the count of branches; Edit state is a sheet with As node, the checkpoint to start from, and What changes before it is sent, then Update state or Update and continue the run.",
      lab: true,
      checks: [
        cargo("threads_state_history_and_fork"),
        cargo("a_run_stream_follows_the_credits_and_joins_from_the_last_event"),
        cargo("a_run_s_big_input_is_cut_in_get_and_streamed_whole"),
        lab("lab_a_run_s_request_and_its_own_checkpoints"),
        vitest("test/langgraph.test.tsx", "What changes: messages are appended"),
        vitest("test/langgraph.test.tsx", "a step's nodes: its writes, else its parent's next"),
        vitest("test/langgraph.test.tsx", "a run's duration, note and last checkpoint"),
        vitest("test/langgraph.test.tsx", "Runs: the table, a failed run's error"),
        vitest("test/langgraph.test.tsx", "History: a checkpoint against its parent"),
        vitest("test/langgraph.test.tsx", "Edit state: what changes before it is sent"),
        browser("a thread's Runs, History's diff and Edit state's preview (TSK-96)", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          // A thread of its own, run to the approval interrupt, so it has runs and checkpoints.
          const made = (await (await fetch("http://127.0.0.1:2024/threads", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ metadata: { lab: "tsk-96" } }) })).json()) as { thread_id: string };
          const waited = await fetch(`http://127.0.0.1:2024/threads/${made.thread_id}/runs/wait`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assistant_id: "agent", input: { messages: [{ type: "human", content: "What is 6 times 7?" }] } }) });
          if (!waited.ok) throw new Error(`the lab's run did not finish: ${waited.status} ${await waited.text()}`);
          const runsUrl = `${origin}/langgraph/lab/threads/${made.thread_id}/runs`;
          const rows = `[...document.querySelectorAll("table[aria-label=Runs] tbody tr")].filter((r) => r.checkVisibility())`;
          const noted = `${rows}.some((r) => r.textContent.includes("waiting at"))`;
          await page.navigate(runsUrl);
          await until(`${rows}.length > 0`, "the thread's runs", 30_000);
          await shot("Runs");
          // The note reads the run's last checkpoint; a lab still writing it gets one more look.
          try {
            await until(noted, "the interrupted run with its note", 15_000);
          } catch {
            await page.navigate(runsUrl);
            try {
              await until(noted, "the interrupted run with its note, after a reload", 15_000);
            } catch {
              throw new Error(`no "waiting at" note; the rows say: ${await run<string>(`${rows}.map((r) => r.textContent).join(" | ")`)}`);
            }
          }
          await run(press(`document.querySelector("table[aria-label=Runs] tbody tr button")`));
          await until(`[...document.querySelectorAll("[aria-label=Input]")].some((v) => v.checkVisibility())`, "the run's input");
          await shot("a run's detail");
          await page.navigate(`${origin}/langgraph/lab/threads/${made.thread_id}/history`);
          await until(`[...document.querySelectorAll("section[aria-label^='Step']")].some((p) => p.checkVisibility() && /What changed since step|first checkpoint/.test(p.textContent))`, "the newest checkpoint against its parent", 30_000);
          await shot("History with a diff");
          await run(press(visibleButton("Fork from here")));
          await until(`[...document.querySelectorAll("[role=dialog]")].some((d) => d.textContent.includes("What changes"))`, "the Edit state sheet");
          await shot("Edit state");
        }),
      ],
    },
    {
      id: "assistant-graph-versions",
      text: "TSK-96 (DOC-21 §11.2.1, Open question 45 (n)): an assistant's Graph has xray at a depth and a node pane (edges in and out, metadata, visits, median and p95 time and errors over the assistant's last 50 runs, read from their checkpoints on the server, with the threads that passed through it); its Versions tab lists every version with what changed and the diff of config, context and metadata against the one before, side by side or unified, read only; New thread starts a thread with the assistant. Assistants are grouped by graph with a graph and a text filter; Schemas lists the five schemas, shows one as a table of properties or as JSON, and makes an example input from the input schema with Start a thread with it; Config copies config, context and metadata.",
      lab: true,
      checks: [
        cargo("steps_name_their_nodes_from_the_parent_s_next_and_time_from_the_parent"),
        cargo("writes_win_over_next_and_errors_count_against_their_node"),
        cargo("quantiles_take_the_nearest_rank_and_threads_stop_at_five"),
        cargo("an_assistant_s_versions_and_node_statistics"),
        lab("lab_an_assistant_s_versions_and_node_statistics"),
        vitest("test/langgraph.test.tsx", "what a version changed, in a line"),
        vitest("test/langgraph.test.tsx", "Versions: the list with what changed"),
        vitest("test/langgraph.test.tsx", "Graph: a node's edges and its statistics"),
        vitest("test/langgraph.test.tsx", "a schema's properties, facts, summary and an example input"),
        vitest("test/langgraph.test.tsx", "Assistants: grouped by graph, filtered by graph and by text"),
        vitest("test/langgraph.test.tsx", "Schemas: the list, the properties, the example input"),
        browser("an assistant's node pane and Versions (TSK-96)", async ({ page, origin, until, run, shot }) => {
          const found = (await (await fetch("http://127.0.0.1:2024/assistants/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ graph_id: "agent", limit: 1 }) })).json()) as { assistant_id: string }[];
          if (!found[0]) throw new Error("the lab has no assistant of graph agent");
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await page.navigate(`${origin}/langgraph/lab/assistants/${found[0].assistant_id}/graph`);
          const node = `[...document.querySelectorAll('[data-slot="graph-view-node"]')].find((n) => n.checkVisibility() && !/start|end/.test(n.textContent))`;
          await until(node, "the graph's nodes", 30_000);
          await run(press(node));
          await until(`[...document.querySelectorAll("section[aria-label^='Node ']")].some((p) => p.checkVisibility() && /In the last/.test(p.textContent) && !/Reading the last runs/.test(p.textContent))`, "the node's statistics", 60_000);
          await shot("Graph with a node's pane");
          await page.navigate(`${origin}/langgraph/lab/assistants/${found[0].assistant_id}/versions`);
          await until(`[...document.querySelectorAll("table[aria-label=Versions] tbody tr")].some((r) => r.checkVisibility())`, "the versions", 30_000);
          await shot("Versions");
        }),
      ],
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
