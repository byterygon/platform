// TSK-81, Docker over SSH (Mightyconsole spec section 18, against the lab's docker-host). The
// server's checks: tests/docker.rs against a stand-in SSH server, tests/docker_lab.rs (feature
// lab-tests) against the lab's sshd and Docker. The UI's: test/docker.test.tsx and
// test/docker-containers.test.tsx (jsdom), and a walk in the browser against the lab. Batch 1
// wired host-key and errors, batch 2b the containers and the logs, batch 2c stats and exec; the
// resources come with their batch. Run `pnpm --filter @byterygon/mightyconsole acceptance docker --lab-up --strict`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, type Checklist, browser, cargo, command, manual, vitest } from "../checklist.mts";

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
      checks: [],
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
