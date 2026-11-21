// TSK-92, the Temporal additions (Mightyconsole spec section 18, "TSK-92, Temporal additions",
// Open question 45 (h), (k), (l)): namespaces, workers, start workflow, schedule create and edit,
// standalone activities, the codec server and large payloads, against the lab. Each batch of the
// task wires its items; an item with no check yet is reported as not wired.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browser, cargo, type Checklist, vitest } from "../checklist.mts";
import { typeInEditor } from "../editors.mts";

/** One cargo check per test function, against the lab. */
const lab = (...names: string[]) => names.map((name) => cargo(name, { features: ["lab-tests"] }));
/** One cargo check per test function that needs no lab. */
const unit = (...names: string[]) => names.map((name) => cargo(name));

type Ctx = Parameters<Parameters<typeof browser>[1]>[0];

// Tabs stay mounted when another is shown, so the walks look only at what is visible: a button
// on the shown tab, a field in the open sheet's form, the list of the shown schedule.
/** A visible button by its text or accessible name (an expression for `run` and `until`). */
export const shownButton = (label: string) => `[...document.querySelectorAll("button")].find((b) => b.checkVisibility() && (b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)}))`;
/** The control of a label inside the form `formId` (the open sheet). */
const sheetField = (formId: string, label: string) => `(() => { const f = document.getElementById(${JSON.stringify(formId)}); const l = f && [...f.querySelectorAll("label")].find((x) => x.textContent.replace("*", "").trim() === ${JSON.stringify(label)}); return l ? (l.control || document.getElementById(l.htmlFor)) : null; })()`;
/** The `data-at` instants of the visible list labelled `label`. */
const shownRuns = (label: string) => `[...document.querySelectorAll('[aria-label="${label}"]')].filter((l) => l.checkVisibility()).flatMap((l) => [...l.querySelectorAll("li")].map((li) => li.dataset.at))`;
const sw = (label: string) => sheetField("start-workflow", label);
const sc = (label: string) => sheetField("schedule-form", label);
const ra = (label: string) => sheetField("run-activity", label);

