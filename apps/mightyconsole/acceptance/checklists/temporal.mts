// TSK-83, Temporal (Mightyconsole spec section 18, against the lab). Every item is wired to the
// tests that prove it: cargo tests against the lab's Temporal dev server (the `lab-tests` feature),
// UI tests against a stub client, and a walk through the tool in a browser with screenshots. The
// destructive actions are proved by the cargo tests on workflows they start themselves; the browser
// opens their confirmations but never confirms one, so the lab's seeded workflows stay as they are.
import { browser, cargo, type Checklist, command, manual, vitest } from "../checklist.mts";

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
const panelButton = (label: string) =>
  `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)})`;
const click = (label: string) => `__mc.click(${panelButton(label)})`;

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
  await until(`${panelButton("Running")}`, "the status chips");
  await run(click("Running"));
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
      text: "Namespaces; the workflow list with visibility queries, status chips, count and paging.",
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
          await run(click("Failed"));
          await until(`__mc.has("failed-1") && !__mc.has("scheduled-")`, "the Failed chip filters the list");
          await shot("filtered by Failed");
          await run(click("Failed"));
          await until(`__mc.has("scheduled-")`, "the chip off shows every workflow again");
          await run(click("Running"));
          await until(`__mc.has("fulfilment-long-running") && __mc.has("retrying-1") && !__mc.has("failed-1")`, "the Running chip");
          await shot("filtered by Running");
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
        ),
        ...unit(
          "each_encoding_decodes_as_the_spec_says",
          "invalid_json_in_a_json_payload_falls_back_to_the_text",
          "payload_lists_and_nested_payloads_are_decoded_in_place",
          "a_history_event_becomes_json_with_its_payloads_decoded",
        ),
        vitest("test/temporal-workflow.test.tsx"),
        vitest("test/temporal-history.test.ts"),
        browser("the Timeline, History, pending activity and stack trace of lab workflows", async (ctx) => {
          const { run, until, shot } = ctx;
          await runningWorkflows(ctx);
          await run(click("retrying-1"));
          await until(`__mc.has("Input and result") && __mc.has("flaky") && __mc.has("Live")`, "the retrying workflow's Timeline, followed live");
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
          await until(`__mc.has("Input and result") && ${panelButton("Terminate")} && !${panelButton("Terminate")}.disabled`, "the running workflow's tab, loaded");
          await run(click("Terminate"));
          await until(`__mc.has("Terminate fulfilment-long-running?") && __mc.has("cannot be undone")`, "the terminate confirmation naming the workflow");
          const enabled = await run<boolean>(`Boolean([...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Terminate" && !b.disabled))`);
          if (enabled) throw new Error("Terminate is enabled before a reason is typed");
          await shot("terminate confirmation, reason required");
          await run(inDialog("Cancel"));
          await until(`!__mc.has("cannot be undone")`, "the confirmation closes without acting");
          await run(click("Reset"));
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
          await until(`__mc.has("Upcoming runs")`, "the schedule's detail");
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
