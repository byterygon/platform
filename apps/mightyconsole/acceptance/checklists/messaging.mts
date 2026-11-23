// TSK-80, Messaging core (Mightyconsole spec section 18, against the lab). Batch 1 (crates/message-codecs)
// wired the crate, codecs, wire-format and local-schemas items; batch 2 (the server) the filter, Arrow,
// live tail and procedures; batch 3 the UI tests and a browser walk (the real server and UI in Chrome) before the task closes with
// `pnpm --filter @byterygon/mightyconsole acceptance messaging --lab-up --strict`.
import { browser, cargo, type Checklist, command, vitest } from "../checklist.mts";
import { editorArea, pasteInEditor } from "../editors.mts";

// A JSON message large enough to explore (TSK-113): 2,000 orders, about 130 KB, pasted.
const ORDERS = JSON.stringify(
  {
    page: 1,
    orders: Array.from({ length: 2000 }, (_, i) => ({ id: `ord-${String(i).padStart(5, "0")}`, status: ["paid", "open", "refunded"][i % 3], total: Math.round((10 + (i % 90) + i / 100) * 100) / 100, region: ["eu", "us", "apac"][i % 4 === 3 ? 0 : i % 3] })),
  },
  null,
  1,
);

// The crate's own tests (the harness's `cargo` checks run mightyconsole-server's).
const codecs = (label: string, ...args: string[]) =>
  command(label, ["cargo", "test", "-p", "message-codecs", "--locked", ...args]);