/** Opens the page and connects the lab's Temporal profile (made by the TSK-83 checklist or here). */
export async function connectLab({ page, origin, until, run }: Ctx): Promise<void> {
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

/** The lab's Temporal image: its `temporal` CLI calls the codec endpoint as a person would. */
const TEMPORAL_IMAGE = "temporalio/temporal:1.10.1@sha256:b228dadf9cdb6c7c02a1394b89dd76f827aac9760e458fce42f0899a10141225";
/**
 * The `temporal` CLI of the lab's image, copied out once (a static Go binary): it runs on this
 * machine, where the server's loopback codec listener is (a container's host network may not be).
 */
function temporalCli(): string {
  const path = join(tmpdir(), "mightyconsole-acceptance-temporal-1.10.1");
  if (!existsSync(path)) {
    const id = execFileSync("docker", ["create", TEMPORAL_IMAGE], { encoding: "utf8" }).trim();
    try {
      execFileSync("docker", ["cp", `${id}:/usr/local/bin/temporal`, path]);
    } finally {
      execFileSync("docker", ["rm", id]);
    }
  }
  return path;
}
/**
 * A row of the resource tree under the profile `profile` (the tree is flat: its rows follow the
 * profile's row at a deeper aria-level). `__mc.item` takes the first row anywhere, so with another
 * profile connected and open (lab-temporal, from the earlier walks) it found that profile's
 * Workers and Workflows instead, and the walk opened a list without its workflow.
 */
const itemOf = (profile: string, label: string) =>
  `(() => { const text = (el) => (el.textContent || "").replace(/\\s+/g, " ").trim(); const rows = [...document.querySelectorAll("[role=treeitem]")]; const i = rows.findIndex((r) => text(r).startsWith(${JSON.stringify(profile)})); if (i < 0) return undefined; const level = Number(rows[i].getAttribute("aria-level")); for (const r of rows.slice(i + 1)) { if (Number(r.getAttribute("aria-level")) <= level) return undefined; if (text(r).startsWith(${JSON.stringify(label)})) return r; } return undefined; })()`;
/** A switch by the text of its label. */
const switchOf = (label: string) => `[...document.querySelectorAll("label")].find((l) => l.checkVisibility() && l.textContent.trim() === ${JSON.stringify(label)})?.querySelector("[role=switch]")`;
/** A field of the profile sheet by its label (the sheet's own form). */
const profileField = (label: string) => `(() => { const l = [...document.querySelectorAll("label")].find((x) => x.checkVisibility() && x.textContent.replace("*", "").trim() === ${JSON.stringify(label)}); return l ? (l.control || document.getElementById(l.htmlFor) || l.parentElement?.querySelector("input, textarea")) : null; })()`;

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
          await until(shownButton("Start workflow"), "the Workflows header");
          await run(`__mc.click(${shownButton("Start workflow")})`);
          await until(sw("Workflow type"), "the Start workflow sheet");
          const id = `acceptance-start-${Date.now()}`;
          await run(`__mc.type(${sw("Workflow type")}, "Completed")`);
          await run(`__mc.type(${sw("Task queue")}, "lab")`);
          await run(`__mc.type(${sw("Workflow ID")}, ${JSON.stringify(id)})`);
          await until(`document.getElementById("start-workflow").textContent.includes("polling")`, "the queue's workers");
          await shot("start-workflow-sheet");
          await run(`__mc.click(document.querySelector('button[form="start-workflow"]'))`);
          await until(`__mc.has(${JSON.stringify(`Started ${id}`)}) && ${shownButton("Open workflow")}`, "the toast with Open workflow");
          await shot("start-workflow-toast");
          await run(`__mc.click(${shownButton("Open workflow")})`);
          // "Start another like this" is in the run's overflow menu (the mockup's place for it).
          await until(`__mc.has(${JSON.stringify(id)}) && ${shownButton("More actions")} && !${shownButton("More actions")}.disabled`, "the started run's tab");
          await run(`__mc.click(${shownButton("More actions")})`);
          const item = `[...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.includes("Start another like this"))`;
          await until(item, "the overflow menu");
          await run(`__mc.click(${item})`);
          await until(`${sw("Workflow type")}?.value === "Completed" && ${sw("Task queue")}?.value === "lab"`, "the sheet filled from the run");
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
          await until(shownButton("Create schedule"), "the Schedules header");
          await run(`__mc.click(${shownButton("Create schedule")})`);
          await until(sc("Schedule ID"), "the schedule sheet");
          const id = `acceptance-schedule-${Date.now()}`;
          for (const [label, value] of [["Schedule ID", id], ["Time zone", "Europe/Berlin"], ["Hour", "3"], ["Minute", "15"], ["Workflow type", "Completed"], ["Task queue", "lab"], ["Workflow ID", "acceptance-scheduled"]]) {
            await run(`__mc.type(${sc(label!)}, ${JSON.stringify(value)})`);
          }
          await until(`${shownRuns("Next runs")}.length === 5`, "the next runs in the browser");
          const browserRuns = await run<string[]>(shownRuns("Next runs"));
          await shot("schedule-create");
          await run(`__mc.click(document.querySelector('button[form="schedule-form"]'))`);
          await until(`__mc.has(${JSON.stringify(id)}) && ${shownRuns("Upcoming runs")}.length > 0`, "the created schedule's tab");
          const serverRuns = await run<string[]>(shownRuns("Upcoming runs"));
          // The server lists up to 10; the first 5 are the ones the browser computed.
          const same = browserRuns.every((t, i) => serverRuns[i] !== undefined && Date.parse(t) === Date.parse(serverRuns[i]!));
          if (!same) throw new Error(`the browser computed ${browserRuns.join(", ")}; the server reports ${serverRuns.join(", ")}`);
          await shot("schedule-server-runs");
          await run(`__mc.click(${shownButton("Edit")})`);
          await until(`${sc("Hour")}?.value === "3"`, "the edit sheet filled from the schedule");
          await run(`__mc.type(${sc("Hour")}, "4")`);
          await run(`__mc.click(${shownButton("Review changes")})`);
          await until(`__mc.has("1 change to send")`, "the changes listed first");
          await shot("schedule-edit-changes");
          await run(`__mc.click(${shownButton("Update schedule")})`);
          await until(`__mc.has(${JSON.stringify(`Updated ${id}`)})`, "the update");
          await shot("schedule-updated");
        }),
      ],
    },
    {
      id: "external-storage",
      text: "External Storage on S3 (TSK-103): the lab worker's 300 KiB payloads (SDK S3 driver, SeaweedFS) read back in Mightyconsole with the profile's keys; large inputs stored when the keys may write and refused with read-only keys; the codec endpoint serves the Web UI's origin and the temporal CLI (decode and encode), refuses other origins, asks Temporal per namespace, and stops with the connection.",
      lab: true,
      checks: [
        ...lab(
          "a_stored_input_is_read_back_with_the_profiles_credentials",
          "without_external_storage_the_reference_says_where_it_is",
          "a_large_input_is_stored_outside_and_the_worker_reads_it",
          "read_only_credentials_cannot_store_an_input",
          "decode_swaps_a_reference_for_the_stored_payload",
          "encode_stores_a_large_payload_and_decode_reads_it_back",
          "browsers_need_an_allowed_origin_and_every_call_a_namespace",
          "the_profile_is_served_only_while_connected",
        ),
        ...unit("signs_as_aws_does", "a_reference_round_trips", "the_legacy_form_and_snake_case_are_read", "the_wire_form_round_trips"),
        vitest("test/temporal.test.ts", "External Storage"),
        vitest("test/temporal.test.ts", "codec endpoint"),
        browser("a profile with External Storage and the codec endpoint; the temporal CLI decodes through it", async ({ page, origin, codecOrigin, until, run, shot, lab: creds }) => {
          const s3 = (creds as { temporal?: { externalStorage?: Record<string, string> } } | null)?.temporal?.externalStorage;
          if (!s3) throw new Error("lab/.generated/credentials.json has no temporal.externalStorage: run `lab up temporal`");
          await page.navigate(`${origin}/`);
          await until(`__mc.button("Temporal")`, "the tool rail");
          await run(`__mc.click(__mc.button("Temporal"))`);
          await until(`__mc.button("Add connection")`, "the connection list");
          await run(`__mc.click(__mc.button("Add connection"))`);
          await until(`__mc.field("Name")`, "the profile sheet");
          await run(`__mc.type(__mc.field("Name"), "lab-s3")`);
          await run(`__mc.type(__mc.field("Namespace"), "lab")`);
          await run(`__mc.click(${switchOf("External Storage on S3")})`);
          await until(profileField("Bucket"), "the External Storage fields");
          await run(`__mc.type(${profileField("Bucket")}, ${JSON.stringify(s3["bucket"])})`);
          await run(`__mc.type(${profileField("Endpoint")}, ${JSON.stringify(s3["endpoint"])})`);
          await run(`__mc.click(${switchOf("Path-style addressing")})`);
          await run(`__mc.type(${profileField("Access key ID")}, ${JSON.stringify(s3["accessKeyId"])})`);
          await run(`__mc.type(${profileField("Secret access key")}, ${JSON.stringify(s3["secretAccessKey"])})`);
          await run(`__mc.click(${switchOf("Serve as a codec endpoint")})`);
          await shot("profile-external-storage");
          await run(`__mc.click(__mc.button("Save"))`);
          await until(`__mc.item("lab-s3")`, "the saved profile");
          await run(`__mc.dblclick(__mc.item("lab-s3"))`);
          await until(itemOf("lab-s3", "Workers"), "temporal.connect with External Storage");
          // Mightyconsole reads the stored input with the profile's keys.
          await run(`__mc.dblclick(${itemOf("lab-s3", "Workflows")})`);
          await until(`__mc.has("big-payload-1")`, "the workflow list");
          await run(`__mc.click([...document.querySelectorAll("button")].find((b) => b.checkVisibility() && b.textContent.trim() === "big-payload-1"))`);
          await until(`[...document.querySelectorAll("[role=tab]")].some((t) => t.checkVisibility() && t.textContent.trim() === "Input and result")`, "the workflow tab");
          await run(`(() => { const t = [...document.querySelectorAll("[role=tab]")].find((x) => x.checkVisibility() && x.textContent.trim() === "Input and result"); for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) t.dispatchEvent(new (k.startsWith("pointer") ? PointerEvent : MouseEvent)(k, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); })()`);
          await until(`document.body.innerText.includes("received")`, "the decoded result (received, echo)");
          await shot("input-and-result");
          // The profile's id, from the browser's store: the endpoint's path names it.
          const id = await run<string>(`new Promise((resolve, reject) => { const open = indexedDB.open("mightyconsole"); open.onerror = () => reject(open.error); open.onsuccess = () => { const all = open.result.transaction("profiles").objectStore("profiles").getAll(); all.onsuccess = () => resolve(all.result.find((p) => p.name === "lab-s3").id); }; })`);
          const endpoint = `${codecOrigin}/codec/${id}`;
          const binary = temporalCli();
          const cli = (args: string[]) => execFileSync(binary, [...args, "--address", "127.0.0.1:7233", "--namespace", "lab", "--codec-endpoint", endpoint], { encoding: "utf8", timeout: 120_000 });
          const shown = cli(["workflow", "show", "--workflow-id", "big-payload-1", "--detailed"]);
          if (!shown.includes("big") || !shown.includes("input xxxx")) throw new Error(`the CLI did not show the decoded input:\n${shown.slice(0, 2000)}`);
          // Encode: a 300 KiB input started from the CLI goes through the endpoint, the worker reads it.
          const wid = `acceptance-codec-${Date.now()}`;
          const inputFile = join(mkdtempSync(join(tmpdir(), "codec-input-")), "input.json");
          writeFileSync(inputFile, JSON.stringify({ text: "c".repeat(300 * 1024) }));
          cli(["workflow", "start", "--type", "BigPayload", "--task-queue", "lab", "--workflow-id", wid, "--input-file", inputFile]);
          const result = cli(["workflow", "result", "--workflow-id", wid]);
          if (!result.includes(String(300 * 1024))) throw new Error(`the worker did not read the CLI's stored input:\n${result.slice(0, 2000)}`);
        }),
      ],
    },
    {
      id: "activities",
      text: "Standalone activities: listed, run from the sheet (the lab worker completes it), described with input and result, cancelled and terminated; a server without them shows the reason.",
      lab: true,
      checks: [
        ...lab(
          "the_lab_server_runs_them",
          "one_is_run_listed_counted_and_described_with_its_input_and_result",
          "a_failing_one_shows_its_failure_and_why_it_stopped",
          "a_running_one_is_cancelled_through_its_heartbeat",
          "terminate_needs_a_reason_and_ends_it_at_once",
          "a_start_needs_one_of_the_close_timeouts_and_a_used_id_conflicts",
        ),
        ...unit("a_server_without_them_says_so_and_what_they_need", "decoded_payloads_read_as_values"),
        vitest("test/temporal-activities.test.tsx"),
        browser("the Activities tab, an activity run from the sheet, opened from the toast with its result", async (ctx) => {
          const { run, until, shot } = ctx;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Activities"))`);
          await until(`__mc.has("sa-charge-1") && ${shownButton("Run activity")}`, "the seeded standalone activity");
          await shot("activities");
          await run(`__mc.click(${shownButton("Run activity")})`);
          await until(ra("Activity type"), "the Run activity sheet");
          const id = `acceptance-activity-${Date.now()}`;
          await run(`__mc.type(${ra("Activity type")}, "charge")`);
          await run(`__mc.type(${ra("Task queue")}, "lab")`);
          await run(`__mc.type(${ra("Activity ID")}, ${JSON.stringify(id)})`);
          await typeInEditor(ctx, "Input", '["ord-walk"]');
          await until(`document.getElementById("run-activity").textContent.includes("for activities")`, "the queue's activity workers");
          await shot("run-activity-sheet");
          await run(`__mc.click(document.querySelector('button[form="run-activity"]'))`);
          await until(`__mc.has(${JSON.stringify(`Started ${id}`)}) && ${shownButton("Open activity")}`, "the toast with Open activity");
          await run(`__mc.click(${shownButton("Open activity")})`);
          await until(`__mc.has("charged ord-walk")`, "the activity's result", 30_000);
          await shot("activity-detail");
        }),
      ],
    },
    {
      id: "codec",
      text: "Codec server: the encrypted payloads of the lab's codec workflow show decoded and labelled; with the codec stopped they show as stored with the reason; inputs sent with Encode inputs arrive encoded; Test codec reports the sample.",
      lab: true,
      checks: [
        ...lab(
          "encrypted_payloads_are_decoded_through_the_codec_and_labelled",
          "without_the_codec_they_show_as_stored",
          "a_refusing_codec_leaves_them_as_stored_and_says_why",
          "inputs_are_encoded_and_the_worker_reads_them",
          "an_encode_failure_fails_the_action",
          "test_codec_reports_the_sample",
        ),
        ...unit("endpoints_are_https_or_loopback_http", "an_https_codec_needs_its_ca", "plain_payloads_are_collected_but_errors_skip_them"),
        vitest("test/temporal.test.ts", "payload codec"),
        browser("a profile with the lab's codec: Test codec, then encrypted-1 decoded", async ({ page, origin, until, run, shot, lab: creds }) => {
          const codec = (creds as { temporal?: { codec?: Record<string, string> } } | null)?.temporal?.codec;
          if (!codec) throw new Error("lab/.generated/credentials.json has no temporal.codec: run `lab up temporal`");
          await page.navigate(`${origin}/`);
          await until(`__mc.button("Temporal")`, "the tool rail");
          await run(`__mc.click(__mc.button("Temporal"))`);
          await until(`__mc.button("Add connection")`, "the connection list");
          await run(`__mc.click(__mc.button("Add connection"))`);
          await until(`__mc.field("Name")`, "the profile sheet");
          await run(`__mc.type(__mc.field("Name"), "lab-codec")`);
          await run(`__mc.type(__mc.field("Namespace"), "lab")`);
          await run(`__mc.click([...document.querySelectorAll("label")].find((l) => l.checkVisibility() && l.textContent.trim() === "Codec server")?.querySelector("button, [role=radio]"))`);
          await until(profileField("Authorization header"), "the codec fields");
          await run(`__mc.type(${profileField("Endpoint")}, ${JSON.stringify(codec["endpoint"])})`);
          await run(`__mc.type(${profileField("Authorization header")}, ${JSON.stringify(codec["authorization"])})`);
          await run(`__mc.click(__mc.button("Test codec"))`);
          await until(`__mc.has("Codec answered")`, "Test codec's report", 30_000);
          await shot("test-codec");
          await run(`__mc.click(__mc.button("Save"))`);
          await until(`__mc.item("lab-codec")`, "the saved profile");
          await run(`__mc.dblclick(__mc.item("lab-codec"))`);
          await until(itemOf("lab-codec", "Workers"), "temporal.connect with the codec");
          await run(`__mc.dblclick(${itemOf("lab-codec", "Workflows")})`);
          try {
            await until(`__mc.has("encrypted-1")`, "the workflow list");
          } catch (e) {
            // Say what the list shows instead (which profile's tab, which workflows, any error).
            await shot("workflow-list-without-encrypted-1");
            const seen = await run<string>(`location.pathname + " · " + [...document.querySelectorAll("[role=tabpanel]:not([hidden])")].map((p) => p.innerText.replace(/\\s+/g, " ").slice(0, 600)).join(" | ")`);
            throw new Error(`${(e as Error).message}; the page shows: ${seen}`);
          }
          await run(`__mc.click([...document.querySelectorAll("button")].find((b) => b.checkVisibility() && b.textContent.trim() === "encrypted-1"))`);
          await until(`[...document.querySelectorAll("[role=tab]")].some((t) => t.checkVisibility() && t.textContent.trim() === "Input and result")`, "the workflow tab");
          await run(`(() => { const t = [...document.querySelectorAll("[role=tab]")].find((x) => x.checkVisibility() && x.textContent.trim() === "Input and result"); for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) t.dispatchEvent(new (k.startsWith("pointer") ? PointerEvent : MouseEvent)(k, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); })()`);
          await until(`document.body.innerText.includes("4111111111111111")`, "the decrypted input");
          await shot("encrypted-input-decoded");
        }),
      ],
    },
    {
      id: "large-payloads",
      text: "Large payloads: a stub for the lab's large input; the payload tab loads nodes, pages a large array, runs jq on the server, shows the size breakdown and limits, downloads both forms; History has the Size column; CI green.",
      lab: true,
      checks: [],
    },
  ],
} satisfies Checklist;
