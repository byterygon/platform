#!/usr/bin/env node
// The security screens in real browsers against the lab's Dex, signed in as people of different
// roles (TSK-158, DOC-25 §6, the screens of TSK-140). Each person has a browser of their own: Alice
// (group mc-admins: admin), Bob (mc-viewers: viewer) and Carol (no group, so no role until Alice
// gives her one).
//
//   node admin-walk.mts SERVER EVIDENCE_DIR
//
// Like sign-in-walk.mts it starts SERVER on https://localhost:17443 with `[auth.oidc]` from
// `lab/.generated/credentials.json`, and maps the lab's groups to roles with no default role. It
// needs `lab up idp temporal` (Dex, Temporal and its payload codec), a built UI and a Chromium
// browser. The walk:
//
//  1. Carol signs in to the no-role page; Alice's menu has Users and roles and Audit log.
//  2. Users and roles: the people, the role matrix, a new role (Temporal readers: Temporal's read
//     and no personal profiles), given to Carol, whose page then opens with every other tool
//     locked and its reason (the workspace too, with Add connection off).
//  3. Alice adds a shared Temporal profile with the codec's Authorization header (a secret), sees
//     who it reaches, and connects: the lab's encrypted payloads are decoded with it. She replaces
//     it with a wrong one (the payloads stay as stored) and removes it.
//  4. Bob (viewer) connects with the shared profile: Terminate is off with its reason. On a
//     personal profile of his own he may destroy: Terminate asks him to type the name (cancelled).
//     Carol, with Temporal's read and no personal profiles, lists the shared profile and connects.
//  5. Alice takes Carol's role away (Carol's session ends) and turns Bob's account off (his ends).
//  6. The Audit log: filtered by who, an entry with its digests, Verify chain, the CSV export.
//  7. A profile kept in Alice's browser (IndexedDB, seeded here and never read back) moves to the
//     server with its secret, and connects from there.
//
// No step reads a secret back: the walk types the lab's codec header into the field and seeds it
// into IndexedDB, and checks that no page shows it. The backup file of step 7 holds it in plain
// text: the walk checks the file exists and deletes it unread.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const PORT = 17443;
const ORIGIN = `https://localhost:${PORT}`;
/** Names the walk gives; a run starts from an empty data directory, so they never clash. */
const SHARED = "team-temporal";
const PERSONAL = "bob-temporal";
const MOVED = "browser-temporal";
const ROLE = "Temporal readers";
const ROLE_ID = "temporal-readers";
/** What the lab's codec workflow carries in its input once decrypted (not a secret: test data). */
const DECODED = "4111111111111111";

type Cdp = typeof import("../ui/scripts/cdp.ts");
type Page = import("../ui/scripts/cdp.ts").Page;

interface Idp {
  issuer: string;
  caFile: string;
  clientId: string;
  clientSecretFile: string;
  redirectUris: string[];
  users: { username: string; email: string; password: string }[];
}

/** The in-page expression for a visible button by its text or label. */
const shown = (label: string) => `[...document.querySelectorAll("button, [role=menuitem], [role=tab], a")].find((b) => b.checkVisibility() && ((b.textContent || "").replace(/\\s+/g, " ").trim() === ${JSON.stringify(label)} || b.getAttribute("aria-label") === ${JSON.stringify(label)}))`;
/** A visible field by its label's text. */
const field = (label: string, within = "document") =>
  `(() => { const l = [...${within}.querySelectorAll("label")].find((x) => x.checkVisibility() && x.textContent.replace("*", "").trim() === ${JSON.stringify(label)}); return l ? (l.control || document.getElementById(l.htmlFor) || l.parentElement?.querySelector("input, textarea")) : null; })()`;
/** A press as a pointer gives it (Base UI tabs, selects and checkboxes listen to pointer events). */
const press = (el: string) =>
  `(() => { const t = ${el}; if (!t) throw new Error("nothing to press"); for (const k of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) t.dispatchEvent(new (k.startsWith("pointer") ? PointerEvent : MouseEvent)(k, { bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true })); return true; })()`;
const dialog = (testid: string) => `document.querySelector('[data-testid="${testid}"]')`;
const text = (el: string) => `((${el})?.innerText ?? "")`;
const tree = (label: string) => `[...document.querySelectorAll("[role=treeitem]")].find((el) => el.checkVisibility() && (el.textContent || "").trim().startsWith(${JSON.stringify(label)}))`;

