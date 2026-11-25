// TSK-81, Docker over SSH (Mightyconsole spec section 18, against the lab's docker-host). The
// server's checks: tests/docker.rs against a stand-in SSH server, tests/docker_lab.rs (feature
// lab-tests) against the lab's sshd and Docker. The UI's: test/docker.test.tsx and
// test/docker-containers.test.tsx (jsdom), and a walk in the browser against the lab. Batch 1
// wired host-key and errors, batch 2b the containers and the logs, batch 2c stats and exec, batch 3
// the images, volumes and networks (test/docker-resources.test.tsx), batch 4 the approved extras
// (test/docker-host.test.tsx: disk usage and events on the Host page, Processes, the tree's
// counts; test/docker-project.test.tsx: a Compose project's logs merged; test/docker-files.test.tsx:
// the read-only Files). Run `pnpm --filter @byterygon/mightyconsole acceptance docker --lab-up --strict`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Checklist, browser, cargo, command, manual, vitest, confirmDestroy } from "../checklist.mts";

const GENERATED = process.env["MIGHTYCONSOLE_LAB_GENERATED"] ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "lab", ".generated");

/**
 * Adds the lab's Docker host as the profile `lab` (its private key read from the lab's generated
 * files, never logged), trusts its key on first use and waits for the resource tree.
 */
async function labTree({ lab, until, run, shot }: Pick<BrowserContext, "lab" | "until" | "run" | "shot">): Promise<void> {
  const docker = (lab?.["docker"] ?? null) as { host: string; port: number; user: string; keyFile: string } | null;
  if (!docker) throw new Error("the lab's docker credentials are missing (run `lab up docker`)");
  await until(`__mc.button("Docker")`, "the tool rail");
  await run(`__mc.click(__mc.button("Docker"))`);
  await until(`__mc.has("No Docker connections yet") || __mc.item("lab")`, "the Docker connection list");
  if (!(await run<boolean>(`Boolean(__mc.item("lab"))`))) {
    await run(`__mc.click(__mc.button("Add connection"))`);
    await until(`__mc.field("Name") && __mc.field("Private key")`, "the profile sheet");
    const key = readFileSync(join(GENERATED, docker.keyFile), "utf8");
    for (const [label, value] of [["Name", "lab"], ["Host", docker.host], ["Port", String(docker.port)], ["Username", docker.user]] as const) {
      await run(`__mc.type(__mc.field(${JSON.stringify(label)}), ${JSON.stringify(value)})`);
    }
    // "Private key" also names a radio of Authentication: the key's text area by its tag.
    await run(`__mc.type(document.querySelector("[role=dialog] textarea"), ${JSON.stringify(key)})`);
    await shot("profile sheet");
    await run(`__mc.click([...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Save"))`);
    try {
      await until(`__mc.item("lab")`, "the saved profile", 8_000);
    } catch (e) {
      await shot("profile sheet after Save");
      const errors = await run<string>(`[...document.querySelectorAll("[role=dialog] [data-slot=field-error], [role=dialog] [role=alert]")].map((el) => el.textContent.trim()).join("; ")`);
      throw new Error(`${(e as Error).message}${errors ? `: ${errors}` : ""}`);
    }
  }
  await run(`__mc.dblclick(__mc.item("lab"))`);
  await until(`__mc.has("Trust lab?") || __mc.item("Containers")`, "the trust dialog or the tree");
  if (await run<boolean>(`__mc.has("Trust lab?")`)) {
    await shot("host key on first use");
    await run(`__mc.click(__mc.button("Trust and connect"))`);
  }
  await until(`__mc.item("Containers")`, "the resource tree");
}

/** The visible tab panel's buttons whose text is `label`. */
const visible = (label: string) => `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && b.offsetParent !== null)`;

const lab = (filter: string) => cargo(filter, { features: ["lab-tests"] });

/** The ssh-agent login against the lab: an agent of its own (a short socket path), holding the lab key only. */
const AGENT = [
  "set -e",
  'sock="/tmp/mc-agent-$$.sock"',
  'eval "$(ssh-agent -a "$sock" -s)" >/dev/null',
  'trap \'kill "$SSH_AGENT_PID"\' EXIT',
  'test "$SSH_AUTH_SOCK" = "$sock"',
  "ssh-add apps/mightyconsole/lab/.generated/ssh/lab_ed25519",
  "MIGHTYCONSOLE_LAB_DOCKER_AGENT=1 cargo test -p mightyconsole-server --features lab-tests --test docker_lab -- lab_trust_on_first_use_then_every_login_method",
].join("\n");

