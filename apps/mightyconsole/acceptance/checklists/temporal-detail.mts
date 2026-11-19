// TSK-104, Temporal relations and schedule detail (Mightyconsole spec section 18, Open question
// 45 (r)): a workflow's Relations (its family in the lab: family-root, family-order with three
// children, one failed, and family-support signalling the order) and the schedule detail tab,
// against the lab. Each batch of the task wires its item.
import { browser, cargo, type Checklist, vitest } from "../checklist.mts";
import { connectLab, shownButton } from "./temporal-more.mts";

/** One cargo check per test function, against the lab. */
const lab = (...names: string[]) => names.map((name) => cargo(name, { features: ["lab-tests"] }));
/** One cargo check per test function that needs no lab. */
const unit = (...names: string[]) => names.map((name) => cargo(name));

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
          await run(`__mc.dblclick(__mc.item("Workflows"))`);
          await until(`__mc.has("family-order")`, "the workflow list");
          await run(`__mc.click([...document.querySelectorAll("button")].find((b) => b.checkVisibility() && b.textContent.trim() === "family-order"))`);
          const relationsTab = `[...document.querySelectorAll("[role=tab]")].find((t) => t.checkVisibility() && /^Relations( \\d+)?$/.test(t.textContent.trim()))`;
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
      checks: [],
    },
  ],
} satisfies Checklist;
