// TSK-85, NATS (Mightyconsole spec section 18, against the lab's NATS servers). The server's
// checks: the unit tests of tools/nats and tests/nats_lab.rs (feature lab-tests) against the lab
// (password, nkey, no-auth default user, TLS, a token server and an operator-mode server for
// .creds). The UI's: test/nats.test.tsx (jsdom), and a walk through the tool in a browser with
// screenshots. Each TSK-85 batch wires its items; run
// `pnpm --filter @byterygon/mightyconsole acceptance nats --lab-up --strict --only connect,core,streams,consumers,kv-objects,services`
// until every item is wired.
import { browser, type BrowserContext, cargo, type Checklist, vitest } from "../checklist.mts";

const lab = (filter: string) => cargo(filter, { features: ["lab-tests"] });

/** Opens the NATS tool and the lab profile's tree, adding the profile first when this browser has
 * none (the defaults reach the lab's main server, whose no-auth user is the password user). */
async function labTree({ until, run, shot }: Pick<BrowserContext, "until" | "run" | "shot">): Promise<void> {
  await until(`__mc.button("NATS")`, "the tool list");
  await run(`__mc.click(__mc.button("NATS"))`);
  await until(`__mc.has("No NATS connections yet") || __mc.item("lab")`, "the NATS connection list");
  if (!(await run<boolean>(`Boolean(__mc.item("lab"))`))) {
    await run(`__mc.click(__mc.button("Add connection"))`);
    await until(`__mc.field("Name")`, "the profile sheet");
    await shot("profile sheet");
    await run(`__mc.type(__mc.field("Name"), "lab")`);
    await run(`__mc.click(__mc.button("Save"))`);
    await until(`__mc.item("lab")`, "the saved profile");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await until(`__mc.item("Server")`, "the resource tree", 4_000);
      return;
    } catch {
      await run(`__mc.dblclick(__mc.item("lab"))`);
    }
  }
  await until(`__mc.item("Server")`, "the resource tree");
}

/** A field of the Publish form by its label (other tabs, such as Subscribe's filter bar, have a
 * "Subject" field too). */
const pubField = (label: string) => `(() => { const l = [...document.querySelectorAll("[data-slot=composer] label")].find((x) => (x.textContent || "").trim() === ${JSON.stringify(label)}); return l && (l.control || document.getElementById(l.htmlFor)); })()`;
/** The Publish form's Send button. */
const send = `document.querySelector("[data-slot=composer] button[type=submit]")`;

/** A tab of the tab strip by its title. */
const tab = (title: string) => `[...document.querySelectorAll("[role=tab]")].find((t) => (t.textContent || "").includes(${JSON.stringify(title)}))`;

/** Text of an element, as the helpers read it. */
const TEXT = `((el) => (el.textContent || "").replace(/\\s+/g, " ").trim())`;
/** A button shown on screen (tabs stay mounted, so a hidden one may come first). */
const vbutton = (label: string) => `[...document.querySelectorAll("button")].find((b) => (${TEXT}(b) === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)}) && b.getClientRects().length > 0)`;
/** A field shown on screen by its label. */
const vfield = (label: string) => `(() => { const l = [...document.querySelectorAll("label")].find((x) => ${TEXT}(x) === ${JSON.stringify(label)} && x.getClientRects().length > 0); return l && (l.control || document.getElementById(l.htmlFor)); })()`;
/** A radio of the open dialog by its label's text. */
const radio = (label: string) => `[...document.querySelectorAll("[role=alertdialog] label")].find((l) => ${TEXT}(l).startsWith(${JSON.stringify(label)})).querySelector("[role=radio]")`;
/** Presses an element as a pointer does (the data grid selects on pointerdown). */
const press = (el: string) => `((el) => { for (const [T, type] of [[PointerEvent, "pointerdown"], [MouseEvent, "mousedown"], [PointerEvent, "pointerup"], [MouseEvent, "mouseup"], [MouseEvent, "click"]]) el.dispatchEvent(new T(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); return true; })(${el})`;
/** A visible grid's first row's cell. */
const firstCell = `[...document.querySelectorAll(".bdg-body > [role=row]:not([hidden]) [role=gridcell]")].find((c) => c.getClientRects().length > 0)`;