export default {
  id: "docker",
  task: "TSK-81",
  title: "Docker over SSH",
  builtWhen: "apps/mightyconsole/server/src/tools/docker",
  lab: ["docker"],
  items: [
    {
      id: "stored-profile",
      text: "(TSK-139, DOC-25 §3.4.7) A profile stored on the server connects by reference: the server opens its secrets, which the browser never holds; Test connection uses the draft's secrets for that call only, and the stored ones only while the draft keeps its target.",
      lab: true,
      checks: [
        lab("a_stored_profile_logs_in_with_its_secrets_and_a_draft_keeps_its_target"),
      ],
    },
    {
      id: "host-key",
      text: "First connect shows the host key fingerprint and connects only after Trust; a changed key is refused until replaced; private key, key with passphrase, password and agent all work.",
      lab: true,
      checks: [
        cargo("an_unknown_host_key_stops_the_connection_before_any_login"),
        cargo("passwords_and_keys_are_checked_and_never_echoed"),
        command("lab: trust on first use, a changed key, key, key with passphrase, password and ssh-agent", ["sh", "-c", AGENT], { requires: ["ssh-agent", "ssh-add"] }),
        vitest("test/docker.test.tsx", "trust on first use in the shell"),
        vitest("test/docker.test.tsx", "host key dialog"),
      ],
    },
    {
      id: "containers",
      text: "Containers list grouped by Compose project and updated through events; start, stop, restart; remove with confirmation and options.",
      lab: true,
      checks: [
        cargo("containers_are_listed_acted_on_and_their_logs_split_by_stream"),
        lab("lab_containers_their_logs_and_the_events"),
        vitest("test/docker-containers.test.tsx", "Containers"),
        vitest("test/docker-containers.test.tsx", "helpers"),
        browser("the lab's containers by project, a container's overview", async ({ page, origin, lab: credentials, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ lab: credentials, until, run, shot });
          await run(`__mc.dblclick(__mc.item("Containers"))`);
          await until(`location.pathname === "/docker/lab/containers" && ${visible("shop-web-1")} && __mc.has("No project")`, "the containers grouped by project");
          await until(`__mc.has("Updated from docker.events")`, "the live footer");
          await shot("containers by project");
          await run(`__mc.click(${visible("shop-worker-1")})`);
          await until(`location.pathname === "/docker/lab/containers/shop-worker-1/overview" && __mc.has("Environment")`, "the worker's overview");
          await shot("container overview");
        }),
        manual("Start, Stop, Restart and Remove on the lab's containers from the UI (Remove on a container made for it: `docker run --name scratch busybox:1.37 true` on the docker-host)"),
      ],
    },
    {
      id: "logs-exec",
      text: "Logs with stdout and stderr separated (and the TTY container); live stats; exec terminal with resize and exit code.",
      lab: true,
      checks: [
        vitest("test/docker-containers.test.tsx", "a container"),
        browser("the worker's logs, stdout and stderr apart, followed", async ({ page, origin, lab: credentials, until, run, shot }) => {
          await page.navigate(`${origin}/`);
          await labTree({ lab: credentials, until, run, shot });
          await run(`__mc.dblclick(__mc.item("Containers"))`);
          await until(`${visible("shop-worker-1")}`, "the containers");
          await run(`__mc.click(${visible("shop-worker-1")})`);
          await until(`__mc.has("Environment")`, "the worker's overview");
          await run(`__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "Logs" && t.offsetParent !== null))`);
          await until(`location.pathname.endsWith("/shop-worker-1/logs") && __mc.has("worker tick") && __mc.has("warning")`, "the worker's stdout and stderr");
          await shot("logs, stdout and stderr");
          // The newest tick shown (the viewer keeps the newest line in view while following).
          const ticks = `Math.max(0, ...[...document.querySelectorAll("[role=log] *")].map((el) => /^worker tick (\\d+)$/.exec(el.childElementCount === 0 ? el.textContent.trim() : "")).filter(Boolean).map((m) => Number(m[1])))`;
          const before = await run<number>(ticks);
          await until(`${ticks} > ${before}`, "a followed line (the worker writes every 2 s)", 10_000);
          await run(`__mc.click([...document.querySelectorAll("[role=tabpanel]:not([hidden]) button")].find((b) => b.textContent.trim() === "stderr" && b.offsetParent !== null))`);
          await until(`!__mc.has("worker tick") && __mc.has("warning")`, "stderr only");
          await shot("logs, stderr only");
        }),
        cargo("an_exec_terminal_takes_input_resizes_and_ends_with_the_exit_code"),
        cargo("stats_come_as_samples_and_a_stopped_container_has_none"),
        lab("lab_an_exec_shell_and_live_stats"),
        vitest("test/docker-containers.test.tsx", "stats and the terminal"),
        browser("the worker's stats, then a shell in it to its exit code", async ({ page, origin, lab: credentials, until, run, shot }) => {
          const tab = (label: string) => `__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === ${JSON.stringify(label)} && t.offsetParent !== null))`;
          const rows = `([...document.querySelectorAll("[role=tabpanel]:not([hidden]) .xterm-rows")].map((r) => r.textContent).join("\\n"))`;
          /** Types a line into xterm.js as a keyboard does (its hidden text area, then Enter). */
          const typeLine = async (text: string) => {
            await run(`document.querySelector("[role=tabpanel]:not([hidden]) .xterm-helper-textarea").focus()`);
            await page.send("Input.insertText", { text });
            for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) });
          };
          await page.navigate(`${origin}/`);
          await labTree({ lab: credentials, until, run, shot });
          await run(`__mc.dblclick(__mc.item("Containers"))`);
          await until(`${visible("shop-worker-1")}`, "the containers");
          await run(`__mc.click(${visible("shop-worker-1")})`);
          await until(`__mc.has("Environment")`, "the worker's overview");
          await run(tab("Stats"));
          await until(`location.pathname.endsWith("/shop-worker-1/stats") && __mc.has("PIDs") && /of \\d+ CPUs?/.test(document.body.textContent)`, "the stat tiles");
          // A few samples, so the charts have lines.
          await until(`document.querySelectorAll("[role=tabpanel]:not([hidden]) [aria-label='Samples, newest first'] tbody tr").length > 0 || (${visible("Table")} && (__mc.click(${visible("Table")}), false))`, "the samples table", 10_000);
          await until(`document.querySelectorAll("[role=tabpanel]:not([hidden]) [aria-label='Samples, newest first'] tbody tr").length >= 3`, "three samples", 10_000);
          await shot("stats, samples");
          await run(`__mc.click(${visible("Table")})`);
          await until(`document.querySelector("[aria-label='CPU, last 5 minutes']")`, "the charts");
          await shot("stats, charts");
          await run(tab("Terminal"));
          await until(`location.pathname.endsWith("/shop-worker-1/terminal") && ${visible("Connect")}`, "the terminal's Connect");
          await run(`__mc.click(${visible("Connect")})`);
          await until(`${visible("Disconnect")} && ${rows}.includes("#")`, "sh's prompt (busybox has no bash)");
          await typeLine("echo hi-$((1+2))");
          await until(`${rows}.includes("hi-3")`, "the command's output");
          await typeLine("stty size");
          await until(`/\\d+ \\d+/.test(${rows}.split("stty size")[1] ?? "")`, "the TTY's size");
          await shot("terminal");
          await typeLine("exit 3");
          await until(`__mc.has("Exited with code 3") && ${rows}.includes("[exited with code 3]")`, "the exit code");
          await shot("terminal, exited");
        }),
      ],
    },
    {
      id: "resources",
      text: "Images, volumes and networks: list, inspect, remove with the in-use refusal; the host info.",
      lab: true,
      checks: [
        cargo("images_volumes_and_networks_show_what_uses_them_and_refusals_come_back_per_item"),
        lab("lab_images_volumes_and_networks_with_docker_s_refusals"),
        vitest("test/docker-resources.test.tsx", "images"),
        vitest("test/docker-resources.test.tsx", "volumes and networks"),
        // The walk removes lab-scratch and lab-scratch-net; the seed brings them back.
        command("lab: seed the docker host again (lab-scratch, lab-scratch-net)", ["node", "apps/mightyconsole/lab/lab.mts", "seed", "docker"]),
        browser("images, volumes and networks: in use refused, inspect, unused ones removed; the host", async ({ page, origin, lab: credentials, until, run, shot }) => {
          const row = (table: string, text: string) => `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) table[aria-label='${table}'] tbody tr")].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
          const inDialog = (label: string) => `[...document.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
          await page.navigate(`${origin}/`);
          await labTree({ lab: credentials, until, run, shot });

          // Images: busybox (pulled by digest) runs in tty and the shop: Remove is off, with why.
          await run(`__mc.dblclick(__mc.item("Images"))`);
          await until(`location.pathname === "/docker/lab/images"`, "the Images tab");
          try {
            await until(`${row("Images", "busybox")}`, "busybox in the images");
          } catch (e) {
            await shot("images, not found");
            throw new Error(`${(e as Error).message}: ${await run<string>(`[...document.querySelectorAll("[role=tabpanel]:not([hidden])")].map((p) => p.textContent.slice(0, 600)).join(" | ") || document.querySelector("main")?.textContent.slice(0, 600)`)}`);
          }
          // Used by names two, the rest in its title.
          await until(`${row("Images", "busybox")}.innerHTML.includes("tty (running)")`, "busybox used by tty");
          await shot("images");
          await run(`__mc.click(${row("Images", "busybox")}.querySelector("button[aria-label^='Actions for']"))`);
          await until(`[...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.includes("Remove"))?.getAttribute("aria-disabled") === "true" && __mc.has("Docker refuses to remove an image a running container uses")`, "Remove off for an image in use");
          await shot("images, in-use refusal");
          await run(`__mc.click([...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.includes("Inspect")))`);
          await until(`__mc.has("docker image inspect") && document.querySelector("[role=dialog] [aria-label^='docker image inspect']")`, "the image's inspect");
          await shot("image inspect");
          await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
          await until(`!document.querySelector("[role=dialog]")`, "the sheet closed");

          // Volumes: lab-cache is the stopped container's, so Remove is off; lab-scratch goes by its typed name.
          await run(`__mc.dblclick(__mc.item("Volumes"))`);
          await until(`location.pathname === "/docker/lab/volumes" && ${row("Volumes", "lab-scratch")}`, "the volumes");
          await until(`document.querySelector("button[aria-label='Remove lab-cache: In use by stopped']")?.getAttribute("aria-disabled") === "true"`, "Remove off for lab-cache");
          await shot("volumes");
          await run(`__mc.click(document.querySelector("button[aria-label='Remove lab-scratch']"))`);
          await until(`document.querySelector("[role=alertdialog] input") && document.querySelector("[role=alertdialog]").textContent.includes("lab-scratch to remove it")`, "the typed-name dialog");
          await run(`__mc.type(document.querySelector("[role=alertdialog] input"), "lab-scratch")`);
          await shot("remove volume, name typed");
          await run(`__mc.click(${inDialog("Remove volume")})`);
          await confirmDestroy({ run, until }, "the volume removal");
          await until(`!${row("Volumes", "lab-scratch")}`, "lab-scratch removed");

          // Networks: bridge is predefined; lab-scratch-net has nothing attached and goes.
          await run(`__mc.dblclick(__mc.item("Networks"))`);
          await until(`location.pathname === "/docker/lab/networks" && ${row("Networks", "lab-scratch-net")}`, "the networks");
          await until(`document.querySelector("button[aria-label^='Remove bridge: Every engine has bridge']")?.getAttribute("aria-disabled") === "true"`, "bridge kept");
          await shot("networks");
          await run(`__mc.click(document.querySelector("button[aria-label='Remove lab-scratch-net']"))`);
          await until(`(document.querySelector("[role=alertdialog]")?.textContent ?? "").includes("Remove network lab-scratch-net?")`, "the confirmation");
          await run(`__mc.click(${inDialog("Remove network")})`);
          await confirmDestroy({ run, until }, "the network removal");
          await until(`!${row("Networks", "lab-scratch-net")}`, "lab-scratch-net removed");

          await run(`__mc.dblclick(__mc.item("Host"))`);
          await until(`location.pathname === "/docker/lab/host" && __mc.has("Kernel")`, "the host's facts");
          await shot("host");
        }),
      ],
    },
    {
      id: "extras",
      text: "Approved additions (DOC-21 Open question 45 q): disk usage and the host's events on the Host page; Processes in Stats; counts in the tree; a Compose project's logs merged; a read-only Files tab.",
      lab: true,
      checks: [
        cargo("the_host_has_its_disk_usage_and_counts_and_a_container_its_processes"),
        lab("lab_disk_usage_counts_and_a_containers_processes"),
        vitest("test/docker-host.test.tsx"),
        browser("the tree's counts, the host's disk usage, the worker's processes, and their top event on the Host page", async ({ page, origin, lab: credentials, until, run, shot }) => {
          const row = (table: string, text: string) => `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) table[aria-label='${table}'] tbody tr")].find((r) => r.textContent.includes(${JSON.stringify(text)}))`;
          await page.navigate(`${origin}/`);
          await labTree({ lab: credentials, until, run, shot });
          await until(`["Images", "Volumes", "Networks"].every((n) => /\\d+$/.test(__mc.item(n)?.textContent.trim() ?? ""))`, "the tree's counts");

          await run(`__mc.dblclick(__mc.item("Host"))`);
          await until(`location.pathname === "/docker/lab/host" && ${row("Disk usage", "Build cache")} && ${row("Disk usage", "Volumes")}`, "the disk usage");
          await until(`/\\(\\d+ %\\)/.test(${row("Disk usage", "Images")}.textContent)`, "the images' reclaimable share");
          await shot("host, disk usage");

          // `docker top` is a container event: the Host page, still open, lists it.
          await run(`__mc.dblclick(__mc.item("Containers"))`);
          await until(`${visible("shop-worker-1")}`, "the containers");
          await run(`__mc.click(${visible("shop-worker-1")})`);
          await until(`__mc.has("Environment")`, "the worker's overview");
          await run(`__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "Stats" && t.offsetParent !== null))`);
          await until(`location.pathname.endsWith("/shop-worker-1/stats") && document.querySelectorAll("[role=tabpanel]:not([hidden]) table[aria-label='Processes'] tbody tr").length > 0`, "the worker's processes");
          await shot("stats, processes");
          await run(`__mc.dblclick(__mc.item("Host"))`);
          await until(`location.pathname === "/docker/lab/host" && [...document.querySelectorAll("[role=tabpanel]:not([hidden]) ol[aria-label='Events'] li")].some((li) => li.textContent.includes("container top"))`, "the top event on the Host page");
          await shot("host, events");
        }),
        lab("lab_a_projects_containers_log_apart"),
        vitest("test/docker-project.test.tsx"),
        browser("the shop project's logs merged with a service column, a service hidden, its restart leaving lines", async ({ page, origin, lab: credentials, until, run, shot }) => {
          // Visible lines only: the worker's own Logs tab (logs-exec) stays mounted, hidden, with its lines.
          const logHas = (text: string) => `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) [role=log] *")].some((el) => el.childElementCount === 0 && el.offsetParent !== null && el.textContent.includes(${JSON.stringify(text)}))`;
          const chip = (label: string) => `[...document.querySelectorAll("[role=tabpanel]:not([hidden]) [role=group][aria-label=Services] button")].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`;
          await page.navigate(`${origin}/`);
          await labTree({ lab: credentials, until, run, shot });
          await until(`__mc.item("shop")`, "the shop project in the tree");
          await run(`__mc.dblclick(__mc.item("shop"))`);
          await until(`location.pathname === "/docker/lab/projects/shop/logs" && ${logHas("web listening on :8080")} && ${logHas("worker tick")}`, "web's and worker's lines merged", 10_000);
          await until(`${logHas("web")} && ${logHas("worker")} && __mc.has("Following 2 of 2 containers")`, "the service column, both followed");
          await shot("project logs");
          await run(`__mc.click(${chip("worker")})`);
          await until(`!${logHas("worker tick")} && ${logHas("web listening on :8080")}`, "worker hidden");
          await shot("project logs, web only");
          await run(`__mc.click(${chip("worker")})`);
          await until(`${logHas("worker tick")}`, "worker shown again");

          // Containers: the project's only, with its menu; Restart all leaves a stop line per container and they join again.
          await run(`__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim().startsWith("Containers") && t.offsetParent !== null))`);
          await until(`location.pathname === "/docker/lab/projects/shop/containers" && ${visible("shop-web-1")} && !${visible("tty")}`, "the project's containers");
          await shot("project containers");
          await run(`__mc.click(document.querySelector("button[aria-label='Actions for project shop']"))`);
          await until(`[...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.includes("Restart all"))`, "the project menu");
          await run(`__mc.click([...document.querySelectorAll("[role=menuitem]")].find((m) => m.textContent.includes("Restart all")))`);
          await until(`[...document.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent.trim() === "Restart 2 containers")`, "the confirmation");
          await run(`__mc.click([...document.querySelectorAll("[role=alertdialog] button")].find((b) => b.textContent.trim() === "Restart 2 containers"))`);
          await until(`!document.querySelector("[role=alertdialog]")`, "restarted");
          await run(`__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "Logs" && t.offsetParent !== null))`);
          await until(`location.pathname === "/docker/lab/projects/shop/logs" && ${logHas("[shop-worker-1 stopped")} && ${logHas("[shop-web-1 stopped")}`, "a line per stopped container", 30_000);
          await until(`[...document.querySelectorAll("[role=tabpanel]:not([hidden]) [role=log] *")].filter((el) => el.childElementCount === 0 && el.offsetParent !== null && el.textContent === "web listening on :8080").length >= 2 && __mc.has("Following 2 of 2 containers")`, "both joined again after the restart", 30_000);
          await shot("project logs after a restart");
        }),
        cargo("a_containers_files_are_listed_read_and_downloaded_from_its_archive"),
        lab("lab_a_containers_files_read_through_its_archive"),
        vitest("test/docker-files.test.tsx"),
        browser("the web container's files: the root, /www, index.html previewed read only; a stopped container's /etc", async ({ page, origin, lab: credentials, until, run, shot }) => {
          // Only what is shown: the other container's tab keeps its Files mounted out of sight.
          const entry = (name: string) => `[...document.querySelectorAll("table[aria-label=Files] tbody td button")].find((b) => b.offsetParent !== null && b.textContent.startsWith(${JSON.stringify(name)}))`;
          const here = `[...document.querySelectorAll("nav[aria-label=Folder] [aria-current=location]")].find((el) => el.offsetParent !== null)?.textContent`;
          const filesOf = async (name: string) => {
            await run(`__mc.dblclick(__mc.item("Containers"))`);
            await until(`${visible(name)}`, "the containers");
            await run(`__mc.click(${visible(name)})`);
            await until(`[...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "Files" && t.offsetParent !== null)`, `${name}'s views`);
            await run(`__mc.click([...document.querySelectorAll("[role=tab]")].find((t) => t.textContent.trim() === "Files" && t.offsetParent !== null))`);
            await until(`location.pathname.endsWith("/${name}/files") && ${entry("etc")}`, `${name}'s root`);
          };
          await page.navigate(`${origin}/`);
          await labTree({ lab: credentials, until, run, shot });
          await filesOf("shop-web-1");
          await shot("files, root");
          await run(`__mc.click(${entry("www")})`);
          await until(`${here} === "www" && ${entry("index.html")}`, "/www");
          await run(`__mc.click(${entry("index.html")})`);
          await until(`document.querySelector("[role=tabpanel]:not([hidden]) aside[aria-label='Preview of index.html']") && __mc.has("5 B · text")`, "the preview");
          await until(`(document.querySelector("[role=tabpanel]:not([hidden]) aside .monaco-editor")?.textContent ?? "").includes("shop")`, "the text in Monaco", 15_000);
          await shot("files, preview");
          await filesOf("stopped");
          await run(`__mc.click(${entry("etc")})`);
          await until(`${here} === "etc" && ${entry("passwd")}`, "a stopped container's /etc");
          await shot("files, stopped container");
        }),
      ],
    },
    {
      id: "errors",
      text: "A host without streamlocal forwarding gives the explained error; LogViewer and Terminal in packages/ui if this task lands first; CI green.",
      lab: true,
      checks: [
        cargo("a_host_that_does_not_forward_the_socket_is_explained"),
        cargo("a_session_the_host_ends_turns_the_connection_failed"),
        lab("lab_a_user_without_socket_forwarding_gets_the_explained_error"),
        manual("LogViewer and Terminal in packages/ui (TSK-81 batch 2) and CI green on every TSK-81 PR"),
      ],
    },
  ],
} satisfies Checklist;
