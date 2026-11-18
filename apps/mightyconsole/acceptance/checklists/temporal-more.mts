// TSK-92, the Temporal additions (Mightyconsole spec section 18, "TSK-92, Temporal additions",
// Open question 45 (h), (k), (l)): namespaces, workers, start workflow, schedule create and edit,
// standalone activities, the codec server and large payloads, against the lab. Each batch of the
// task wires its items; an item with no check yet is reported as not wired.
import { browser, cargo, type Checklist, vitest } from "../checklist.mts";

/** One cargo check per test function, against the lab. */
const lab = (...names: string[]) => names.map((name) => cargo(name, { features: ["lab-tests"] }));
/** One cargo check per test function that needs no lab. */
const unit = (...names: string[]) => names.map((name) => cargo(name));

type Ctx = Parameters<Parameters<typeof browser>[1]>[0];

/** Opens the page and connects the lab's Temporal profile (made by the TSK-83 checklist or here). */
async function connectLab({ page, origin, until, run }: Ctx): Promise<void> {
  await page.navigate(`${origin}/`);
  await until(`__mc.button("Temporal")`, "the tool rail");
  await run(`__mc.click(__mc.button("Temporal"))`);
  await until(`__mc.button("Add connection") || __mc.item("lab-temporal")`, "the connection list");
  if (!(await run<boolean>(`Boolean(__mc.item("lab-temporal"))`))) {
    await run(`__mc.click(__mc.button("Add connection"))`);
    await until(`__mc.field("Name")`, "the profile sheet");
    await run(`__mc.type(__mc.field("Name"), "lab-temporal")`);
    await run(`__mc.type(__mc.field("Namespace"), "lab")`);
    await run(`__mc.click(__mc.button("Save"))`);
    await until(`__mc.item("lab-temporal")`, "the saved profile");
  }
  const auto = await run<boolean>(
    `new Promise((resolve) => { const start = Date.now(); const tick = () => (__mc.item("Workers") ? resolve(true) : Date.now() - start > 4000 ? resolve(false) : setTimeout(tick, 100)); tick(); })`,
  );
  if (!auto) await run(`__mc.dblclick(__mc.item("lab-temporal"))`);
  await until(`__mc.item("Workers")`, "temporal.connect and the resource tree");
}