export default {
  id: "nats",
  task: "TSK-85",
  title: "NATS",
  builtWhen: "apps/mightyconsole/server/src/tools/nats",
  lab: ["nats"],
  items: [
    {
      id: "connect",
      text: "Connect with none, user and password, token, nkey and creds; wrong credentials give Auth; TLS against the lab CA.",
      lab: true,
      checks: [
        cargo("each_auth_needs_its_secret"),
        cargo("secrets_stay_out_of_debug"),
        lab("every_authentication_connects_and_wrong_credentials_are_auth"),
        vitest("test/nats.test.tsx", "each authentication asks for its own value and sends only it"),
        vitest("test/nats.test.tsx", "servers, TLS and the timeout are checked"),
        browser("connect to the lab and open the server", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Server"))`);
          await until(`__mc.has("JetStream on")`, "the server with JetStream");
          await shot("server and JetStream account");
        }),
      ],
    },
    {
      id: "core",
      text: "Server info and JetStream account info; subscribe with wildcards and a queue group as a live tail with headers; publish with headers and a reply subject; request with a reply and with no responders.",
      lab: true,
      checks: [
        lab("server_info_and_the_jetstream_account"),
        lab("subscribe_with_wildcards_and_a_queue_group_publish_and_request"),
        lab("a_paused_subscription_drops_the_oldest_and_counts_them"),
        vitest("test/nats.test.tsx", "ServerInfo, this connection and the JetStream account as bars"),
        vitest("test/nats.test.tsx", "subjects as tags and a queue group"),
        vitest("test/nats.test.tsx", "request: the reply beside the form"),
        browser("subscribe, publish, request and no responders", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Subscribe to"))`);
          await until(`__mc.field("Subjects: add") || document.querySelector('[aria-label="Subjects: add"]')`, "the Subscribe tab");
          await run(`__mc.type(document.querySelector('[aria-label="Subjects: add"]'), "lab.walk.> ")`);
          await until(`__mc.button("Remove lab.walk.>")`, "the subject tag");
          await run(`__mc.click(__mc.button("Start"))`);
          await until(`__mc.has("Live")`, "the live tail");
          await run(`__mc.dblclick(__mc.item("Publish"))`);
          await until(pubField("Subject"), "the Publish tab");
          await run(`__mc.type(${pubField("Subject")}, "lab.walk.one")`);
          await run(`__mc.type(${pubField("Reply subject")}, "lab.walk.reply")`);
          await run(`__mc.click(${send})`);
          await until(`__mc.has("Published") && __mc.has("on lab.walk.one")`, "the publish result");
          await shot("publish with a reply subject");
          await run(`__mc.click(${tab("Subscribe")})`);
          await until(`__mc.has("lab.walk.one")`, "the message in the live tail");
          await shot("subscribe live tail");
          await run(`__mc.click(${tab("Publish")})`);
          await run(`__mc.click(__mc.button("Request"))`);
          await run(`__mc.type(${pubField("Subject")}, "lab.echo")`);
          await run(`__mc.click(${send})`);
          await until(`__mc.has("Lab-Service")`, "the echo service's reply");
          await shot("request with the reply");
          await run(`__mc.type(${pubField("Subject")}, "lab.nobody.here")`);
          await run(`__mc.click(${send})`);
          await until(`__mc.has("No responders on lab.nobody.here")`, "no responders");
          await shot("request with no responders");
        }),
      ],
    },
    {
      id: "streams",
      text: "Streams: list, info, create, edit, purge (all, by subject, keep), delete with the typed name; browse from first, last, a sequence and a time, with follow; the full payload of a large message.",
      lab: true,
      checks: [
        cargo("the_form_goes_onto_the_config_and_back"),
        cargo("an_update_keeps_what_the_form_does_not_show"),
        cargo("server_errors_name_their_field"),
        lab("streams_list_info_create_update_purge_and_delete"),
        lab("browse_from_first_last_a_sequence_and_a_time_and_follow"),
        vitest("test/nats-jetstream.test.tsx", "a configuration goes to the form and back unchanged"),
        vitest("test/nats-jetstream.test.tsx", "the list opens a stream; New stream creates one"),
        vitest("test/nats-jetstream.test.tsx", "Info: counts, limits as bars"),
        vitest("test/nats-jetstream.test.tsx", "Messages: browse from a sequence with a subject filter"),
        vitest("test/nats-jetstream.test.tsx", "Purge: all needs the typed name"),
        vitest("test/nats-jetstream.test.tsx", "Delete stream asks for the name"),
        browser("create, edit, purge and delete a stream", async ({ page, origin, until, run, shot }) => {
          const stamp = Date.now().toString(36).toUpperCase();
          const name = `MC_WALK_${stamp}`;
          const subject = `walk.${stamp.toLowerCase()}`;
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await run(`__mc.dblclick(__mc.item("Streams"))`);
          await until(vbutton("ORDERS"), "the streams list");
          await shot("streams list");
          await run(`__mc.click(${vbutton("New stream")})`);
          await until(vfield("Name*"), "the stream form");
          await run(`__mc.type(${vfield("Name*")}, ${JSON.stringify(name)})`);
          await run(`__mc.type(document.querySelector('[role=dialog] [aria-label="Subjects: add"]'), ${JSON.stringify(`${subject}.> `)})`);
          await until(`__mc.button(${JSON.stringify(`Remove ${subject}.>`)})`, "the subject tag");
          await run(`__mc.type(${vfield("Max messages")}, "1000")`);
          await shot("new stream form");
          await run(`__mc.click(${vbutton("Create stream")})`);
          await until(`__mc.has(${JSON.stringify(`Created stream ${name}`)})`, "the created stream");
          await run(`__mc.click(${vbutton("Open stream")})`);
          await until(`${vbutton("Edit")} && !${vbutton("Edit")}.disabled`, "the stream's screen");
          await run(`__mc.click(${vbutton("Edit")})`);
          await until(`__mc.has(${JSON.stringify(`Edit stream ${name}`)})`, "the edit form");
          await run(`__mc.type(${vfield("Max messages")}, "500")`);
          await shot("edit stream with fields fixed after creation");
          await run(`__mc.click(${vbutton("Update stream")})`);
          await until(`__mc.has(${JSON.stringify(`Updated stream ${name}`)})`, "the updated stream");
          // Three messages through Publish, then purge all but the newest, then the rest.
          await run(`__mc.dblclick(__mc.item("Publish"))`);
          await until(pubField("Subject"), "the Publish tab");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Mode"] button')].find((b) => (b.textContent || "").trim() === "Publish"))`);
          for (const n of [1, 2, 3]) {
            await run(`__mc.type(${pubField("Subject")}, ${JSON.stringify(`${subject}.m${n}`)})`);
            await run(`__mc.click(${send})`);
            await until(`__mc.has(${JSON.stringify(`on ${subject}.m${n}`)})`, `message ${n} published`);
          }
          await run(`__mc.click(${tab(name)})`);
          await run(`__mc.click(${vbutton("Refresh")})`);
          await until(`__mc.has("3 messages")`, "the three messages");
          await run(`__mc.click(${vbutton("Purge…")})`);
          await until(`document.querySelector("[role=alertdialog]")`, "the purge dialog");
          await run(`__mc.click(${radio("Keep the newest n")})`);
          await until(vfield("Keep"), "the keep field");
          await run(`__mc.type(${vfield("Keep")}, "1")`);
          await until(vbutton("Purge 2 messages"), "the count");
          await shot("purge keeping the newest");
          await run(`__mc.click(${vbutton("Purge 2 messages")})`);
          await until(`__mc.has("Purged 2 messages")`, "the purge");
          await until(`!document.querySelector("[role=alertdialog]") && ${vbutton("Purge…")} && !${vbutton("Purge…")}.disabled`, "the refreshed stream");
          await run(`__mc.click(${vbutton("Purge…")})`);
          await until(vfield(`Type ${name} to purge all`), "the typed name");
          await run(`__mc.type(${vfield(`Type ${name} to purge all`)}, ${JSON.stringify(name)})`);
          await shot("purge all with the typed name");
          await run(`__mc.click(${vbutton("Purge 1 message")})`);
          await until(`__mc.has("Purged 1 message")`, "the purge of all");
          await until(`!document.querySelector("[role=alertdialog]")`, "the dialog closed");
          await run(`__mc.click(${vbutton("More: Delete stream, Copy config as JSON")})`);
          await until(`[...document.querySelectorAll("[role=menuitem]")].find((m) => (m.textContent || "").includes("Delete stream"))`, "the menu");
          await run(`__mc.click([...document.querySelectorAll("[role=menuitem]")].find((m) => (m.textContent || "").includes("Delete stream")))`);
          await until(vfield(`Type ${name} to confirm`), "the delete dialog");
          await run(`__mc.type(${vfield(`Type ${name} to confirm`)}, ${JSON.stringify(name)})`);
          await shot("delete stream with the typed name");
          await run(`__mc.click(${vbutton("Delete stream")})`);
          await until(`__mc.has(${JSON.stringify(`Deleted stream ${name}`)})`, "the deleted stream");
        }),
        browser("browse ORDERS and load a large message in full", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await until(`__mc.item("ORDERS")`, "ORDERS in the tree");
          await run(`__mc.dblclick(__mc.item("ORDERS"))`);
          await until(`__mc.has("1,051")`, "the stream's info");
          await shot("stream info");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Stream views"] [role=tab]')].find((t) => (t.textContent || "").startsWith("Messages")))`);
          await until(vbutton("Browse"), "the Messages view");
          await run(`__mc.click(${vbutton("Browse")})`);
          await until(`__mc.has("1,000 messages shown") || __mc.has("1000 messages shown")`, "the last 1,000");
          await shot("browse the last 1,000");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Browse from"] button')].find((b) => (b.textContent || "").trim() === "Sequence"))`);
          await run(`__mc.type(${vfield("Sequence")}, "10")`);
          await run(`__mc.click(${vbutton("Browse")})`);
          await until(`__mc.has("1,042 messages shown") || __mc.has("1042 messages shown")`, "from sequence 10");
          await shot("browse from a sequence");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Browse from"] button')].find((b) => (b.textContent || "").trim() === "First"))`);
          await run(`__mc.type(${vfield("Subject filter")}, "orders.large")`);
          await run(`__mc.click(${vbutton("Browse")})`);
          await until(`/(^|\\D)1 messages shown/.test(document.body.innerText) && __mc.has("Ended")`, "the large message");
          await run(press(firstCell));
          await until(`[...document.querySelectorAll("button")].find((b) => /Load full payload/.test(b.textContent || ""))`, "Load full payload");
          await shot("a message over 1 MiB, cut");
          await run(`__mc.click([...document.querySelectorAll("button")].find((b) => /Load full payload/.test(b.textContent || "")))`);
          await until(`![...document.querySelectorAll("button")].find((b) => /Load full payload/.test(b.textContent || ""))`, "the full payload");
          await shot("the full payload");
        }),
      ],
    },
    {
      id: "consumers",
      text: "Consumers: list, info with pending and ack state, create, delete.",
      lab: true,
      checks: [
        cargo("a_consumer_from_the_form"),
        lab("consumers_list_info_create_and_delete"),
        vitest("test/nats-jetstream.test.tsx", "Consumers: the table opens a consumer"),
        vitest("test/nats-jetstream.test.tsx", "pending, ack pending, redelivered and waiting"),
        vitest("test/nats-jetstream.test.tsx", "the position: acknowledged"),
        vitest("test/nats-jetstream.test.tsx", "the consumer form"),
        browser("the billing consumer, then create and delete one", async ({ page, origin, until, run, shot }) => {
          const name = `walk-${Date.now().toString(36)}`;
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await until(`__mc.item("ORDERS")`, "ORDERS in the tree");
          await run(`__mc.dblclick(__mc.item("ORDERS"))`);
          await until(`__mc.has("1,051")`, "the stream");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Stream views"] [role=tab]')].find((t) => (t.textContent || "").startsWith("Consumers")))`);
          await until(vbutton("billing"), "the consumers table");
          await shot("consumers of ORDERS");
          await run(`__mc.click(${vbutton("billing")})`);
          await until(`__mc.has("Where it is in the stream") && __mc.has("Ack pending")`, "the consumer");
          await shot("consumer billing with its position");
          // The consumer opened in the same tab (TSK-105): Back returns to the stream.
          await run(`__mc.click([...document.querySelectorAll("[role=tabpanel]:not([hidden]) [role=toolbar][aria-label=Location] button")].find((b) => b.getAttribute("aria-label") === "Back"))`);
          await until(`__mc.has("1,051")`, "back to the stream");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Stream views"] [role=tab]')].find((t) => (t.textContent || "").startsWith("Consumers")))`);
          await until(vbutton("New consumer…"), "the stream's consumers again");
          await run(`__mc.click(${vbutton("New consumer…")})`);
          await until(vfield("Name*"), "the consumer form");
          await run(`__mc.type(${vfield("Name*")}, ${JSON.stringify(name)})`);
          await run(`__mc.type(document.querySelector('[role=dialog] [aria-label="Filter subjects: add"]'), "orders.us.> ")`);
          await until(`__mc.button("Remove orders.us.>")`, "the filter tag");
          await shot("new consumer form");
          await run(`__mc.click(${vbutton("Create consumer")})`);
          await until(`__mc.has(${JSON.stringify(`Created consumer ${name}`)})`, "the created consumer");
          await run(`__mc.click(${vbutton("Open consumer")})`);
          await until(`__mc.has("Where it is in the stream") && ${vbutton("Delete…")}`, "the new consumer");
          await until(`__mc.has("334") || __mc.has("333")`, "its pending messages");
          await run(`__mc.click(${vbutton("Delete…")})`);
          await until(`__mc.has(${JSON.stringify(`Delete consumer ${name} of ORDERS`)})`, "the confirmation");
          await shot("delete consumer");
          await run(`__mc.click(${vbutton("Delete consumer")})`);
          await until(`__mc.has(${JSON.stringify(`${name} was deleted.`)})`, "the deleted consumer");
        }),
      ],
    },
    {
      id: "kv-objects",
      text: "KV: buckets, keys, get, history, put with an expected revision (and its conflict), delete, purge, watch; Object Store: buckets, list, upload of the 5 MiB file in parts with progress, download, info, delete.",
      lab: true,
      // KV (batch 3a) and Object Store (batch 3b).
      checks: [
        cargo("keys_and_buckets_are_checked"),
        lab("kv_buckets_keys_get_history_and_the_deleted_key"),
        lab("kv_create_put_with_revisions_delete_purge_watch_and_delete_the_bucket"),
        vitest("test/nats-kv.test.tsx", "bucket form, keys, values and the line diff"),
        vitest("test/nats-kv.test.tsx", "the list opens a bucket; New bucket creates one"),
        vitest("test/nats-kv.test.tsx", "keys with a filter and Show deleted"),
        vitest("test/nats-kv.test.tsx", "History: compare a revision with the latest"),
        vitest("test/nats-kv.test.tsx", "Delete and Purge a key"),
        vitest("test/nats-kv.test.tsx", "Put key: the Composer without headers"),
        browser("a bucket's keys, a key's history compared and put back, watch", async ({ page, origin, until, run, shot }) => {
          const bucket = `mc_walk_${Date.now().toString(36)}`;
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await until(`__mc.item("config")`, "the config bucket in the tree");
          await run(`__mc.dblclick(__mc.item("config"))`);
          await until(vbutton("feature.checkout") + ` && __mc.has("revision")`, "the keys and the entry");
          await shot("config keys and an entry");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Key views"] [role=tab]')].find((t) => (t.textContent || "").startsWith("History")))`);
          await until(`document.querySelector("[data-slot=diff]")`, "feature.checkout's revisions compared");
          await shot("a key's revisions compared");
          await run(`__mc.click([...document.querySelectorAll("[role=switch]")].find((s) => s.getClientRects().length > 0 && (s.closest("label")?.textContent || "").includes("Show deleted")))`);
          await until(vbutton("legacy.flag"), "the deleted key");
          await shot("deleted keys struck through");
          // A bucket of the walk's own: create, put twice, compare, put the first back, delete.
          await run(`__mc.dblclick(__mc.item("Key-Value"))`);
          await until(vbutton("New bucket"), "the bucket list");
          await run(`__mc.click(${vbutton("New bucket")})`);
          await until(vfield("Bucket*"), "the bucket form");
          await run(`__mc.type(${vfield("Bucket*")}, ${JSON.stringify(bucket)})`);
          await run(`__mc.type(${vfield("History")}, "5")`);
          await run(`__mc.click(${vbutton("Create bucket")})`);
          await until(`__mc.has(${JSON.stringify(`Created bucket ${bucket}`)})`, "the created bucket");
          await run(`__mc.click(${vbutton("Open bucket")})`);
          await until(`${vbutton("Put key")} && !${vbutton("Put key")}.disabled`, "the bucket");
          // The Composer's value editor is Monaco: both puts send its default value.
          for (const n of [1, 2]) {
            await run(`__mc.click(${vbutton("Put key")})`);
            await until(vfield("Key"), "the put sheet");
            await run(`__mc.type(${vfield("Key")}, "feature.walk")`);
            if (n === 1) await shot("put a key through the Composer");
            await run(`__mc.click(document.querySelector("[role=dialog] [data-slot=composer] button[type=submit]"))`);
            await until(`__mc.has(${JSON.stringify(`Put feature.walk at revision ${n}`)})`, `put ${n}`);
            await until(`!document.querySelector("[role=dialog] [data-slot=composer]")`, "the sheet closed");
          }
          await until(vbutton("feature.walk"), "the key");
          await run(`__mc.click(${vbutton("feature.walk")})`);
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Key views"] [role=tab]')].find((t) => (t.textContent || "").startsWith("History") && t.getClientRects().length > 0))`);
          await until(`[...document.querySelectorAll("[data-slot=diff]")].some((d) => d.getClientRects().length > 0)`, "the comparison");
          await run(`__mc.click([...document.querySelectorAll("button")].find((b) => /^Put revision \\d+ back…$/.test((b.textContent || "").trim()) && b.getClientRects().length > 0))`);
          await until(`document.querySelector("[role=alertdialog]")`, "the confirmation");
          await shot("put a revision back with the latest expected");
          await run(`__mc.click([...document.querySelectorAll("button")].find((b) => /^Put revision \\d+ back$/.test((b.textContent || "").trim()) && b.getClientRects().length > 0))`);
          await until(`__mc.has("back as revision")`, "the revision put back");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Bucket views"] [role=tab]')].find((t) => (t.textContent || "").startsWith("Watch") && t.getClientRects().length > 0))`);
          const historySwitch = `[...document.querySelectorAll('[aria-label="Watch"] [role=switch]')].find((s) => s.getClientRects().length > 0)`;
          await run(press(historySwitch));
          await until(`(${historySwitch})?.getAttribute("aria-checked") === "true" || (${historySwitch})?.hasAttribute("data-checked")`, "History first on");
          await run(`__mc.click([...document.querySelectorAll('[aria-label="Watch"] button')].find((b) => (b.textContent || "").trim() === "Watch" && b.getClientRects().length > 0))`);
          await until(`__mc.has("entries shown") || __mc.has("Live")`, "the watch started");
          await shot("watch started");
          await until(`/(^|\\D)3 entries shown/.test(document.body.innerText)`, "the watch with history");
          await shot("watch with history");
          await run(`__mc.click(${vbutton("More: Delete bucket")})`);
          await until(`[...document.querySelectorAll("[role=menuitem]")].find((m) => (m.textContent || "").includes("Delete bucket"))`, "the menu");
          await run(`__mc.click([...document.querySelectorAll("[role=menuitem]")].find((m) => (m.textContent || "").includes("Delete bucket")))`);
          await until(vfield(`Type ${bucket} to confirm`), "the delete dialog");
          await run(`__mc.type(${vfield(`Type ${bucket} to confirm`)}, ${JSON.stringify(bucket)})`);
          await run(`__mc.click(${vbutton("Delete bucket")})`);
          await until(`__mc.has(${JSON.stringify(`Deleted bucket ${bucket}`)})`, "the deleted bucket");
        }),
        cargo("object_names_are_checked"),
        cargo("headers_are_checked"),
        cargo("digests_match_in_both_forms"),
        lab("object_store_buckets_list_info_and_download_the_lab_files"),
        lab("object_store_create_upload_in_parts_replace_abort_and_delete"),
        vitest("test/nats-objects.test.tsx", "bucket form, names, digests, file names and base64"),
        vitest("test/nats-objects.test.tsx", "parts go in order"),
        vitest("test/nats-objects.test.tsx", "a failed part or a cancel aborts the upload"),
        vitest("test/nats-objects.test.tsx", "a download gathers the stream's chunks"),
        vitest("test/nats-objects.test.tsx", "the list opens a bucket; New object store creates one"),
        vitest("test/nats-objects.test.tsx", "objects with the selected one's info"),
        vitest("test/nats-objects.test.tsx", "Upload: the file's name is the object's"),
        vitest("test/nats-objects.test.tsx", "Delete an object; Delete the bucket"),
        browser("the lab's files, an upload of 9 MiB in parts with progress, download, info, delete", async ({ page, origin, until, run, shot }) => {
          const bucket = `mc_walk_obj_${Date.now().toString(36)}`;
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await until(`__mc.item("files")`, "the files object store in the tree");
          await run(`__mc.dblclick(__mc.item("files"))`);
          await until(vbutton("blob-5MiB.bin") + ` && __mc.has("SHA-256")`, "the objects and the info");
          await shot("the lab's files with an object's info");
          await run(`__mc.click(${vbutton("Download")})`);
          await until(`__mc.has("Downloaded blob-5MiB.bin")`, "the 5 MiB download");
          await shot("downloaded");
          // An object store of the walk's own: create, upload 9 MiB (three parts), delete.
          await run(`__mc.dblclick(__mc.item("Object Store"))`);
          await until(vbutton("New object store"), "the object store list");
          await shot("object stores");
          await run(`__mc.click(${vbutton("New object store")})`);
          await until(vfield("Bucket*"), "the object store form");
          await run(`__mc.type(${vfield("Bucket*")}, ${JSON.stringify(bucket)})`);
          await run(`__mc.click(${vbutton("Create object store")})`);
          await until(`__mc.has(${JSON.stringify(`Created object store ${bucket}`)})`, "the created object store");
          await run(`__mc.click(${vbutton("Open bucket")})`);
          await until(`${vbutton("Upload")} && !${vbutton("Upload")}.disabled`, "the bucket");
          await run(`__mc.click(${vbutton("Upload")})`);
          await until(`document.querySelector("form[aria-label='Upload an object'] input[type=file]")`, "the upload sheet");
          await run(`(() => {
            const input = document.querySelector("form[aria-label='Upload an object'] input[type=file]");
            const bytes = new Uint8Array(9 * 1024 * 1024);
            for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
            const dt = new DataTransfer();
            dt.items.add(new File([bytes], "walk-9MiB.bin", { type: "application/octet-stream" }));
            input.files = dt.files;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          })()`);
          await until(`${vfield("Object name")}?.value === "walk-9MiB.bin"`, "the object name from the file");
          await shot("an upload chosen");
          await run(`__mc.click(document.querySelector("button[form='upload-form']"))`);
          await until(`__mc.has("of 3") || __mc.has("Uploaded walk-9MiB.bin")`, "the upload in parts");
          await shot("an upload in parts with progress");
          await until(`__mc.has("Uploaded walk-9MiB.bin")`, "the upload");
          await until(vbutton("walk-9MiB.bin") + ` && __mc.has("72 of up to 128 KiB")`, "the uploaded object's info");
          await shot("the uploaded object");
          await run(`__mc.click(${vbutton("Delete…")})`);
          await until(`__mc.has("Delete walk-9MiB.bin from")`, "the delete confirmation");
          await shot("delete an object");
          await run(`__mc.click(${vbutton("Delete object")})`);
          await until(`__mc.has("No objects in this bucket.")`, "the object deleted");
          await run(`__mc.click(${vbutton("More: Delete bucket")})`);
          await until(`[...document.querySelectorAll("[role=menuitem]")].find((m) => (m.textContent || "").includes("Delete bucket"))`, "the menu");
          await run(`__mc.click([...document.querySelectorAll("[role=menuitem]")].find((m) => (m.textContent || "").includes("Delete bucket")))`);
          await until(vfield(`Type ${bucket} to confirm`), "the delete dialog");
          await run(`__mc.type(${vfield(`Type ${bucket} to confirm`)}, ${JSON.stringify(bucket)})`);
          await run(`__mc.click(${vbutton("Delete bucket")})`);
          await until(`__mc.has(${JSON.stringify(`Deleted object store ${bucket}`)})`, "the deleted object store");
        }),
      ],
    },
    {
      id: "services",
      text: "Services: the lab's echo is discovered with INFO, STATS and PING.",
      lab: true,
      checks: [
        cargo("subjects_name_the_service_and_instance"),
        cargo("info_replies_are_read"),
        cargo("stats_replies_are_read_from_every_client"),
        cargo("only_service_replies_count"),
        lab("services_discover_stats_and_ping_the_lab_echo"),
        vitest("test/nats-objects.test.tsx", "the services with PING"),
        vitest("test/nats-objects.test.tsx", "nobody answers; STATS failing leaves the list"),
        browser("the lab's echo with its endpoints, STATS and PING", async ({ page, origin, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ until, run, shot });
          await until(`__mc.item("Services")`, "Services in the tree");
          await run(`__mc.dblclick(__mc.item("Services"))`);
          await until(vbutton("echo") + ` && __mc.has("lab.echo.upper") && __mc.has("answered within 2 s")`, "the echo service");
          await shot("services with endpoints, STATS and PING");
        }),
      ],
    },
    {
      id: "schemas",
      text: "A local Protobuf schema mapped to orders.proto.> decodes those payloads; every destructive action is confirmed as in the pattern; CI green.",
      lab: true,
      checks: [],
    },
  ],
} satisfies Checklist;
