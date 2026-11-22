// TSK-83, Temporal (Mightyconsole spec section 18, against the lab). Every item is wired to the
// tests that prove it: cargo tests against the lab's Temporal dev server (the `lab-tests` feature),
// UI tests against a stub client, and a walk through the tool in a browser with screenshots. The
// destructive actions are proved by the cargo tests on workflows they start themselves; the browser
// opens their confirmations but never confirms one, so the lab's seeded workflows stay as they are.
import { browser, cargo, type Checklist, command, manual, vitest } from "../checklist.mts";
import { APPEARANCES, appearance, openSuggestions, suggestionRows, suggestionsOnTop, typeInEditor } from "../editors.mts";

/** One cargo check per test function (the filter names the function), against the lab. */
const lab = (...names: string[]) => names.map((name) => cargo(name, { features: ["lab-tests"] }));
/** One cargo check per test function that needs no lab. */
const unit = (...names: string[]) => names.map((name) => cargo(name));

/** What a browser check gets (see acceptance/README.md). */
type Ctx = Parameters<Parameters<typeof browser>[1]>[0];

/**
 * A button of the tab on screen. Tabs stay mounted when they are not shown (and an earlier check's
 * tabs come back after a reload), so `__mc.button` could find the same button of a hidden tab.
 */
// A view's tab may carry a count after its name ("History 214", "Pending 1").
const panelButton = (label: string) =>
  `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)} || (b.getAttribute("role") === "tab" && /^${label} [\\d,]+$/.test(b.textContent.trim())))`;
const click = (label: string) => `__mc.click(${panelButton(label)})`;
/** An item of the open menu, by the start of its text ("Terminate…"). */
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

/**
 * Picks a status in the visible Workflows tab's Status menu (TSK-91, Open question 45 (f): the
 * chips became a menu that rewrites the query's ExecutionStatus clause). "Any status" clears it.
 * Three plain evaluations, not one async one: Chrome may collect a pending promise of an awaited
 * evaluation ("Promise was collected").
 */
async function pickStatus({ run, until }: Pick<Ctx, "run" | "until">, label: string): Promise<void> {
  const option = `[...document.querySelectorAll("[role=option]")].find((o) => o.textContent.trim() === ${JSON.stringify(label)})`;
  await run(press(`[...document.querySelectorAll("[role=tabpanel]:not([hidden]) [role=combobox]")].find((b) => b.getAttribute("aria-label") === "Status")`));
  await until(option, `the "${label}" status in the menu`);
  await run(press(option));
}

/** Opens the page, adds the lab's Temporal profile when it is not there yet, and connects it. */
async function connectLab({ page, origin, until, run, shot }: Ctx, withShot = false): Promise<void> {
  await page.navigate(`${origin}/`);
  await until(`__mc.button("Temporal")`, "the tool rail");
  await run(`__mc.click(__mc.button("Temporal"))`);
  await until(`__mc.button("Add connection") || __mc.item("lab-temporal")`, "the connection list");
  if (!(await run<boolean>(`Boolean(__mc.item("lab-temporal"))`))) {
    await run(`__mc.click(__mc.button("Add connection"))`);
    await until(`__mc.field("Name")`, "the profile sheet");
    await run(`__mc.type(__mc.field("Name"), "lab-temporal")`);
    await run(`__mc.type(__mc.field("Namespace"), "lab")`);
    if (withShot) await shot("the Temporal profile form");
    await run(`__mc.click(__mc.button("Save"))`);
    await until(`__mc.item("lab-temporal")`, "the saved profile");
  }
  // A tab restored from an earlier check reconnects its profile by itself; a second double-click
  // would disconnect it again. So give that a moment, and connect by hand only if it did not.
  const auto = await run<boolean>(
    `new Promise((resolve) => { const start = Date.now(); const tick = () => (__mc.item("Workflows") ? resolve(true) : Date.now() - start > 4000 ? resolve(false) : setTimeout(tick, 100)); tick(); })`,
  );
  if (!auto) await run(`__mc.dblclick(__mc.item("lab-temporal"))`);
  await until(`__mc.item("Workflows")`, "temporal.connect and the resource tree");
}

