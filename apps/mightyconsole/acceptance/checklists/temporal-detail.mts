// TSK-104, Temporal relations and schedule detail (Mightyconsole spec section 18, Open question
// 45 (r)): a workflow's Relations (its family in the lab: family-root, family-order with three
// children, one failed, and family-support signalling the order) and the schedule detail tab,
// against the lab. Each batch of the task wires its item.
import { browser, cargo, type Checklist, vitest, confirmDestroy } from "../checklist.mts";
import { connectLab, openSeededWorkflow, shownButton } from "./temporal-more.mts";

/** One cargo check per test function, against the lab. */
const lab = (...names: string[]) => names.map((name) => cargo(name, { features: ["lab-tests"] }));
/** One cargo check per test function that needs no lab. */
const unit = (...names: string[]) => names.map((name) => cargo(name));
/** A field of the schedule sheet by its label. */
const sc = (label: string) => `(() => { const f = document.getElementById("schedule-form"); const l = f && [...f.querySelectorAll("label")].find((x) => x.textContent.replace("*", "").trim() === ${JSON.stringify(label)}); return l ? (l.control || document.getElementById(l.htmlFor)) : null; })()`;
/** A button of the open dialog by its text. */
const dialogButton = (label: string) => `[...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
/** An item of the open menu by its text. */
const menuItem = (label: string) => `[...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.includes(${JSON.stringify(label)}))`;

export default {
  id: "temporal-detail",
  task: "TSK-104",
  title: "Temporal relations and schedule detail",
  builtWhen: "apps/mightyconsole/server/src/tools/temporal/relations.rs",
  lab: ["temporal"],
  items: [
    {
      id: "relations",
      text: "Relations (TSK-104): the lab's family (a root, the order workflow with three children, one failed, and a support workflow that signals it) drawn from the order workflow as Whole family and as Direct only, with the parent, the children's statuses, the signal received and the runs; double-click opens a child.",
      lab: true,
      checks: [
        ...lab("the_order_sees_its_parent_children_and_the_signal", "the_whole_family_is_listed_from_the_root"),
        ...unit(
          "children_signals_and_runs_come_from_the_history",
          "a_reset_run_names_its_base",
          "the_family_is_drawn_by_whole_levels_with_the_path_to_the_current_one",
          "edges_go_parent_to_child_and_along_the_signals",
        ),
        vitest("test/temporal-relations.test.tsx"),
        browser("the order's Relations: the whole family, Direct only, and a child opened by double-click", async (ctx) => {
          const { run, until, shot } = ctx;
          await connectLab(ctx);
          await openSeededWorkflow(ctx, "lab-temporal", "family-order");
          const relationsTab = `[...document.querySelectorAll("[role=tab]")].find((t) => t.checkVisibility() && t.querySelector("[data-slot=tabs-label]")?.textContent.trim() === "Relations")`;
          await until(relationsTab, "the workflow tab");
          await run(`(() => { const t = ${relationsTab}; for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) t.dispatchEvent(new (k.startsWith("pointer") ? PointerEvent : MouseEvent)(k, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); })()`);
          const node = (id: string) => `[...document.querySelectorAll('[data-graph-node="${id}"]')].find((n) => n.checkVisibility())`;
          await until(`${node("family-order-receipt")} && ${node("family-root")} && ${node("family-support")} && __mc.has("Root family-root")`, "the whole family with the signal");
          await until(`${node("family-order-receipt")}.textContent.includes("Failed") && __mc.has("customerConfirmed")`, "the failed child and the signal");
          await shot("relations-family");
          await run(`__mc.click(${shownButton("Direct only")})`);
          await until(`__mc.has("1 parent · 3 children")`, "Direct only");
          await shot("relations-direct");
          await run(`${node("family-order-fraud")}.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
          await until(`[...document.querySelectorAll("h1, h2")].some((h) => h.checkVisibility() && h.textContent.includes("family-order-fraud"))`, "the child opened in a tab");
          await shot("relations-child-opened");
        }),
      ],
    },
    {
      id: "schedule-detail",
      text: "Schedule detail: Trigger now starts a run that appears in Runs; Pause with a note and Unpause; the next five times are the server's; Backfill over a past hour names the count it starts and the runs appear; Delete removes it; CI green.",
      lab: true,
      checks: [
        ...lab("the_next_times_are_the_servers_and_a_range_counts_its_runs", "trigger_and_backfill_runs_are_listed_with_their_scheduled_times", "a_future_backfill_is_refused"),
        ...unit("a_matched_time_without_a_run_is_skipped_with_its_reason", "runs_tokens_round_trip"),
        vitest("test/temporal-schedules.test.tsx"),
        browser("a schedule of the walk's own: triggered, paused with a note and unpaused, the backfill's count, deleted", async (ctx) => {
          const { run, until, shot } = ctx;
          await connectLab(ctx);
          await run(`__mc.dblclick(__mc.item("Schedules"))`);
          await until(shownButton("Create schedule"), "the Schedules header");
          await run(`__mc.click(${shownButton("Create schedule")})`);
          await until(sc("Schedule ID"), "the schedule sheet");
          const id = `acceptance-detail-${Date.now()}`;
          for (const [label, value] of [["Schedule ID", id], ["Time zone", "Europe/Berlin"], ["Hour", "2"], ["Minute", "0"], ["Workflow type", "Completed"], ["Task queue", "lab"], ["Workflow ID", id]]) {
            await run(`__mc.type(${sc(label!)}, ${JSON.stringify(value)})`);
          }
          await run(`__mc.click(document.querySelector('button[form="schedule-form"]'))`);
          await until(`__mc.has(${JSON.stringify(id)}) && __mc.has("Computed by the server") && __mc.has("TemporalScheduledById")`, "the schedule's tab", 45_000);
          // Trigger now: the run appears in Runs (from the recent actions until visibility has it).
          await run(`__mc.click(${shownButton("Trigger now")})`);
          await until(dialogButton("Trigger now"), "the trigger dialog");
          await run(`__mc.click(${dialogButton("Trigger now")})`);
          // 60 s: the tab follows Trigger now until the schedule counts the run, then reloads Runs
          // (TSK-132; before it, one reload could beat Temporal's count and show nothing). TSK-121: 2
          // timeouts at 20 s on a busy runner.
          await until(`!document.querySelector("[role=dialog]") && __mc.has(${JSON.stringify(`${id}-20`)})`, "the triggered run in Runs", 60_000);
          await shot("schedule-detail");
          // Pause with a note, then Unpause.
          await run(`__mc.click(${shownButton("Pause…")})`);
          await until(`document.querySelector("[role=dialog] input")`, "the pause dialog");
          await run(`__mc.type(document.querySelector("[role=dialog] input"), "paused by the acceptance walk")`);
          await run(`__mc.click(${dialogButton("Pause")})`);
          await until(`${shownButton("Unpause…")} && __mc.has("paused by the acceptance walk")`, "Paused with the note");
          await shot("schedule-paused");
          await run(`__mc.click(${shownButton("Unpause…")})`);
          await until(dialogButton("Unpause"), "the unpause dialog");
          await run(`__mc.click(${dialogButton("Unpause")})`);
          await until(shownButton("Pause…"), "Active again");
          // Backfill: the count the server matched (the walk does not start them: lab tests do).
          await run(`__mc.click(${shownButton("More actions")})`);
          await until(menuItem("Backfill"), "the menu");
          await run(`__mc.click(${menuItem("Backfill")})`);
          await until(`[...document.querySelectorAll("[role=dialog] [role=status]")].some((s) => /^Starts|nothing would start/.test(s.textContent))`, "the backfill's count");
          await shot("schedule-backfill");
          await run(`__mc.click(${dialogButton("Cancel")})`);
          await until(`!document.querySelector("[role=dialog]")`, "the dialog closed");
          await run(`__mc.click(${shownButton("More actions")})`);
          await until(menuItem("Delete"), "the menu");
          await run(`__mc.click(${menuItem("Delete")})`);
          await until(`document.querySelector("[role=dialog] input")`, "the delete dialog");
          await run(`__mc.type(document.querySelector("[role=dialog] input"), ${JSON.stringify(id)})`);
          await run(`__mc.click(${dialogButton("Delete schedule")})`);
          await confirmDestroy({ run, until }, "the schedule deletion");
          await until(`__mc.has(${JSON.stringify(`${id} was deleted`)})`, "the schedule deleted");
        }),
      ],
    },
  ],
} satisfies Checklist;
