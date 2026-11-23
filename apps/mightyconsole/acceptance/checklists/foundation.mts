// TSK-79, the foundation (Mightyconsole spec section 18). Every item is wired to the tests that
// prove it, plus a walk through the shell in a browser with screenshots.
import { browser, cargo, type Checklist, command, manual, server, vitest } from "../checklist.mts";

const LAB_ALL = ["nats", "kafka", "k8s", "temporal", "docker", "langgraph"];

export default {
  id: "foundation",
  task: "TSK-79",
  title: "Foundation",
  builtWhen: "apps/mightyconsole/server/src/tools/echo",
  lab: LAB_ALL,
  items: [
    {
      id: "layout",
      text: "apps/mightyconsole/{server,rpc-gen,ui,lab} exist; every Cargo.toml and package.json says AGPL-3.0-only; the AGPL text; deny.toml exceptions; check-licenses and cargo deny pass; nothing permissive depends on apps/mightyconsole.",
      checks: [
        command("check-licenses", ["node", "scripts/check-licenses.mjs"]),
        command("cargo deny check licenses bans sources", ["cargo", "deny", "check", "licenses", "bans", "sources"], { requires: ["cargo-deny"] }),
      ],
    },
    {
      id: "listen",
      text: "With no flags the server listens on 127.0.0.1:7443 only, makes its certificate once and reuses it, prints the URL and the fingerprint; another address prints the exposure warning.",
      checks: [
        cargo("cli::tests::no_flags_means_loopback_7443_and_a_generated_certificate"),
        cargo("tls::tests::the_certificate_is_made_once_and_reused"),
        server("loopback: the address, the fingerprint and the URL", ["--listen", "127.0.0.1:0"], [/listening on 127\.0\.0\.1:\d+/, /certificate SHA-256 (?:[0-9A-F]{2}:){31}[0-9A-F]{2}/, /open https:\/\/localhost:\d+\//]),
        server("another address: the exposure warning", ["--listen", "0.0.0.0:0"], [/WARNING: listening beyond loopback/]),
      ],
    },
    {
      id: "session",
      text: "Loading the page through an allowed Host gives a session; an upgrade with another Origin or Host is rejected; a second browser tab gets its own session and cannot use the first one's connId.",
      checks: [
        cargo("the_page_gives_a_session_with_its_headers"),
        cargo("the_upgrade_needs_the_host_the_origin_the_cookie_and_the_token"),
        cargo("a_handle_belongs_to_the_connection_that_opened_it"),
      ],
    },
    {
      id: "codegen",
      text: "mightyconsole-rpc-gen writes api.ts and api.manifest.json; the drift test fails when stale; app.info, app.events and term.* exist with the kinds and risks of 2.7; every procedure is Hidden.",
      checks: [cargo("committed_artifacts_match_the_router"), cargo("the_procedures_of_the_spec")],
    },
    {
      id: "tool-contract",
      text: "The tool contract works with a sample tool: handles released by disconnect and by the idle sweep (fake clock), StreamProgress sent, NotFound for a foreign or closed connId.",
      checks: [
        cargo("closing_the_websocket_releases_its_handles"),
        cargo("the_idle_sweep_releases_unused_handles_but_not_streaming_ones"),
        cargo("a_stream_follows_the_credits_and_reports_progress"),
        cargo("a_terminal_echoes_its_input_and_reports_its_exit"),
      ],
    },
    {
      id: "profiles",
      text: "Profiles: create, edit, delete in IndexedDB; export without and with secrets; import with Replace, Keep both, Skip; migration from version 0 with the backup kept; a newer version read-only; the in-memory fallback warns.",
      checks: [vitest("test/profiles.test.ts"), vitest("test/shell.test.tsx", "profiles through the shell")],
    },
    {
      id: "shell",
      text: "The shell matches TSK-64's: tool rail, connection list, tabs restored after a reload, command bar, status bar, palette with every action and binding, every row of 3.4, the states of 3.5, Settings and About; axe passes in light, dark, compact and comfortable. TSK-101 and TSK-105 (DOC-21 §3.7): URLs per place and back and forward per tab; the navigation row (Back's list, crumbs from the routes with siblings and overflow, the link and Copy link); links in the same tab, Mod+click or middle-click for another; a sheet with changes asks before leaving (useBlocker); the missing-profile page.",
      checks: [
        vitest("test/shell.test.tsx", "keyboard, palette, dialogs"),
        vitest("test/shell.test.tsx", "accessibility"),
        vitest("test/shell.test.tsx", "connections, tabs and live views"),
        browser("the shell in a browser, light and dark, with a live tab", async ({ page, origin, until, run, shot }) => {
          await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
          await page.navigate(`${origin}/`);
          // The navigation opens on its first tool (TSK-91); the foundation's checks use Echo.
          await until(`__mc.button("Echo")`, "the tool navigation");
          await run(`__mc.click(__mc.button("Echo"))`);
          await until(`__mc.has("No Echo connections yet") || __mc.item("acceptance")`, "the connection list");
          await until(`__mc.has(${JSON.stringify(origin)})`, "app.info in the status bar");
          await shot("empty shell, light");
          if (!(await run<boolean>(`Boolean(__mc.item("acceptance"))`))) {
            await run(`__mc.click(__mc.button("Add connection"))`);
            await until(`__mc.field("Name")`, "the profile sheet");
            await shot("profile sheet");
            await run(`__mc.type(__mc.field("Name"), "acceptance")`);
            await run(`__mc.click(__mc.button("Save"))`);
            await until(`__mc.item("acceptance")`, "the saved profile");
          }
          await run(`__mc.dblclick(__mc.item("acceptance"))`);
          await until(`__mc.item("Ticks")`, "echo.connect and the resource tree");
          await run(`__mc.dblclick(__mc.item("Ticks"))`);
          await until(`__mc.button("Start")`, "the Ticks tab");
          await run(`__mc.click(__mc.button("Start"))`);
          await until(`__mc.has("tick 3")`, "ticks streamed with credits");
          await shot("live tab, light");
          await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
          await until(`document.documentElement.dataset.theme === "dark"`, "the dark theme");
          await shot("live tab, dark");
          await page.navigate(`${origin}/`);
          await until(`[...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.includes("Ticks · acceptance"))`, "the tab restored after a reload");
          await shot("after a reload, dark");
          await page.send("Emulation.setEmulatedMedia", { features: [] });
        }),
        vitest("test/routing.test.tsx"),
        vitest("test/nav-row.test.tsx"),
        command("the Breadcrumb's overflow in packages/ui", ["pnpm", "--filter", "@byterygon/ui", "exec", "vitest", "run", "src/components/breadcrumb"]),
        command("browser-check: the row, Back's list, siblings, the fold, the blocker and the missing-profile page", ["node", "scripts/browser-check.ts"], {
          cwd: "apps/mightyconsole/ui",
          env: { MIGHTYCONSOLE_SERVER: "{server}", BYTERYGON_REQUIRE_BROWSER: "1", MIGHTYCONSOLE_FAILURE_SHOTS: "{evidence}/screenshots" },
        }),
      ],
    },
    {
      id: "tab-groups",
      text: "TSK-111 (DOC-21 §3.2.1): tabs grouped by tool, the focused tab's group open and the others folded to chips that open on their last focused tab, groups and their order kept after a reload (the tabs document version 3); a single click in the tree opens one preview tab per tool that the next click replaces, kept by a double click, Ctrl or Cmd + click, Keep open or state to lose; the tree follows the focused tab (its tool, its ancestors open, its node selected, focus left where it was), a tool picked by hand holding until the next tab focus.",
      checks: [
        vitest("test/tab-groups.test.tsx"),
        vitest("test/preview-tabs.test.tsx"),
        vitest("test/tree-follows.test.tsx"),
        command("Tabs (keepVisible, TabsLabel) and Tree (selection details, scrollTo) in packages/ui", ["pnpm", "--filter", "@byterygon/ui", "exec", "vitest", "run", "src/components/tabs", "src/components/tree"]),
        browser("groups, a preview tab and the tree following the tab", async ({ page, origin, until, run, shot }) => {
          const selected = (title: string) => `[...document.querySelectorAll("[role=tab][aria-selected=true]")].some((t) => t.textContent.includes(${JSON.stringify(title)}))`;
          const rowSelected = (label: string) => `[...document.querySelectorAll("[role=treeitem][aria-selected=true]")].some((r) => r.textContent.includes(${JSON.stringify(label)}))`;
          const navOn = (tool: string) => `document.querySelector("[data-nav-item][aria-current=page]")?.dataset.tool === ${JSON.stringify(tool)}`;
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
          await until(`__mc.item("Ping")`, "the Echo tree");
          // A single click: the preview tab, in italics, with its note.
          await run(`__mc.click(__mc.item("Ping"))`);
          await until(`${selected("Ping")} && document.querySelector("[role=tab][data-preview]") && __mc.has("Preview tab.")`, "the preview tab");
          await shot("a preview tab");
          await run(`__mc.click(__mc.item("Composer"))`);
          await until(`${selected("Composer")} && document.querySelectorAll("[role=tab][data-preview]").length === 1 && ![...document.querySelectorAll("[role=tab]")].some((t) => t.textContent.includes("Ping"))`, "the preview replaced");
          await run(`__mc.dblclick(__mc.item("Composer"))`);
          await until(`${selected("Composer")} && !document.querySelector("[role=tab][data-preview]")`, "the preview kept by a double click");
          // A second tool's tab through its URL: two groups, the tree on that tool.
          await page.navigate(`${origin}/langgraph/acceptance-lg/threads`);
          await until(`__mc.has("This link needs a LangGraph profile named acceptance-lg") || ${selected("Threads")}`, "the LangGraph link");
          if (await run<boolean>(`Boolean(__mc.button("Create profile acceptance-lg"))`)) {
            await run(`__mc.click(__mc.button("Create profile acceptance-lg"))`);
            await until(`__mc.button("Save")`, "the LangGraph profile sheet");
            await run(`__mc.click(__mc.button("Save"))`);
          }
          await until(`${selected("Threads")} && ${navOn("langgraph")}`, "the LangGraph tab and its tool in the navigation");
          await shot("two groups, the tree on LangGraph");
          await run(`__mc.click([...document.querySelectorAll("[role=tablist][aria-label=Tabs] [role=tab]")].find((t) => t.querySelector(".sr-only")?.textContent === "Echo"))`);
          await until(`${navOn("echo")} && ${rowSelected("Composer")}`, "the Echo chip: Echo's tree with Composer selected");
          await shot("the tree back on Echo");
        }),
      ],
    },
    {
      id: "server-lost",
      text: "Losing the server shows the overlay, and after it returns the UI reconnects and calls connect again for connected profiles.",
      checks: [vitest("test/shell.test.tsx", "losing the server shows the overlay"), vitest("test/units.test.ts", "supervisor")],
    },
    {
      id: "csp-offline",
      text: "The UI is served with the CSP of 2.3; the server and the UI smoke make no outbound connection (CI network namespace).",
      checks: [
        cargo("the_ui_directory_is_served_with_the_session_in_its_page"),
        command("browser-check: CSP, session and no request outside the server", ["node", "scripts/browser-check.ts"], {
          cwd: "apps/mightyconsole/ui",
          env: { MIGHTYCONSOLE_SERVER: "{server}", BYTERYGON_REQUIRE_BROWSER: "1", MIGHTYCONSOLE_FAILURE_SHOTS: "{evidence}/screenshots" },
        }),
        manual("the same check with no network at all: the CI step \"Mightyconsole in Chrome (network disconnected)\" of the PR"),
      ],
    },
    {
      id: "lab",
      text: "lab up starts every service healthy and seeded with one command; images pinned by digest; every port on 127.0.0.1; generated credentials only, nothing secret committed; the LangGraph check result in section 14.",
      lab: true,
      checks: [
        command("lab check (every service up and seeded)", ["node", "apps/mightyconsole/lab/lab.mts", "check", ...LAB_ALL]),
        command("lab images check", ["node", "apps/mightyconsole/lab/lab.mts", "images", "check"]),
        vitest("test/lab.test.ts"),
      ],
    },
    {
      id: "ci",
      text: "CI builds and tests it all; green.",
      checks: [manual("the CI run of the task's last PR is green (link it)")],
    },
  ],
} satisfies Checklist;