/** The workflow list of the lab, narrowed to the running workflows (the seeded long-running ones). */
async function runningWorkflows(ctx: Ctx): Promise<void> {
  const { run, until } = ctx;
  await connectLab(ctx);
  await run(`__mc.dblclick(__mc.item("Workflows"))`);
  await until(`[...document.querySelectorAll("[role=tabpanel]:not([hidden]) [role=combobox]")].some((b) => b.getAttribute("aria-label") === "Status")`, "the Status menu");
  await pickStatus(ctx, "Running");
  await until(`__mc.has("fulfilment-long-running") && __mc.has("retrying-1")`, "the running seeded workflows");
}

/** Presses a button inside the open dialog (the toolbar has buttons of the same names). */
const inDialog = (label: string) =>
  `(() => { const b = [...document.querySelectorAll("[role=dialog] button")].find((x) => x.textContent.trim() === ${JSON.stringify(label)}); if (!b) throw new Error("no button ${label} in a dialog"); b.click(); return true; })()`;

export default {
  id: "temporal",
  task: "TSK-83",
  title: "Temporal",
  builtWhen: "apps/mightyconsole/server/src/tools/temporal",
  lab: ["temporal"],
  items: [
    {
      id: "workflows",
      text: "Namespaces; the workflow list with visibility queries, the Status menu, count and paging. TSK-105 (DOC-21 §3.7): a workflow opened from the list takes a step in the same tab; the navigation row shows the profile, the namespace, Workflows, the workflow and its view; Back's list names the steps; the namespace segment lists the cluster's namespaces and switching keeps the view; a link to a profile this browser lacks shows its page.",
      lab: true,
      checks: [
        ...lab(
          "the_server_says_who_it_is",
          "namespaces_are_listed_with_the_profiles_one_marked",
          "workflows_are_listed_by_visibility_query_with_status_and_paging",
          "the_count_follows_the_query",
          "a_bad_query_is_invalid_and_an_unknown_namespace_is_not_found",
          "a_bad_page_size_or_token_is_invalid_before_any_call",
        ),
        ...unit(
          "grpc_codes_map_to_the_error_kinds_of_the_spec",
          "an_api_key_needs_tls",
          "a_client_certificate_needs_its_key",
          "the_address_is_host_and_port",
          "nothing_listening_is_a_connect_error_with_the_address",
        ),
        vitest("test/temporal-workflows.test.tsx"),
        vitest("test/temporal.test.ts"),
        browser("add a Temporal profile for the lab, list the workflows, filter by status", async (ctx) => {
          const { until, run, shot } = ctx;
          await connectLab(ctx, true);
          await run(`__mc.dblclick(__mc.item("Workflows"))`);
          await until(`__mc.has(" workflows") && __mc.has("scheduled-")`, "the workflow list with its count");
          await shot("the workflow list");
          await pickStatus(ctx, "Failed");
          await until(`__mc.has("failed-1") && !__mc.has("scheduled-")`, "the Failed status filters the list");
          await shot("filtered by Failed");
          await pickStatus(ctx, "Any status");
          await until(`__mc.has("scheduled-")`, "Any status shows every workflow again");
          await pickStatus(ctx, "Running");
          await until(`__mc.has("fulfilment-long-running") && __mc.has("retrying-1") && !__mc.has("failed-1")`, "the Running status");
          await shot("filtered by Running");
        }),
        vitest("test/nav-row.test.tsx"),
        vitest("test/routing.test.tsx"),
        browser("a workflow in the same tab, the row, Back's list, the namespace's siblings, a missing profile", async (ctx) => {
          const { page, origin, run, until, shot } = ctx;
          const row = `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) [role=toolbar][aria-label=Location]")].find((r) => r.offsetParent !== null)`;
          const crumbs = `[...${row}.querySelectorAll("[data-slot=breadcrumb-item]")].map((el) => el.textContent.trim()).join(" / ")`;
          const rowButton = (label: string) => `[...${row}.querySelectorAll("button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)})`;
          await runningWorkflows(ctx);
          const tabs = await run<number>(`document.querySelectorAll("[role=tablist][aria-label=Tabs] [role=tab]").length`);
          await run(click("fulfilment-long-running"));
          await until(`${row} && ${crumbs} === "lab-temporal / lab / Workflows / fulfilment-long-running / Timeline"`, "the workflow's crumbs in the same tab");
          const after = await run<number>(`document.querySelectorAll("[role=tablist][aria-label=Tabs] [role=tab]").length`);
          if (after !== tabs) throw new Error(`a link opened a tab (${tabs} → ${after})`);
          await shot("the navigation row on a workflow");
          await run(`${rowButton("Back")}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }))`);
          await until(`${menuItem("Workflows · lab")} && ${menuItem("Timeline · fulfilment-long-running")}`, "Back's list of this tab");
          await shot("Back's list");
          await run(`document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
          await run(press(rowButton("Back")));
          await until(`location.pathname === "/temporal/lab-temporal/lab/workflows" && ${crumbs} === "lab-temporal / lab / Workflows"`, "Back to the list in the same tab");
          await run(press(rowButton("lab")));
          await until(`${menuItem("default")} && __mc.has("Namespaces of lab-temporal")`, "the namespace segment's siblings");
          await shot("the namespace's siblings");
          await run(press(menuItem("default")));
          await until(`location.pathname === "/temporal/lab-temporal/default/workflows" && ${crumbs} === "lab-temporal / default / Workflows"`, "Workflows of default, the view kept");
          await page.navigate(`${origin}/temporal/prod-eu/lab/workflows/retrying-1/history`);
          await until(`__mc.has("This link needs a Temporal profile named prod-eu") && location.pathname === "/temporal/prod-eu/lab/workflows/retrying-1/history"`, "the missing-profile page");
          await shot("a link to a missing profile");
        }),
        // TSK-94: the query's suggestions, as the mockup's temporal-workflows frame: built-in
        // attributes before the namespace's custom one (the lab registers OrderId), each with its
        // type, over the table's sticky header, in every appearance.
        browser("the query's suggestions: built-in then custom attributes, over the table (TSK-94)", async (ctx) => {
          const { until, run, shot } = ctx;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Workflows"))`);
          await until(`__mc.has(" workflows") && __mc.has("fulfilment-long-running")`, "the workflow list");
          await typeInEditor(ctx, "Visibility query", "Or");
          await openSuggestions(ctx);
          await until(`[...document.querySelectorAll("[data-slot=code-editor-overflow] .suggest-widget.visible .monaco-list-row")].some((r) => r.textContent.includes("OrderId") && r.textContent.includes("Keyword · custom"))`, "OrderId offered as a custom Keyword");
          await typeInEditor(ctx, "Visibility query", 'WorkflowType = "Fulfilment" AND Ex');
          for (const [theme, density] of APPEARANCES) {
            await appearance(ctx, theme, density);
            await openSuggestions(ctx, theme === "light" && density === "comfortable");
            const rows = await suggestionRows(ctx);
            if (!rows.some((r) => r.includes("ExecutionStatus") && r.includes("Keyword"))) throw new Error(`no ExecutionStatus suggestion: ${JSON.stringify(rows)}`);
            if (!(await suggestionsOnTop(ctx))) throw new Error(`${theme}/${density}: a suggestion row is covered`);
            await shot(`query suggestions, ${theme}, ${density}`);
          }
          await appearance(ctx, "light", "comfortable");
        }),
        // TSK-95: the mockup's query row (namespace with its folder, "Status: Any", the query's
        // icon, Columns, Run), Save query into the tree, the saved query renamed and deleted from
        // its node's menu, and a column hidden by Columns, kept after a reload.
        vitest("test/saved-queries.test.tsx"),
        browser("Save query, the saved query in the tree renamed and deleted, Columns (TSK-95)", async (ctx) => {
          const { page, until, run, shot } = ctx;
          const name = `Failed ${Date.now().toString(36)}`;
          const renamed = `${name} renamed`;
          const dialog = `[...document.querySelectorAll("[role=dialog], [role=alertdialog]")].find((d) => d.offsetParent !== null)`;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Workflows"))`);
          await until(`__mc.has(" workflows") && __mc.has("scheduled-")`, "the workflow list");
          for (const [theme, density] of APPEARANCES) {
            await appearance(ctx, theme, density);
            await shot(`the query row, ${theme}, ${density}`);
          }
          await appearance(ctx, "light", "comfortable");
          await pickStatus(ctx, "Failed");
          await until(`__mc.has("failed-1") && !__mc.has("scheduled-")`, "the Failed workflows");
          await run(press(panelButton("Save query")));
          await until(`document.querySelector('input[placeholder="Failed today"]')`, "the name field");
          await run(`__mc.type(document.querySelector('input[placeholder="Failed today"]'), ${JSON.stringify(name)})`);
          await shot("Save query");
          await run(`__mc.click([...document.querySelectorAll("button[type=submit]")].find((b) => b.textContent.trim() === "Save"))`);
          await until(`__mc.item(${JSON.stringify(name)})`, "the saved query under Workflows");
          await shot("the saved query in the tree");
          await run(`(() => { const el = __mc.item(${JSON.stringify(name)}); el.click(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 300 })); return true; })()`);
          await until(menuItem("Rename saved query…"), "Rename in the node's menu");
          await shot("the saved query's menu");
          await run(press(menuItem("Rename saved query…")));
          await until(`${dialog} && ${dialog}.querySelector("input")`, "the rename dialog");
          await run(`__mc.type(${dialog}.querySelector("input"), ${JSON.stringify(renamed)})`);
          await run(`__mc.click([...${dialog}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Rename"))`);
          await until(`__mc.item(${JSON.stringify(renamed)})`, "the renamed node");
          await run(`(() => { const el = __mc.item(${JSON.stringify(renamed)}); el.click(); el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 300 })); return true; })()`);
          await until(menuItem("Delete saved query"), "Delete in the node's menu");
          await run(press(menuItem("Delete saved query")));
          await until(`${dialog} && ${dialog}.textContent.includes("Delete the saved query")`, "the confirmation");
          await shot("deleting the saved query");
          await run(`__mc.click([...${dialog}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Delete"))`);
          await until(`!__mc.item(${JSON.stringify(renamed)})`, "the saved query gone");
          // Columns: hide Run ID; it stays hidden after a reload.
          const heads = `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) thead th")].map((h) => h.textContent.trim())`;
          await run(press(panelButton("Columns")));
          await until(`[...document.querySelectorAll("li")].some((l) => l.textContent.trim() === "Run ID")`, "the Columns chooser");
          await shot("Columns");
          await run(press(`[...document.querySelectorAll("li")].find((l) => l.textContent.trim() === "Run ID").querySelector("[role=checkbox]")`));
          await until(`!${heads}.includes("Run ID")`, "Run ID hidden");
          await page.navigate(await run<string>("location.href"));
          await until(`${heads}.includes("Workflow ID") && !${heads}.includes("Run ID")`, "Run ID still hidden after a reload");
          await run(press(panelButton("Columns")));
          await until(`[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Reset to default")`, "the chooser again");
          await run(press(`[...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Reset to default")`));
          await until(`${heads}.includes("Run ID")`, "the columns reset");
        }),
      ],
    },
    {
      id: "detail",
      text: "Workflow detail: Timeline and history (paged and followed live), input and result, pending activities with the retrying one, stack trace through the worker; payloads decoded by encoding (the Protobuf one through the codecs once TSK-80 is on main).",
      lab: true,
      checks: [
        ...lab(
          "a_completed_history_has_its_input_and_result_decoded",
          "history_pages_join_into_the_whole_history",
          "a_failed_workflow_has_its_failure_and_the_cause",
          "a_parent_has_child_workflow_events",
          "the_labs_protobuf_payload_arrives_as_its_json",
          "describe_a_running_workflow",
          "describe_shows_the_retrying_activity",
          "describe_a_closed_workflow_has_no_pending_work",
          "queries_answer_through_the_worker",
          "following_a_closed_run_sends_everything_after_the_cursor_and_ends",
          "following_an_open_run_sees_new_events_until_it_closes",
          "unknown_workflows_are_not_found_and_blank_ids_invalid",
          "an_event_reads_as_stored_with_its_encodings",
        ),
        ...unit(
          "each_encoding_decodes_as_the_spec_says",
          "invalid_json_in_a_json_payload_falls_back_to_the_text",
          "payload_lists_and_nested_payloads_are_decoded_in_place",
          "a_history_event_becomes_json_with_its_payloads_decoded",
        ),
        vitest("test/temporal-workflow.test.tsx"),
        vitest("test/temporal-history.test.ts"),
        vitest("test/temporal-history-view.test.ts"),
        vitest("test/temporal-polish.test.ts"),
        vitest("test/temporal-list-parts.test.ts"),
        browser("the Timeline, History, pending activity and stack trace of lab workflows", async (ctx) => {
          const { run, until, shot } = ctx;
          await runningWorkflows(ctx);
          await run(click("retrying-1"));
          await until(`__mc.has("Input and result") && __mc.has("flaky") && __mc.has("Following")`, "the retrying workflow's Timeline, followed live");
          await shot("timeline of retrying-1");
          await run(click("Pending"));
          await until(`__mc.has("the payment provider is down")`, "the retrying activity and its last failure");
          await shot("pending activity with its last failure");
          await run(click("History"));
          await until(`__mc.has("ActivityTaskScheduled")`, "the history table");
          await shot("history");
          await run(click("Input and result"));
          await until(`__mc.has("ord-flaky")`, "the decoded input");
          await shot("input and result");
          await run(click("Stack trace"));
          await until(`__mc.has("No worker answered") || __mc.has("Fetch stack trace")`, "the stack trace view");
          await shot("stack trace");
        }),
        manual("Protobuf payloads: the lab's proto-1 shows its input as JSON (json/protobuf); a binary/protobuf payload stays opaque with its message type until the codec registry of TSK-80 is on main"),
      ],
    },
    {
      id: "actions",
      text: "Signal, query, request cancellation, terminate and reset, each confirmed as specified, with the effect visible in the history.",
      lab: true,
      checks: [
        ...lab(
          "a_signal_reaches_the_workflow_and_its_arguments_are_in_the_history",
          "a_signal_needs_a_name_and_a_running_workflow",
          "cancellation_is_requested_and_the_workflow_ends_canceled",
          "terminate_needs_a_reason_and_ends_the_run_with_it",
          "reset_starts_a_new_run_from_the_event_and_ends_the_old_one",
          "reset_checks_its_input_before_asking",
        ),
        vitest("test/temporal-actions.test.tsx"),
        browser("the confirmations name the workflow and the destructive ones need a reason", async (ctx) => {
          const { run, until, shot } = ctx;
          await runningWorkflows(ctx);
          await run(click("fulfilment-long-running"));
          // The list tab shows "Running" too, so wait for this tab's own views and an enabled button.
          // Reset and Terminate are in the header's overflow menu (the mockup's place for them).
          await until(`__mc.has("Input and result") && ${panelButton("Request cancellation")} && !${panelButton("Request cancellation")}.disabled`, "the running workflow's tab, loaded");
          await run(click("More actions"));
          await until(menuItem("Terminate"), "the overflow menu");
          await run(`__mc.click(${menuItem("Terminate")})`);
          await until(`__mc.has("Terminate fulfilment-long-running?") && __mc.has("cannot be undone")`, "the terminate confirmation naming the workflow");
          const enabled = await run<boolean>(`Boolean([...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Terminate" && !b.disabled))`);
          if (enabled) throw new Error("Terminate is enabled before a reason is typed");
          await shot("terminate confirmation, reason required");
          await run(inDialog("Cancel"));
          await until(`!__mc.has("cannot be undone")`, "the confirmation closes without acting");
          await run(click("More actions"));
          await until(menuItem("Reset"), "the overflow menu");
          await run(`__mc.click(${menuItem("Reset")})`);
          await until(`__mc.has("Reset fulfilment-long-running?") && __mc.has("Reset to")`, "the reset confirmation");
          await shot("reset confirmation");
          await run(inDialog("Cancel"));
          await until(`!__mc.has("Reset to")`, "the reset confirmation closes");
          await run(click("Queries"));
          await until(`__mc.has("Query type")`, "the Queries view");
          await shot("queries");
        }),
      ],
    },
    {
      id: "schedules",
      text: "Schedules: list, describe, pause, unpause, trigger, delete; task queue pollers.",
      lab: true,
      checks: [
        ...lab(
          "the_seeded_schedule_is_listed_described_paused_resumed_and_triggered",
          "a_schedule_of_the_tests_own_is_deleted_and_then_gone",
          "schedule_calls_need_an_id",
          "the_lab_queue_has_workflow_and_activity_pollers_and_an_unknown_one_has_none",
        ),
        ...unit("specs_read_in_words", "a_reason_is_required_to_terminate_and_reset_and_trimmed", "overlap_policies_follow_the_proto_numbers"),
        vitest("test/temporal-schedules.test.tsx"),
        browser("the schedule list, one schedule, and the pollers of the lab task queue", async (ctx) => {
          const { run, until, shot } = ctx;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Schedules"))`);
          await until(`__mc.has("every-minute") && __mc.has("Every 1 minute")`, "the seeded schedule");
          await shot("schedules");
          await run(click("every-minute"));
          // 45 s: the detail waits on the server's describe (TSK-121: 2 timeouts at 20 s, on a runner
          // whose load stays above its 4 CPUs a third of the time, Temporal among the busiest).
          await until(`__mc.has("Computed by the server") && __mc.has("TemporalScheduledById")`, "the schedule's detail", 45_000);
          await shot("schedule detail");
          await run(`__mc.dblclick(__mc.item("Task queues"))`);
          await until(`__mc.field("Task queue")`, "the task queue form");
          await run(`__mc.type(__mc.field("Task queue"), "lab")`);
          await run(click("Look up"));
          await until(`__mc.has("Workflow pollers") && __mc.has("Activity pollers")`, "the pollers");
          await shot("task queue pollers");
        }),
      ],
    },
    {
      id: "timeline-pane",
      text: "Uy Son's feedback of 2026-11-19, part 1 (TSK-100, DOC-21 Open question 45 (r)): a Timeline item's details open in a pane beside the chart (times and waits, worker, retry policy, the failure with Copy, its own events unfolding to their attributes); an open workflow-task fold in History shows its events indented with a guide line; no key hints drawn on buttons.",
      lab: true,
      checks: [
        vitest("test/temporal-timeline-detail.test.ts"),
        vitest("test/temporal-workflow.test.tsx"),
        vitest("test/temporal-history-view.test.ts"),
        vitest("test/temporal-write-sheets.test.tsx"),
        vitest("test/shell.test.tsx"),
        command("the Timeline's aside and Fit's tooltip in packages/ui", ["pnpm", "--filter", "@byterygon/ui", "exec", "vitest", "run", "src/components/timeline"]),
        browser("the retrying activity's pane beside the Timeline and an open fold in History", async (ctx) => {
          const { run, until, shot } = ctx;
          await runningWorkflows(ctx);
          await run(click("retrying-1"));
          // The tab may be open already from the detail walk, on another view: go to the Timeline.
          await until(`__mc.has("Input and result") && ${panelButton("Timeline")}`, "the workflow's views");
          await run(click("Timeline"));
          // Other workflow tabs stay mounted (hidden), so every query takes the element on screen.
          const shown = (selector: string) => `[...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => e.offsetParent !== null)`;
          const panel = shown("[data-slot=timeline-aside]");
          await until(`${panel} && __mc.has("Click a bar, a diamond or a pin")`, "the Timeline with its empty pane");
          await run(`__mc.click(${shown("[data-slot=timeline-item][data-shape=hatched]")})`);
          await until(`${panel}.textContent.includes("Retrying") && ${panel}.textContent.includes("Events") && ${panel}.textContent.includes("the payment provider is down")`, "the retrying activity's details, failure and events");
          // Within the workflow's tab (its outermost tab panel): the title bar's command search box keeps its Ctrl+K, as search fields do.
          const hints = await run<number>(`(() => { let tab = ${panel}; while (tab.parentElement && tab.parentElement.closest("[role=tabpanel]")) tab = tab.parentElement.closest("[role=tabpanel]"); return tab.querySelectorAll("button kbd").length; })()`);
          if (hints > 0) throw new Error(`${hints} key hint(s) drawn on buttons`);
          await shot("timeline with the retrying activity's pane");
          await run(click("History"));
          await until(shown("button[aria-label^='Unfold events']"), "a folded workflow task");
          await run(`__mc.click(${shown("button[aria-label^='Unfold events']")})`);
          await until(shown("tr[data-in-fold] [data-slot=fold-guide]"), "the fold's events indented with the guide line");
          await shot("history with an open fold");
        }),
      ],
    },
    {
      id: "long-histories",
      text: "TSK-109 (DOC-21 9.6.1): long histories near Temporal's limits (the lab's history-many-1, history-heavy-1 and history-follow-1) page by bytes under the frame, newest first or oldest first, an event over its share kept on the server, the download a stream; History and the Timeline open on the newest events, stay smooth while scrolled and followed, and Oldest first is one click away.",
      lab: true,
      checks: [
        ...lab(
          "the_longest_history_pages_newest_first_without_gaps",
          "the_heaviest_history_pages_under_the_frame_both_ways",
          "a_running_long_history_is_followed_from_its_newest_event",
          "an_event_reads_as_stored_from_either_end",
          "the_heavy_history_downloads_a_page_at_a_time_in_both_forms",
        ),
        ...unit(
          "pages_stop_at_the_budget_and_join_without_gaps_or_repeats",
          "a_page_that_goes_over_is_cut_and_resumed_after_the_last_event_sent",
          "the_first_event_always_goes_and_the_count_is_a_maximum",
          "an_answer_too_large_to_read_is_asked_again_for_fewer",
          "cursors_round_trip_and_reject_other_tokens",
          "an_event_over_its_share_has_its_payloads_kept_on_the_server",
          "an_event_still_over_its_share_is_cut_with_a_preview",
        ),
        vitest("test/temporal-history-store.test.ts"),
        vitest("test/temporal-workflow.test.tsx", "long histories"),
        command("the Timeline draws one instant per 2 px of a dense lane in packages/ui", ["pnpm", "--filter", "@byterygon/ui", "exec", "vitest", "run", "src/components/timeline", "-t", "thousands of instants"]),
        browser("the lab's long histories: newest first with the run's length in the footer, Oldest first one click away, the heavy one without a frame error", async (ctx) => {
          const { page, origin, run, until, shot } = ctx;
          await connectLab(ctx);
          const table = `[...document.querySelectorAll("table[aria-label='History events']")].find((t) => t.checkVisibility())`;
          const firstId = `${table}?.querySelector("tbody tr:not([data-spacer]) td")?.textContent`;
          const footer = `/([\\d,]+) of ([\\d,]+) events loaded/.exec(document.body.innerText)`;
          const order = (label: string) => `__mc.click([...document.querySelectorAll("button")].find((b) => b.checkVisibility() && b.textContent.trim() === ${JSON.stringify(label)}))`;
          await page.navigate(`${origin}/temporal/lab-temporal/lab/workflows/history-many-1/history`);
          await until(firstId, "History's first rows", 30_000);
          await until(`${footer} && Number(${footer}[2].replace(/,/g, "")) >= 40000`, "the footer with the run's length");
          const total = await run<number>(`Number(${footer}[2].replace(/,/g, ""))`);
          const top = await run<string>(firstId);
          if (Number(top) !== total) throw new Error(`the first row is event ${top}, not the newest, ${total}`);
          await shot("history-many-1 newest first");
          await run(order("Oldest first"));
          await until(`${firstId} === "1"`, "Oldest first, from event 1", 30_000);
          await shot("history-many-1 oldest first");
          // Back to the default, as the setting is kept.
          await run(order("Newest first"));
          await until(`${firstId} === ${JSON.stringify(String(total))}`, "Newest first again", 30_000);
          await page.navigate(`${origin}/temporal/lab-temporal/lab/workflows/history-heavy-1/history`);
          await until(firstId, "the heavy history's first rows", 30_000);
          // An alert that says something (the toast region is an empty alert until it shows one).
          const alerts = await run<string[]>(`[...document.querySelectorAll("[role=alert]")].filter((e) => e.checkVisibility()).map((e) => e.textContent.trim()).filter(Boolean)`);
          if (alerts.length > 0) throw new Error(`the heavy history shows ${alerts.join(" | ")}`);
          await shot("history-heavy-1");
        }),
        manual("bench:history before and after on the task page (DOC-21 9.6.1)"),
      ],
    },
    {
      id: "components",
      text: "Timeline is in packages/ui; CI green.",
      checks: [
        command("the Timeline component: its tests, the convention suite and the registry", ["pnpm", "--filter", "@byterygon/ui", "exec", "vitest", "run", "src/components/timeline", "test/conventions.test.tsx", "-t", "imeline"]),
        command("registry/ is up to date", ["pnpm", "--filter", "@byterygon/ui", "registry:check"]),
        manual("CI of the last PR is green"),
      ],
    },
  ],
} satisfies Checklist;
