// TSK-85, NATS (Mightyconsole spec section 18, against the lab's NATS servers). The server's
// checks: the unit tests of tools/nats and tests/nats_lab.rs (feature lab-tests) against the lab
// (password, nkey, no-auth default user, TLS, a token server and an operator-mode server for
// .creds). The UI's: test/nats.test.tsx (jsdom), and a walk through the tool in a browser with
// screenshots. Each TSK-85 batch wires its items; run
// `pnpm --filter @byterygon/mightyconsole acceptance nats --lab-up --strict --only connect,core`
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
      checks: [],
    },
    {
      id: "consumers",
      text: "Consumers: list, info with pending and ack state, create, delete.",
      lab: true,
      checks: [],
    },
    {
      id: "kv-objects",
      text: "KV: buckets, keys, get, history, put with an expected revision (and its conflict), delete, purge, watch; Object Store: buckets, list, upload of the 5 MiB file in parts with progress, download, info, delete.",
      lab: true,
      checks: [],
    },
    {
      id: "services",
      text: "Services: the lab's echo is discovered with INFO, STATS and PING.",
      lab: true,
      checks: [],
    },
    {
      id: "schemas",
      text: "A local Protobuf schema mapped to orders.proto.> decodes those payloads; every destructive action is confirmed as in the pattern; CI green.",
      lab: true,
      checks: [],
    },
  ],
} satisfies Checklist;