export default {
  id: "temporal-more",
  task: "TSK-92",
  title: "Temporal additions",
  builtWhen: "apps/mightyconsole/server/src/tools/temporal/workers.rs",
  lab: ["temporal"],
  items: [
    {
      id: "namespaces",
      text: "Namespaces: the lab's default and lab with retention and the selected one's search attributes; its buttons open Workflows, Workers and Schedules of that namespace.",
      lab: true,
      checks: [
        ...lab("a_namespace_is_described_with_its_settings_and_capabilities"),
        ...unit("only_the_capabilities_that_are_on_are_named"),
        vitest("test/temporal-namespaces-workers.test.tsx"),
        browser("the Namespaces tab with the lab namespace's settings and search attributes", async (ctx) => {
          const { run, until, shot } = ctx;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Namespaces"))`);
          await until(`__mc.has("Search attributes") && __mc.has("History archival") && __mc.has("default")`, "the namespaces and the lab's pane");
          await shot("namespaces");
        }),
      ],
    },
    {
      id: "workers",
      text: "Workers: the lab worker's identity on its task queues with what it polls for and its last poll; a typed task queue with no worker says so.",
      lab: true,
      checks: [
        ...lab("the_lab_worker_is_listed_on_its_task_queue_with_both_kinds"),
        ...unit("a_worker_on_both_kinds_is_one_row_with_its_latest_poll", "the_build_id_comes_from_the_deployment_options"),
        browser("the Workers tab lists the lab worker", async (ctx) => {
          const { run, until, shot } = ctx;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Workers"))`);
          await until(`__mc.has("Workflow, activity") && __mc.has("polling")`, "the lab worker on its queue");
          await shot("workers");
        }),
      ],
    },
    {
      id: "start-workflow",
      text: "Start workflow: a run started from the sheet appears in the list, the toast opens it; Copy as CLI command gives a command that starts the same workflow; Start another like this prefills the input.",
      lab: true,
      checks: [
        ...lab("a_started_workflow_runs_on_the_lab_worker_with_its_input_and_memo"),
        ...unit("durations_read_as_people_write_them_and_round_trip", "retry_policies_check_their_numbers_and_round_trip", "arguments_memo_and_attributes_become_json_payloads"),
        vitest("test/temporal-write-sheets.test.tsx"),
        vitest("test/temporal-schedule-preview.test.ts"),
        browser("a workflow started from the sheet, opened from the toast, and started again like this", async (ctx) => {
          const { run, until, shot } = ctx;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Workflows"))`);
          await until(`__mc.button("Start workflow")`, "the Workflows header");
          await run(`__mc.click(__mc.button("Start workflow"))`);
          await until(`__mc.field("Workflow type")`, "the Start workflow sheet");
          const id = `acceptance-start-${Date.now()}`;
          await run(`__mc.type(__mc.field("Workflow type"), "Completed")`);
          await run(`__mc.type(__mc.field("Task queue"), "lab")`);
          await run(`__mc.type(__mc.field("Workflow ID"), ${JSON.stringify(id)})`);
          await until(`__mc.has("polling")`, "the queue's workers");
          await shot("start-workflow-sheet");
          await run(`__mc.click(document.querySelector('button[form="start-workflow"]'))`);
          await until(`__mc.has(${JSON.stringify(`Started ${id}`)}) && __mc.button("Open workflow")`, "the toast with Open workflow");
          await shot("start-workflow-toast");
          await run(`__mc.click(__mc.button("Open workflow"))`);
          await until(`__mc.button("Start another like this") && !__mc.button("Start another like this").disabled`, "the started run's tab");
          await run(`__mc.click(__mc.button("Start another like this"))`);
          await until(`__mc.field("Workflow type") && __mc.field("Workflow type").value === "Completed" && __mc.field("Task queue").value === "lab"`, "the sheet filled from the run");
          await shot("start-another-like-this");
        }),
      ],
    },
    {
      id: "schedule-edit",
      text: "Schedules: create one with a calendar spec and see the same next runs the server reports; edit it (the changes listed first) and see the update; a cron and an interval schedule too.",
      lab: true,
      checks: [
        ...lab("a_schedule_is_created_described_as_its_form_and_updated_with_its_token", "a_cron_schedule_is_created_and_reads_back"),
        ...unit("ranges_read_as_calendar_strings", "a_form_round_trips_through_the_proto", "update_keeps_what_the_form_does_not_show", "a_form_without_a_spec_or_with_encoded_input_is_invalid"),
        vitest("test/temporal-schedule-preview.test.ts"),
        vitest("test/temporal-write-sheets.test.tsx"),
        browser("a calendar schedule whose browser runs match the server's, then edited with its changes listed", async (ctx) => {
          const { run, until, shot } = ctx;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Schedules"))`);
          await until(`__mc.button("Create schedule")`, "the Schedules header");
          await run(`__mc.click(__mc.button("Create schedule"))`);
          await until(`__mc.field("Schedule ID")`, "the schedule sheet");
          const id = `acceptance-schedule-${Date.now()}`;
          for (const [label, value] of [["Schedule ID", id], ["Time zone", "Europe/Berlin"], ["Hour", "3"], ["Minute", "15"], ["Workflow type", "Completed"], ["Task queue", "lab"], ["Workflow ID", "acceptance-scheduled"]]) {
            await run(`__mc.type(__mc.field(${JSON.stringify(label)}), ${JSON.stringify(value)})`);
          }
          await until(`document.querySelectorAll('[aria-label="Next runs"] li').length === 5`, "the next runs in the browser");
          const browserRuns = await run<string[]>(`[...document.querySelectorAll('[aria-label="Next runs"] li')].map((li) => li.dataset.at)`);
          await shot("schedule-create");
          await run(`__mc.click(document.querySelector('button[form="schedule-form"]'))`);
          await until(`document.querySelectorAll('[aria-label="Upcoming runs"] li').length > 0`, "the created schedule's tab");
          const serverRuns = await run<string[]>(`[...document.querySelectorAll('[aria-label="Upcoming runs"] li')].map((li) => li.dataset.at)`);
          const same = serverRuns.every((t, i) => browserRuns[i] !== undefined && Date.parse(t) === Date.parse(browserRuns[i]!));
          if (!same) throw new Error(`the browser computed ${browserRuns.join(", ")}; the server reports ${serverRuns.join(", ")}`);
          await shot("schedule-server-runs");
          await run(`__mc.click(__mc.button("Edit"))`);
          await until(`__mc.field("Hour") && __mc.field("Hour").value === "3"`, "the edit sheet filled from the schedule");
          await run(`__mc.type(__mc.field("Hour"), "4")`);
          await run(`__mc.click(__mc.button("Review changes"))`);
          await until(`__mc.has("1 change to send")`, "the changes listed first");
          await shot("schedule-edit-changes");
          await run(`__mc.click(__mc.button("Update schedule"))`);
          await until(`__mc.has(${JSON.stringify(`Updated ${id}`)})`, "the update");
          await shot("schedule-updated");
        }),
      ],
    },
    { id: "activities", text: "Standalone activities: listed, run from the sheet (the lab worker completes it), described with input and result, cancelled and terminated; a server without them shows the reason.", lab: true, checks: [] },
    { id: "codec", text: "Codec server: the encrypted payloads of the lab's codec workflow show decoded and labelled; with the codec stopped they show as stored with the reason; inputs sent with Encode inputs arrive encoded; Test codec reports the sample.", lab: true, checks: [] },
    {
      id: "large-payloads",
      text: "Large payloads: a stub for the lab's large input; the payload tab loads nodes, pages a large array, runs jq on the server, shows the size breakdown and limits, downloads both forms; History has the Size column; CI green.",
      lab: true,
      checks: [],
    },
  ],
} satisfies Checklist;