export default {
  id: "messaging",
  task: "TSK-80",
  title: "Messaging core",
  builtWhen: "crates/message-codecs",
  lab: ["kafka"],
  items: [
    {
      id: "crate",
      text: "crates/message-codecs is MIT OR Apache-2.0 and depends on nothing in apps/.",
      checks: [
        command("check-licenses", ["node", "scripts/check-licenses.mjs"]),
        command("cargo deny check licenses bans sources", ["cargo", "deny", "check", "licenses", "bans", "sources"], { requires: ["cargo-deny"] }),
      ],
    },
    {
      id: "codecs",
      text: "Every codec of 5.2 decodes and encodes with round-trip tests, including the edge cases (integers beyond 2^53, Avro unions, decimals and logical types, Protobuf canonical JSON, MessagePack binary and ext); auto-detect follows the order of 5.2 on a fixture set of ambiguous payloads.",
      checks: [
        codecs("every codec's unit tests (edge cases)", "--lib", "codec::"),
        codecs("auto-detect on ambiguous payloads", "--test", "codecs", "auto_detect_order_on_ambiguous_payloads"),
        codecs("every codec through the engine", "--test", "codecs", "every_codec_round_trips_through_the_engine"),
      ],
    },
    {
      id: "wire-format",
      text: "Confluent wire format for Avro, Protobuf (message indexes, imports through references) and JSON Schema works against the lab registry; the three naming strategies give the expected subjects.",
      lab: true,
      checks: [
        codecs("wire format through a fake registry", "--test", "codecs", "wire_format_through_a_registry"),
        command("against the lab registry", ["cargo", "test", "-p", "message-codecs", "--locked", "--test", "registry_lab"], {
          env: { MESSAGE_CODECS_REGISTRY_URL: "http://127.0.0.1:8081", BYTERYGON_REQUIRE_LAB: "1" },
        }),
        codecs("naming strategies", "--lib", "naming::"),
      ],
    },
    {
      id: "local-schemas",
      text: "Local schemas (Avro, several .proto files with imports, a descriptor set, JSON Schema) compile on the server; errors name the file and line.",
      checks: [
        codecs("local schemas and mappings", "--test", "codecs", "local_schemas_and_mappings"),
        codecs("a descriptor set", "--test", "codecs", "descriptor_set_local_schema"),
        codecs("errors with file and line", "--lib", "errors_name"),
      ],
    },
    {
      id: "filter",
      text: "The filter's parts each work; jq runs through jaq and its licence passes check-licenses and cargo deny; errors carry positions; maxScan ends a scan with the counts.",
      checks: [
        codecs("the filter's parts and jq", "--lib", "filter::"),
        cargo("a_filter_limit_and_max_scan_end_a_scan_with_counts"),
        cargo("the_messaging_procedures"),
        command("jaq's licence: check-licenses", ["node", "scripts/check-licenses.mjs"]),
        command("jaq's licence: cargo deny", ["cargo", "deny", "check", "licenses"], { requires: ["cargo-deny"] }),
      ],
    },
    {
      id: "arrow",
      text: "Messages travel as Arrow batches with the 5.1 schema, decode in the Worker and show in the data grid; a payload over 1 MiB is truncated with its full size.",
      checks: [
        cargo("a_batch_has_the_schema_of_5_1"),
        cargo("messages_travel_as_arrow_batches_and_a_large_payload_is_cut"),
        cargo("a_large_payload_is_cut_and_not_decoded"),
        vitest("test/messaging.test.tsx", "rows from the Arrow batches"),
        vitest("test/messaging.test.tsx", "a cut payload offers Load full payload"),
        // The same command as foundation's two browser-check items, so one run serves all three (TSK-121).
        command("the real server and UI in Chrome: the Arrow Worker decodes the tail into the data grid", ["node", "scripts/browser-check.ts"], {
          cwd: "apps/mightyconsole/ui",
          env: { MIGHTYCONSOLE_SERVER: "{server}", BYTERYGON_REQUIRE_BROWSER: "1", MIGHTYCONSOLE_FAILURE_SHOTS: "{evidence}/screenshots" },
        }),
      ],
    },
    {
      id: "live-tail",
      text: "Live tail on the test backend: pause stops a pull-able source from reading (credits counted), a push-only source drops oldest and reports it, rate and counters update, the view keeps its limit, Stop, Clear and Restart from lastPositions work.",
      checks: [
        cargo("pausing_stops_reading_and_a_push_source_drops_the_oldest"),
        cargo("a_filter_limit_and_max_scan_end_a_scan_with_counts", { label: "Restart from lastPositions" }),
        vitest("test/messaging.test.tsx", "the window keeps the newest messages"),
        vitest("test/messaging.test.tsx", "Pause stops pulling chunks"),
        vitest("test/messaging.test.tsx", "Restart after Stop continues"),
        command("the data grid's window, hold and clear", ["pnpm", "--filter", "@byterygon/data-grid", "exec", "vitest", "run", "test/window.test.tsx"]),
      ],
    },
    {
      id: "components",
      text: "MessageViewer, Composer and FilterBar work on the test backend; CodeEditor, HexView and KeyValueEditor are in packages/ui with manifests, examples, tests and registry items, synced into the app.",
      checks: [
        vitest("test/messaging.test.tsx", "quick fields build the filter"),
        vitest("test/messaging.test.tsx", "Validate shows the size and the first bytes"),
        vitest("test/messaging.test.tsx", "Enter in the payload sends"),
        vitest("test/messaging-shell.test.tsx"),
        command("CodeEditor, HexView and KeyValueEditor in packages/ui (behaviour and conventions)", ["pnpm", "--filter", "@byterygon/ui", "exec", "vitest", "run", "src/components/code-editor", "src/components/hex-view", "src/components/key-value-editor", "test/conventions.test.tsx"]),
        command("the registry is current", ["pnpm", "--filter", "@byterygon/ui", "registry:check"]),
        command("synced into the app", ["pnpm", "--filter", "@byterygon/mightyconsole", "sync:ui:check"]),
      ],
    },
    {
      id: "query",
      text: "TSK-113 (DOC-21 §5.4.1, §5.6): the Value tab's Query bar runs jq on the server (messaging.query) in a worker: results in the same view with their count, errors at their line and column, Snippets for the value's shape, recent programs per profile, Profile for an array of objects; refused builtins, the deadline, the output cap, a stack overflow and Cancel never hurt the server; the query and the filter agree.",
      checks: [
        codecs("message-codecs: refused builtins, the library, the worker's lines", "--lib", "--", "jq::"),
        cargo("a_program_that_never_ends_is_stopped_at_the_deadline"),
        cargo("results_stop_at_the_output_cap"),
        cargo("a_stack_overflow_ends_only_the_worker"),
        cargo("refused_builtins_and_errors_name_the_program_s_position"),
        cargo("a_third_run_waits_for_a_slot_and_then_fails_as_busy"),
        cargo("the_query_and_the_filter_agree"),
        cargo("a_jq_query_runs_in_a_worker_and_the_server_stays_responsive"),
        vitest("test/value-query.test.tsx"),
        browser("a 2,000-order message: group by a snippet, a program that never ends stopped at the time limit, the Profile", async (ctx) => {
          const { page, origin, until, run, shot } = ctx;
          await page.navigate(`${origin}/`);
          await until(`__mc.button("Echo")`, "the tool navigation");
          await run(`__mc.click(__mc.button("Echo"))`);
          await until(`__mc.has("No Echo connections yet") || __mc.item("acceptance")`, "the connection list");
          if (!(await run<boolean>(`Boolean(__mc.item("acceptance"))`))) {
            await run(`__mc.click(__mc.button("Add connection"))`);
            await until(`__mc.field("Name")`, "the profile sheet");
            await run(`__mc.type(__mc.field("Name"), "acceptance")`);
            await run(`__mc.click(__mc.button("Save"))`);
            await until(`__mc.item("acceptance")`, "the saved profile");
          }
          await run(`__mc.dblclick(__mc.item("acceptance"))`);
          await until(`__mc.item("Composer")`, "echo.connect and the resource tree");
          await run(`__mc.dblclick(__mc.item("Composer"))`);
          await pasteInEditor(ctx, "Payload", ORDERS);
          await run(`__mc.click([...document.querySelectorAll("[data-slot=composer] button")].find((b) => b.textContent.trim() === "Send"))`);
          await until(`__mc.has("Written to partition")`, "echo.messages.produce", 30_000);
          await run(`__mc.dblclick(__mc.item("Messages"))`);
          const toolbar = `document.querySelector('[role=toolbar][aria-label="records actions"]')`;
          await until(toolbar, "the Messages tab");
          await run(`__mc.click([...${toolbar}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Start"))`);
          // The orders message: the newest row (its payload's column is off to the side).
          const row = `[...document.querySelectorAll("[data-slot=message-viewer] .bdg-body [role=row]")].at(-1)?.querySelector("[role=gridcell]")`;
          await until(row, "the orders message in the list", 30_000);
          await run(`(() => { const c = ${row}; for (const t of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) c.dispatchEvent(new (t.startsWith("pointer") ? PointerEvent : MouseEvent)(t, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); return true; })()`);
          await until(`[...document.querySelectorAll("[data-slot=message-detail] [role=treeitem]")].some((r) => r.textContent.includes("orders"))`, "the orders message in the detail");
          const query = `[...document.querySelectorAll("[data-slot=message-detail] [data-slot=json-viewer-toolbar] button")].find((b) => b.textContent.trim() === "Query")`;
          await until(query, "the Query button in the value's toolbar");
          await run(`${query}.click()`);
          await until(`Boolean(${editorArea("jq program")})`, "the Query bar", 30_000);
          // Group by: the snippet selects the field in each place; typing replaces them all.
          await run(`__mc.click(__mc.button("Snippets"))`);
          await until(`[...document.querySelectorAll("[role=menuitem]")].some((m) => m.textContent.includes("Group by a field"))`, "the Snippets menu");
          await run(`[...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.includes("Group by a field")).click()`);
          await until(`${editorArea("jq program")}.closest(".monaco-editor").classList.contains("focused")`, "the snippet in the editor, focused");
          await page.send("Input.insertText", { text: "status" });
          await run(`__mc.click(__mc.button("Run"))`);
          await until(`[...document.querySelectorAll("[data-slot=value-explorer] [role=status]")].some((s) => /^1 result/.test(s.textContent))`, "the group by's result", 30_000);
          const grouped = await run<string>(`[...document.querySelectorAll("[data-slot=value-explorer] [role=status]")].map((s) => s.textContent).join(" ")`);
          if (!/1 result/.test(grouped)) throw new Error(`the group by gave: ${grouped}`);
          await shot("group by status");
          // A program that never ends: stopped at the time limit, and the server goes on answering.
          await pasteInEditor(ctx, "jq program", "def f: f; f");
          const started = Date.now();
          await run(`__mc.click(__mc.button("Run"))`);
          await until(`__mc.has("was stopped before its first result")`, "the runaway stopped", 15_000);
          const took = Date.now() - started;
          if (took > 10_000) throw new Error(`the runaway took ${took} ms to stop`);
          await shot("a program that never ends, stopped");
          await run(`__mc.click(__mc.button("Profile"))`);
          await until(`document.querySelector('table[aria-label="Profile of the fields"] tbody tr')`, "the Profile table", 30_000);
          await shot("profile of the orders");
        }),
      ],
    },
    {
      id: "procedures",
      text: "The messaging.* procedures of 5.8 exist; CI green.",
      checks: [
        cargo("the_procedures_of_the_spec"),
        cargo("the_messaging_procedures"),
      ],
    },
  ],
} satisfies Checklist;