async function main(server: string, evidence: string): Promise<number> {
  const { findBrowser } = await import("../../../packages/ui/scripts/browser-check.ts");
  const cdp: Cdp = await import("../ui/scripts/cdp.ts");
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error("admin walk: no browser (set BYTERYGON_BROWSER)");
    return 1;
  }
  const generated = join(APP, "lab", ".generated");
  const credentials = JSON.parse(readFileSync(join(generated, "credentials.json"), "utf8")) as { idp?: Idp; temporal?: { codec?: { endpoint: string; authorization: string } } };
  const idp = credentials.idp;
  const codec = credentials.temporal?.codec;
  if (!idp || !codec) {
    console.error("admin walk: lab/.generated/credentials.json needs idp and temporal.codec (run `lab up idp temporal`)");
    return 1;
  }
  if (!idp.redirectUris.includes(`${ORIGIN}/auth/callback`)) {
    console.error(`admin walk: the lab's Dex does not register ${ORIGIN}/auth/callback (run \`lab down\`, then \`lab up idp\`)`);
    return 1;
  }
  const ui = join(APP, "ui", "dist");
  if (!existsSync(join(ui, "index.html"))) {
    const build = spawnSync("pnpm", ["--filter", "@byterygon/mightyconsole", "build"], { stdio: "inherit" });
    if (build.status !== 0) return 1;
  }
  const user = (name: string) => idp.users.find((u) => u.username === name)!;
  const data = mkdtempSync(join(tmpdir(), "mightyconsole-admin-walk-"));
  const downloads = join(data, "downloads");
  mkdirSync(downloads);
  const shots = join(evidence, "screenshots");
  mkdirSync(shots, { recursive: true });
  const config = join(data, "config.toml");
  writeFileSync(
    config,
    [
      "[server]",
      `listen = "127.0.0.1:${PORT}"`,
      `public_origin = "${ORIGIN}"`,
      "",
      "[auth]",
      'default_role = ""',
      "",
      "[[auth.group_roles]]",
      'group = "idp:mc-admins"',
      'role = "admin"',
      "",
      "[[auth.group_roles]]",
      'group = "idp:mc-viewers"',
      'role = "viewer"',
      "",
      "[auth.oidc]",
      `issuer = "${idp.issuer}"`,
      `client_id = "${idp.clientId}"`,
      `client_secret_file = "${join(generated, idp.clientSecretFile)}"`,
      `ca_file = "${join(generated, idp.caFile)}"`,
      'scopes = ["openid", "profile", "email", "groups"]',
      'display_name = "Lab Dex"',
      "",
    ].join("\n"),
  );
  chmodSync(config, 0o600);

  let child: ChildProcess | undefined;
  const browsers: ChildProcess[] = [];
  const pages: [string, Page][] = [];
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
    return ok;
  };
  /** A step the rest depends on: a failure stops the walk. */
  const must = (ok: boolean, what: string) => {
    if (!check(ok, what)) throw new Error(`stopped: ${what}`);
  };
  let n = 0;
  const shot = async (page: Page, name: string) => {
    await cdp.sleep(400);
    await page.screenshot(join(shots, `admin-${String(++n).padStart(2, "0")}-${name}.png`));
  };
  const run = <T,>(page: Page, expression: string) => cdp.run(page, expression) as Promise<T>;
  const until = (page: Page, expression: string, ms = 20_000) => cdp.waitUntil(page, expression, ms);
  /** No page shows the lab's secrets: the codec header, the users' passwords. */
  const leaks = async (page: Page) => {
    const body = await run<string>(page, `document.body.innerText + [...document.querySelectorAll("input, textarea")].map((i) => i.value).join(" ")`);
    return [codec.authorization, codec.authorization.replace(/^Bearer /, ""), ...idp.users.map((u) => u.password)].some((s) => s.length > 6 && body.includes(s));
  };

  const browser = async (name: string) => {
    const dir = join(data, name);
    mkdirSync(dir);
    const b = await cdp.launchBrowser(browserPath, dir);
    browsers.push(b.chrome);
    await b.cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads });
    const page = await cdp.openPage(b.cdp);
    pages.push([name, page]);
    return page;
  };
  /** Signs `who` in through Dex in `page` and waits for the page Mightyconsole shows them. */
  const signIn = async (page: Page, who: string, landed: string) => {
    const u = user(who);
    await page.navigate(`${ORIGIN}/`);
    must(await until(page, `[...document.querySelectorAll("a")].some((a) => (a.textContent || "").includes("Continue with Lab Dex"))`, 30_000), `${who}: the sign-in page offers Continue with Lab Dex`);
    await run(page, `[...document.querySelectorAll("a")].find((a) => (a.textContent || "").includes("Continue with Lab Dex")).click()`);
    must(await until(page, `location.host === "localhost:5556" && document.querySelector("input[name=login]")`, 30_000), `${who}: Dex's login form`);
    await page.evaluate(`(() => {
      document.querySelector("input[name=login]").value = ${JSON.stringify(u.email)};
      document.querySelector("input[name=password]").value = ${JSON.stringify(u.password)};
      document.querySelector("form").requestSubmit();
      return true;
    })()`);
    must(await until(page, `location.origin === ${JSON.stringify(ORIGIN)} && (${landed})`, 30_000), `${who}: signed in, back on Mightyconsole`);
  };
  const accountMenu = async (page: Page) => {
    await until(page, `document.querySelector('[data-testid="account-button"]') !== null`, 20_000);
    await run(page, `document.querySelector('[data-testid="account-button"]').click()`);
    return until(page, `document.querySelector('[data-testid="account-summary"]') !== null`, 10_000);
  };
  const menuItems = (page: Page) => run<string>(page, `[...document.querySelectorAll("[role=menuitem]")].map((i) => i.textContent.trim()).join("|")`);
  const escape = (page: Page) => run(page, `(document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  /** Picks `option` in the Base UI select labelled `label` inside `within`. */
  const choose = async (page: Page, within: string, label: string, option: string) => {
    await run(page, press(`${within}.querySelector('[aria-label="${label}"]')`));
    must(await until(page, `[...document.querySelectorAll("[role=option]")].some((o) => o.checkVisibility() && o.textContent.trim() === ${JSON.stringify(option)})`, 10_000), `the ${label} list offers ${option}`);
    await run(page, press(`[...document.querySelectorAll("[role=option]")].find((o) => o.checkVisibility() && o.textContent.trim() === ${JSON.stringify(option)})`));
    await cdp.sleep(300);
  };
  const tool = async (page: Page, label: string) => {
    await until(page, `__mc.button(${JSON.stringify(label)})`, 20_000);
    await run(page, `__mc.click(__mc.button(${JSON.stringify(label)}))`);
  };
  /** Connects a Temporal profile from the pane (it may already be connecting by itself). */
  const connect = async (page: Page, profile: string) => {
    must(await until(page, tree(profile), 20_000), `${profile} is in the connection pane`);
    const auto = await until(page, `${tree(profile)}?.getAttribute("aria-expanded") === "true" && __mc.item("Workers")`, 4_000);
    if (!auto) await run(page, `__mc.dblclick(${tree(profile)})`);
    return until(page, `__mc.item("Workers")`, 30_000);
  };
  /** Opens a seeded workflow of namespace `lab` through the profile by its link. */
  const workflow = async (page: Page, profile: string, id: string) => {
    await page.navigate(`${ORIGIN}/temporal/${profile}/lab/workflows?q=${encodeURIComponent(`WorkflowId = "${id}"`)}`);
    // The list's row, not a tab of the same workflow opened through another profile.
    const row = `[...document.querySelectorAll("button:not([role=tab])")].find((b) => b.checkVisibility() && b.textContent.trim() === ${JSON.stringify(id)} && !b.closest("[role=tablist], nav"))`;
    must(await until(page, row, 40_000), `${profile}: the workflow list finds ${id}`);
    await run(page, `${row}.click()`);
    return until(page, `location.pathname.startsWith(${JSON.stringify(`/temporal/${profile}/lab/workflows/${id}/`)}) && [...document.querySelectorAll("[role=tab]")].some((t) => t.checkVisibility() && t.textContent.trim() === "Input and result")`, 20_000);
  };
  const inputTab = async (page: Page) => {
    await run(page, press(`[...document.querySelectorAll("[role=tab]")].find((x) => x.checkVisibility() && x.textContent.trim() === "Input and result")`));
  };
  /** Opens the profile sheet of `profile` through the pane's context menu. */
  const edit = async (page: Page, profile: string) => {
    must(await until(page, tree(profile), 20_000), `${profile} is in the connection pane`);
    await run(page, `${tree(profile)}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }))`);
    must(await until(page, shown("Edit"), 10_000), `${profile}: the context menu has Edit`);
    await run(page, `${shown("Edit")}.click()`);
    return until(page, `${field("Name")}?.value === ${JSON.stringify(profile)}`, 10_000);
  };
  /** Back to Temporal's pane (a fresh page: no sheet or menu left open). */
  const temporalPane = async (page: Page) => {
    await page.navigate(`${ORIGIN}/temporal`);
    await until(page, `__mc.button("Add connection")`, 20_000);
  };
  const codecState = (page: Page) => run<string>(page, `document.querySelector('[data-secret="codecAuthorization"]')?.dataset.state ?? ""`);
  const ended = (page: Page) => until(page, `[...document.querySelectorAll("[role=alertdialog]")].some((d) => (d.textContent || "").includes("Your session ended"))`, 30_000);

  try {
    child = spawn(server, ["--config", config, "--data", data, "--ui", ui], { stdio: ["ignore", "ignore", "pipe"] });
    const [startup] = await cdp.waitForLine(child, /[\s\S]*open https:\/\/localhost:\d+\//, "mightyconsole-server");
    writeFileSync(join(evidence, "admin-walk-server.log"), startup ?? "");

    // --- 1. Three people sign in -------------------------------------------------------------
    const bob = await browser("bob");
    await signIn(bob, "bob", `document.querySelector('[data-testid="account-button"]') !== null`);
    const carol = await browser("carol");
    await signIn(carol, "carol", `document.body.innerText.includes("you have no role here yet")`);
    check(await run<boolean>(carol, `__mc.has("Nothing here gives you a Mightyconsole role") && Boolean(__mc.button("Check again"))`), "Carol (no group) sees the no-role page with Check again");
    await shot(carol, "carol-no-role");
    const alice = await browser("alice");
    await signIn(alice, "alice", `document.querySelector('[data-testid="account-button"]') !== null`);
    must(await accountMenu(alice), "Alice's account menu opens");
    const items = await menuItems(alice);
    check(/Users and roles/.test(items) && /Audit log/.test(items), `an administrator's menu has Users and roles and Audit log (${items})`);
    check(/admin/.test(await run<string>(alice, text(`document.querySelector('[data-testid="account-summary"]')`))), "the menu shows Alice's role, admin");
    await shot(alice, "alice-account-menu");

    // --- 2. Users and roles ------------------------------------------------------------------
    await run(alice, `${shown("Users and roles")}.click()`);
    must(await until(alice, `${dialog("admin-users")} && ${text(dialog("admin-users"))}.includes("Carol")`, 20_000), "Users and roles lists the people who signed in");
    const people = await run<string>(alice, text(dialog("admin-users")));
    check(/Bob Viewer/.test(people) && /viewer/.test(people), "Bob is listed with the viewer role from his group");
    check(/No role/.test(people) && /waiting for a role/.test(people), "Carol is listed with No role, and the count says who waits for one");
    await run(alice, `[...document.querySelectorAll("[data-person]")].find((b) => b.textContent.includes("Bob")).click()`);
    check(await until(alice, `${text(dialog("admin-user-detail"))}.includes("group") && document.querySelectorAll('[data-testid="admin-user-detail"] [data-session]').length >= 1`, 10_000), "Bob's detail: his role from the group and his live session");
    // The audit log names people by their principal id (`human:oidc:<Dex's subject>`), not their name.
    const bobId = await run<string>(alice, `[...document.querySelectorAll("tr[data-user]")].find((r) => r.textContent.includes("Bob Viewer"))?.dataset.user ?? ""`);
    check(bobId.startsWith("human:oidc:"), `Bob's user id is his principal id (${bobId})`);
    await shot(alice, "users");

    await run(alice, press(shown("Roles")));
    must(await until(alice, `${dialog("admin-roles")} && document.querySelector('table[aria-label="Operator: tools by risk"]')`, 10_000), "the Roles tab shows the operator's matrix");
    await shot(alice, "roles-matrix");
    await run(alice, `${shown("New role")}.click()`);
    must(await until(alice, dialog("role-name"), 10_000), "New role asks for a name");
    await run(alice, `__mc.type(${field("Name", dialog("role-name"))}, ${JSON.stringify(ROLE)})`);
    check(await until(alice, `${text(dialog("role-name"))}.includes("Its id is ${ROLE_ID}")`, 5_000), `the new role's id is ${ROLE_ID}`);
    await run(alice, `${shown("Create role")}.click()`);
    must(await until(alice, `document.querySelector('[aria-label="${ROLE}, Temporal, Read"]')`, 10_000), `${ROLE} is made and selected`);
    await run(alice, press(`document.querySelector('[aria-label="${ROLE}, profiles.personal"]')`));
    await run(alice, press(`document.querySelector('[aria-label="${ROLE}, Temporal, Read"]')`));
    must(await until(alice, `document.querySelector('[aria-label="${ROLE}, Temporal, Read"]')?.getAttribute("aria-checked") === "true" && document.querySelector('[aria-label="${ROLE}, profiles.personal"]')?.getAttribute("aria-checked") === "false"`, 5_000), `${ROLE}: Temporal's read ticked, personal profiles not`);
    await run(alice, `[...${dialog("admin-roles")}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Save").click()`);
    check(await until(alice, `__mc.has("Role saved")`, 10_000), `${ROLE} is saved`);
    await shot(alice, "new-role");

    await run(alice, press(shown("Users")));
    await until(alice, `[...document.querySelectorAll("[data-person]")].some((b) => b.textContent.includes("Carol"))`, 10_000);
    await run(alice, `[...document.querySelectorAll("[data-person]")].find((b) => b.textContent.includes("Carol")).click()`);
    must(await until(alice, `${text(dialog("admin-user-detail"))}.includes("No role.")`, 10_000), "Carol's detail says she has no role");
    await run(alice, `${shown("Add role…")}.click()`);
    must(await until(alice, dialog("add-role"), 10_000), "Add role opens");
    await choose(alice, dialog("add-role"), "Role", ROLE);
    await shot(alice, "add-role");
    await run(alice, `[...${dialog("add-role")}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Add role").click()`);
    check(await until(alice, `__mc.has("Role added") && document.querySelector('[data-testid="admin-user-detail"] [data-assignment="${ROLE_ID}"]')`, 10_000), "Carol has the role, given directly");

    // Carol asks again: the app opens, every tool but Temporal locked with its reason.
    await run(carol, `__mc.click(__mc.button("Check again"))`);
    must(await until(carol, `document.querySelector('[data-testid="account-button"]') && document.querySelector('[data-nav-item][data-tool="temporal"]')`, 20_000), "Check again opens the app for Carol");
    const locks = await run<Record<string, string | null>>(carol, `Object.fromEntries([...document.querySelectorAll("[data-nav-item]")].map((b) => [b.dataset.tool, b.dataset.locked ?? null]))`);
    check(locks["temporal"] === null && locks["nats"] === "nats.read" && locks["docker"] === "docker.read", `Carol's tools: Temporal open, the others locked by their read permission (${JSON.stringify(locks)})`);
    await run(carol, `document.querySelector('[data-nav-item][data-tool="nats"]').click()`);
    check(await until(carol, `document.querySelector('[data-testid="access-page"][data-perm="nats.read"]') && __mc.has("nats.read")`, 10_000), "a locked tool's page names the permission it needs and why");
    // TSK-172: the workspace says why, with no "Add a NATS connection"; every Add connection is
    // off with the reason; and the profiles list, though her role keeps no personal profiles.
    const addButtons = `[...document.querySelectorAll("button")].filter((b) => b.checkVisibility() && ((b.textContent || "").trim().endsWith("Add connection") || b.getAttribute("aria-label") === "Add connection"))`;
    check(
      await run<boolean>(carol, `Boolean(document.querySelector('[data-pane="tab"] [data-testid="access-page"][data-perm="nats.read"]')) && !__mc.has("Add a NATS connection") && ${addButtons}.length > 0 && ${addButtons}.every((b) => b.dataset.denied === "nats.read")`),
      "the locked tool's workspace shows why it is locked, and Add connection is off with the reason",
    );
    check(!(await run<boolean>(carol, `__mc.has("Could not read the profiles")`)), "Carol's shell reads the profiles: no Could not read the profiles toast");
    await shot(carol, "carol-locked-tool");

    // --- 3. A shared profile with a secret ---------------------------------------------------
    await escape(alice);
    await cdp.sleep(300);
    await tool(alice, "Temporal");
    must(await until(alice, `__mc.button("Add connection")`, 10_000), "Alice's Temporal pane");
    await run(alice, `__mc.click(__mc.button("Add connection"))`);
    must(await until(alice, field("Name"), 10_000), "the profile sheet");
    await run(alice, `__mc.type(${field("Name")}, ${JSON.stringify(SHARED)})`);
    await run(alice, `__mc.type(${field("Namespace")}, "lab")`);
    await run(alice, `__mc.click([...document.querySelectorAll("label")].find((l) => l.checkVisibility() && l.textContent.trim() === "Codec server")?.querySelector("button, [role=radio]"))`);
    must(await until(alice, field("Authorization header"), 10_000), "the codec's fields");
    await run(alice, `__mc.type(${field("Endpoint")}, ${JSON.stringify(codec.endpoint)})`);
    await run(alice, `__mc.type(${field("Authorization header")}, ${JSON.stringify(codec.authorization)})`);
    check((await codecState(alice)) === "unset", "a new profile's secret field says Not set");
    must(await until(alice, `document.querySelector('[data-testid="who-can-use"]')`, 5_000), "an administrator chooses who can use it");
    await run(alice, `__mc.click([...document.querySelectorAll('[data-testid="who-can-use"] label')].find((l) => l.textContent.includes("(shared)"))?.querySelector("button, [role=radio]"))`);
    check(await until(alice, `/Today that is \\d+ (person|people) whose roles? appl/.test(${text(`document.querySelector('[data-testid="audience"]')`)})`, 10_000), `the shared choice says who it reaches today (${await run<string>(alice, text(`document.querySelector('[data-testid="audience"]')`))})`);
    await run(alice, `document.querySelector('[data-testid="who-can-use"]').scrollIntoView()`);
    await shot(alice, "shared-profile-who-can-use");
    await run(alice, `__mc.click(__mc.button("Save"))`);
    must(await connect(alice, SHARED), `Alice connects with ${SHARED}`);
    must(await workflow(alice, SHARED, "encrypted-1"), "encrypted-1 opens");
    await inputTab(alice);
    check(await until(alice, `__mc.has(${JSON.stringify(DECODED)})`, 30_000), "the stored Authorization header decodes encrypted-1's input through the lab's codec");
    await shot(alice, "secret-decodes");
    check(!(await leaks(alice)), "no page shows the codec header or a password");

    await temporalPane(alice);
    must(await edit(alice, SHARED), `the sheet of ${SHARED} opens`);
    check((await codecState(alice)) === "set" && (await run<boolean>(alice, `${text(`document.querySelector('[data-secret="codecAuthorization"]')`)}.includes("Set by you on")`)), "the stored secret shows Set, by you and when, never its value");
    check(!(await leaks(alice)), "the sheet holds no value of the secret");
    await shot(alice, "secret-set");
    // Replace it with a wrong one: the payloads stay as stored.
    await run(alice, `__mc.click(__mc.button("Replace the authorization header"))`);
    must(await until(alice, `document.querySelector('[data-secret="codecAuthorization"][data-state="replacing"] input')`, 5_000), "Replace opens an empty field");
    await run(alice, `__mc.type(document.querySelector('[data-secret="codecAuthorization"] input'), "Bearer not-the-lab-token")`);
    await shot(alice, "secret-replace");
    await run(alice, `__mc.click(__mc.button("Save"))`);
    await until(alice, `!document.querySelector('[data-secret="codecAuthorization"]')`, 10_000);
    must(await connect(alice, SHARED), `${SHARED} connects again`);
    must(await workflow(alice, SHARED, "encrypted-1"), "encrypted-1 opens again");
    await inputTab(alice);
    check(await until(alice, `__mc.has("binary/encrypted") && !__mc.has(${JSON.stringify(DECODED)})`, 30_000), "with the wrong header the payloads stay as stored, encrypted");
    await shot(alice, "secret-replaced-wrong");
    // Remove it.
    await temporalPane(alice);
    must(await edit(alice, SHARED), `the sheet of ${SHARED} opens again`);
    await run(alice, press(shown("Remove the authorization header")));
    must(await until(alice, `[...document.querySelectorAll("[role=dialog] button, [data-side] button")].some((b) => b.checkVisibility() && b.textContent.trim() === "Remove" && !b.getAttribute("aria-label"))`, 5_000), "Remove asks first");
    await run(alice, `[...document.querySelectorAll("button")].find((b) => b.checkVisibility() && b.textContent.trim() === "Remove" && !b.getAttribute("aria-label")).click()`);
    check(await until(alice, `document.querySelector('[data-secret="codecAuthorization"]')?.dataset.state === "removed" && __mc.has("Removed when you save")`, 5_000), "the field says the secret goes when the sheet is saved");
    await shot(alice, "secret-remove");
    await run(alice, `__mc.click(__mc.button("Save"))`);
    await until(alice, `!document.querySelector('[data-secret="codecAuthorization"]')`, 10_000);
    must(await edit(alice, SHARED), `the sheet of ${SHARED} opens after the removal`);
    check((await codecState(alice)) === "unset", "after Save the secret is not set");
    await run(alice, `__mc.click(__mc.button("Cancel"))`);

    // --- 4. A viewer on the shared profile, and on a personal one ----------------------------
    await tool(bob, "Temporal");
    must(await connect(bob, SHARED), `Bob (viewer) connects with the shared ${SHARED}`);
    must(await workflow(bob, SHARED, "fulfilment-long-running"), "Bob opens the running workflow");
    await run(bob, press(shown("More actions")));
    must(await until(bob, shown("Terminate…"), 10_000), "the More actions menu");
    const denied = await run<{ disabled: boolean; title: string }>(bob, `(() => { const i = ${shown("Terminate…")}; return { disabled: i.getAttribute("aria-disabled") === "true" || i.hasAttribute("data-disabled"), title: i.getAttribute("title") ?? "" }; })()`);
    check(denied.disabled && /needs temporal\.destroy/.test(denied.title) && /viewer/.test(denied.title), `a viewer's Terminate is off with its reason (${denied.title})`);
    await shot(bob, "viewer-terminate-denied");
    await escape(bob);

    await temporalPane(bob);
    await run(bob, `__mc.click(__mc.button("Add connection"))`);
    must(await until(bob, field("Name"), 10_000), "Bob's profile sheet");
    check(!(await run<boolean>(bob, `Boolean(document.querySelector('[data-testid="who-can-use"]'))`)), "a viewer's new profile is personal: no Who can use it choice");
    await run(bob, `__mc.type(${field("Name")}, ${JSON.stringify(PERSONAL)})`);
    await run(bob, `__mc.type(${field("Namespace")}, "lab")`);
    await run(bob, `__mc.click(__mc.button("Save"))`);
    must(await connect(bob, PERSONAL), `Bob connects with his own ${PERSONAL}`);
    must(await workflow(bob, PERSONAL, "fulfilment-long-running"), "the running workflow through Bob's profile");
    await run(bob, press(shown("More actions")));
    must(await until(bob, shown("Terminate…"), 10_000), "the More actions menu");
    await run(bob, `${shown("Terminate…")}.click()`);
    must(await until(bob, `${field("Reason (required)")}`, 10_000), "Terminate asks for a reason");
    await run(bob, `__mc.type(${field("Reason (required)")}, "admin walk: the confirmation only")`);
    await run(bob, `[...document.querySelectorAll("[role=dialog] button, [role=alertdialog] button")].find((b) => b.checkVisibility() && b.textContent.trim() === "Terminate").click()`);
    const confirm = `[...document.querySelectorAll("[role=alertdialog]")].find((d) => d.checkVisibility() && d.querySelector('[aria-label="Confirmation"]'))`;
    check(await until(bob, confirm, 20_000), "the server asks Bob to confirm: type the name");
    const asked = await run<string>(bob, text(confirm));
    const flat = asked.replace(/\s+/g, " ");
    check(/Profile bob-temporal/.test(flat) && /Namespace lab/.test(flat) && /As bob@lab\.test/.test(flat) && /Type fulfilment-long-running to confirm/.test(flat), `the confirmation names the profile, the namespace, the account and the workflow to type (${flat.slice(0, 400)})`);
    await shot(bob, "personal-destroy-confirmation");
    await run(bob, `[...${confirm}.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel").click()`);
    check(await until(bob, `!(${confirm}) && __mc.has("approval required")`, 10_000), "Cancel sends nothing: the Terminate dialog keeps the server's refusal");
    await run(bob, `[...document.querySelectorAll("[role=dialog] button")].find((b) => b.checkVisibility() && b.textContent.trim() === "Cancel").click()`);

    // Carol (Temporal readers: temporal.read, no profiles.personal) lists the shared profile her
    // role covers and connects with it (TSK-172, DOC-25 §3.4.7).
    await temporalPane(carol);
    must(await connect(carol, SHARED), `Carol (${ROLE}) connects with the shared ${SHARED}`);
    // The pane listed it, so the profiles were read: no toast says otherwise.
    check(!(await run<boolean>(carol, `__mc.has("Could not read the profiles")`)), "Carol's Temporal pane read the profiles with no Could not read the profiles toast");
    must(await workflow(carol, SHARED, "fulfilment-long-running"), "Carol opens the running workflow through it");
    await shot(carol, "carol-shared-profile");

    // --- 5. Taking a role away and turning an account off end their sessions -----------------
    await temporalPane(alice);
    must(await accountMenu(alice), "Alice's menu again");
    await run(alice, `${shown("Users and roles")}.click()`);
    must(await until(alice, `[...document.querySelectorAll("[data-person]")].some((b) => b.textContent.includes("Carol"))`, 20_000), "Users and roles again");
    await run(alice, `[...document.querySelectorAll("[data-person]")].find((b) => b.textContent.includes("Carol")).click()`);
    must(await until(alice, `[...document.querySelectorAll("button")].some((b) => (b.getAttribute("aria-label") || "").startsWith("Remove ${ROLE_ID} on"))`, 10_000), "Carol's role can be taken away");
    await run(alice, `[...document.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "").startsWith("Remove ${ROLE_ID} on")).click()`);
    check(await until(alice, `__mc.has("Role taken away; their sessions ended")`, 10_000), "taking the role away says her sessions ended");
    check(await ended(carol), "Carol's page shows Your session ended");
    check(await run<boolean>(carol, `document.querySelector('[aria-label="Title area"]') !== null`), "Carol's shell stays under the dialog");
    await shot(carol, "carol-session-ended");

    await run(alice, `[...document.querySelectorAll("[data-person]")].find((b) => b.textContent.includes("Bob")).click()`);
    must(await until(alice, shown("Turn off account"), 10_000), "Bob's account can be turned off");
    await run(alice, `${shown("Turn off account")}.click()`);
    must(await until(alice, `[...document.querySelectorAll("[role=alertdialog]")].some((d) => d.textContent.includes("Turn off Bob"))`, 5_000), "turning off asks first");
    await shot(alice, "turn-off-account");
    await run(alice, `[...document.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent.trim() === "Turn off account").click()`);
    check(await until(alice, `__mc.has("Account turned off")`, 10_000), "Bob's account is off");
    check(await ended(bob), "Bob's page shows Your session ended");
    await shot(bob, "bob-session-ended");
    await choose(alice, dialog("admin-users"), "Status", "Status: off");
    check(await until(alice, `${text(dialog("admin-users"))}.includes("Bob Viewer") && ${text(dialog("admin-users"))}.includes("Off")`, 10_000), "Status: off lists Bob as Off");
    await shot(alice, "users-off");
    await escape(alice);
    await cdp.sleep(300);

    // --- 6. The audit log --------------------------------------------------------------------
    must(await accountMenu(alice), "Alice's menu for the Audit log");
    await run(alice, `${shown("Audit log")}.click()`);
    must(await until(alice, `${dialog("audit-log")} && document.querySelectorAll('[data-testid="audit-log"] tr[data-seq]').length > 0`, 20_000), "the Audit log lists entries");
    check(await until(alice, `/\\d+ records/.test(${text(dialog("audit-status"))})`, 10_000), `the chain's status line (${await run<string>(alice, text(dialog("audit-status")))})`);
    await run(alice, `__mc.type(document.querySelector('[data-testid="audit-log"] input[aria-label="Who"]'), ${JSON.stringify(bobId)})`);
    check(
      await until(alice, `(() => { const rows = [...document.querySelectorAll('[data-testid="audit-log"] tr[data-seq]')]; return rows.length > 0 && rows.every((r) => r.cells[1].textContent === ${JSON.stringify(bobId)}); })()`, 15_000),
      "filtered by who (Bob's user id): only Bob's entries",
    );
    check(await run<boolean>(alice, `[...document.querySelectorAll('[data-testid="audit-log"] tr[data-seq]')].some((r) => r.textContent.includes("temporal.workflows.terminate"))`), "Bob's terminate (asked, then confirmed never) is in the log");
    await shot(alice, "audit-filtered");
    await run(alice, `document.querySelector('[data-testid="audit-log"] tr[data-seq] button').click()`);
    check(await until(alice, `${text(dialog("audit-detail"))}.includes("Input digest") && ${text(dialog("audit-detail"))}.includes("Previous hash")`, 10_000), "an entry shows its digests and hashes");
    check(!(await leaks(alice)), "the log shows no secret");
    await shot(alice, "audit-entry");
    await run(alice, `${shown("Verify chain")}.click()`);
    check(await until(alice, `${dialog("audit-verdict")} && !/broken|fail/i.test(${text(dialog("audit-verdict"))})`, 30_000), `Verify chain: the chain holds (${await run<string>(alice, text(dialog("audit-verdict")))})`);
    await shot(alice, "audit-verified");
    await run(alice, `${shown("Export this view as CSV")}.click()`);
    const csv = await (async () => {
      for (let i = 0; i < 100; i++) {
        const f = readdirSync(downloads).find((x) => /^audit-.*\.csv$/.test(x));
        if (f) return readFileSync(join(downloads, f), "utf8");
        await cdp.sleep(200);
      }
      return null;
    })();
    const lines = csv?.trim().split("\n") ?? [];
    check(csv !== null && lines.length > 1 && lines.slice(1).every((l) => l.includes(bobId)), `Export saves the filtered view as CSV (${lines.length - 1} rows, all Bob's)`);
    await escape(alice);
    await cdp.sleep(300);

    // --- 7. A profile kept in the browser moves to the server --------------------------------
    // Seeded into the app's own database (the walk never reads it back), then the page reloads.
    const record = {
      id: `01TSK158${Date.now().toString(36).toUpperCase()}`,
      tool: "temporal",
      version: 1,
      name: MOVED,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fields: { address: "127.0.0.1:7233", namespace: "lab", tls: { enabled: false }, pageSize: 50, codec: { enabled: true, endpoint: codec.endpoint, namespaces: "", caPem: "", sendNamespace: false, encodeInputs: false } },
      secrets: { codecAuthorization: codec.authorization },
      extras: { savedQueries: [], schemas: [], mappings: [] },
    };
    const seeded = await alice.evaluate<string>(`Promise.race([
      new Promise((resolve) => {
        const open = indexedDB.open("mightyconsole");
        open.onerror = () => resolve("open failed");
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("profiles", "readwrite");
          tx.objectStore("profiles").put(${JSON.stringify(record)});
          tx.oncomplete = () => { db.close(); resolve("ok"); };
          tx.onerror = () => { db.close(); resolve("put failed"); };
        };
      }),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 10000)),
    ])`);
    must(seeded === "ok", `a browser profile is seeded in IndexedDB (${seeded})`);
    await alice.navigate(`${ORIGIN}/temporal`);
    must(await until(alice, `__mc.has("still saved only in this browser")`, 20_000), "the bar offers to move the browser's profile");
    await shot(alice, "move-offer");
    await run(alice, `__mc.click(__mc.button("Move my profiles…"))`);
    must(await until(alice, dialog("move-dialog"), 10_000), "Move my profiles opens at the backup");
    await shot(alice, "move-backup");
    await run(alice, `${shown("Save backup file…")}.click()`);
    must(await until(alice, `document.querySelector('[aria-label="Profiles to move"]')`, 10_000), "after the backup: the profiles to move");
    check(await run<boolean>(alice, `Boolean(document.querySelector('[aria-label="Move ${MOVED} as"]'))`), "an administrator may move it as personal or shared");
    await shot(alice, "move-choose");
    await run(alice, `${shown("Move 1 profile")}.click()`);
    check(await until(alice, dialog("move-done"), 30_000), "the move finishes");
    await shot(alice, "move-done");
    const backup = readdirSync(downloads).filter((x) => !/^audit-/.test(x));
    check(backup.length === 1, `the backup was saved before the move (${backup.join(", ")}; deleted unread)`);
    for (const f of backup) rmSync(join(downloads, f), { force: true });
    await run(alice, `${shown("Done")}.click()`);
    check(await until(alice, `!__mc.has("still saved only in this browser")`, 10_000), "the bar is gone: the browser keeps no profile");
    must(await connect(alice, MOVED), `the moved ${MOVED} connects from the server`);
    must(await workflow(alice, MOVED, "encrypted-1"), "encrypted-1 through the moved profile");
    await inputTab(alice);
    check(await until(alice, `__mc.has(${JSON.stringify(DECODED)})`, 30_000), "the moved secret decodes encrypted-1: it reached the server");
    await shot(alice, "moved-profile-decodes");
    await temporalPane(alice);
    must(await edit(alice, MOVED), `the sheet of ${MOVED}`);
    check((await codecState(alice)) === "set" && !(await leaks(alice)), "the moved secret shows Set, without its value");
    await shot(alice, "moved-secret-set");
  } catch (error) {
    const message = String((error as Error).message);
    if (!message.startsWith("stopped: ")) failures.push(message);
    console.error(`admin walk: ${message}`);
    // What each person's page showed when the walk stopped.
    for (const [name, page] of pages) await page.screenshot(join(shots, `admin-failure-${name}.png`)).catch(() => undefined);
  } finally {
    for (const b of browsers) b.kill();
    child?.kill();
    await cdp.sleep(500);
    // The browsers may still be writing their profiles for a moment.
    rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
  writeFileSync(join(evidence, "admin-walk.txt"), failures.length === 0 ? "ok\n" : `${failures.join("\n")}\n`);
  console.log(failures.length === 0 ? "admin walk: ok" : `admin walk: ${failures.length} failed`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [server, evidence] = process.argv.slice(2);
  if (!server || !evidence) {
    console.error("usage: node admin-walk.mts SERVER EVIDENCE_DIR");
    process.exit(2);
  }
  main(resolve(server), resolve(evidence)).then((code) => process.exit(code));
}
