// The Docker tool's containers, TSK-81 batch 2b (Mightyconsole spec §10.4 to §10.6, mockup frames
// docker-containers, docker-remove, docker-overview, docker-logs): the helpers (state tones, ports,
// filters, grouping by Compose project, the events that change rows, resuming logs), the
// Containers tab against the fake host (groups, chips, selection, a refused start that stays
// selected, Remove's options, a project's restart asked once, an event that reloads the list), and
// a container's Overview (environment hidden until shown), Logs (stderr apart, followed lines) and
// Inspect. Axe on each screen.
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import { NoticeContext, type Notice } from "@/app/page";
import type { ContainerRow } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { ContainerTab, limitsText, runningFor } from "@/tools/docker/ContainerTab";
import { ContainersTab } from "@/tools/docker/ContainersTab";
import { type DockerLogLine, changesRows, commandLine, formatBytes, formatMiB, formatPort, formatPorts, formatRate, toBase64, withRates, groupByProject, imageLabel, isProblem, matchesFilter, matchesSearch, parseLines, stateTone } from "@/tools/docker/format";
import { containersTree, dockerTool } from "@/tools/docker";
import { newerThan, pickStream } from "@/tools/docker/LogsPanel";
import { cpuBase, formatPercent } from "@/tools/docker/StatsPanel";
import { splitCommand } from "@/tools/docker/TerminalPanel";
// The stand-in every `@xterm/*` import resolves to in tests (vite.config.ts): the same module, so
// it records each Terminal the component makes.
import * as xterm from "../../../../packages/ui/test/fakes/xterm";
import { profile as schema } from "@/tools/docker/profile";
import { treeContainersOf } from "@/tools/docker/tree-data";
import type { TabProps, TabView } from "@/tools/types";
import { createFakeServices, fakeContainer, fakeContainers, fakeInspect } from "./support/fake-services";
import { act, axeViolations, byRole, byText, cleanup, click, render, settle, waitFor } from "./support/render";

afterEach(cleanup);

type Fake = ReturnType<typeof createFakeServices>;

async function connected(): Promise<{ fake: Fake; connId: string }> {
  const fake = createFakeServices();
  const profileId = await fake.storeProfile("docker", "build-host", { host: "h", username: "u", hostKey: { algorithm: "ssh-ed25519", fingerprintSha256: "SHA256:q7Lw3Gm0bX9yT2vR8cKpN5sUe1JhAa4FzQ6dWiYoV0E" } });
  const out = await fake.services.client.docker.connect({ profileId });
  return { fake, connId: out.connId };
}

function props(fake: Fake, connId: string, tab: Partial<TabView> & { kind: string; params: Record<string, unknown> }) {
  const profile: ProfileRecord = { id: "01D", tool: "docker", version: 1, name: "build-host", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const openTab = vi.fn();
  const go = vi.fn();
  const navigate = vi.fn();
  const p: TabProps = { tab: { id: "t", tool: "docker", profileId: "01D", title: "t", pinned: false, ...tab }, profile, connId, client: fake.services.client as MightyClient, active: true, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab, go, navigate };
  return { p, openTab, go, navigate };
}

function withNotices(ui: React.ReactNode, notices: Notice[]) {
  return <NoticeContext.Provider value={(n) => notices.push(n)}>{ui}</NoticeContext.Provider>;
}

const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure).map((c) => c.input as Record<string, unknown>);
const rowOf = (name: string) => Array.from(document.querySelectorAll<HTMLElement>("table[aria-label='Containers'] tbody tr")).find((r) => r.querySelector("button")?.textContent === name) ?? null;
const checkboxOf = (label: string) => document.querySelector<HTMLElement>(`[role=checkbox][aria-label="${label}"]`);

describe("helpers", () => {
  test("states, ports and filters read as the mockup's", () => {
    expect(stateTone({ state: "running" })).toBe("success");
    expect(stateTone({ state: "running", health: "unhealthy" })).toBe("danger");
    expect(stateTone({ state: "exited", exitCode: 0 })).toBe("neutral");
    expect(stateTone({ state: "exited", exitCode: 137 })).toBe("danger");
    expect(stateTone({ state: "restarting" })).toBe("warning");
    expect(formatPort({ privatePort: 80, protocol: "tcp", ip: "127.0.0.1", publicPort: 8080 })).toBe("127.0.0.1:8080→80/tcp");
    expect(formatPort({ privatePort: 8000, protocol: "tcp" })).toBe("8000/tcp");
    expect(formatPort({ privatePort: 53, protocol: "udp", ip: "::1", publicPort: 53 })).toBe("[::1]:53→53/udp");
    expect(
      formatPorts([
        { privatePort: 80, protocol: "tcp", ip: "0.0.0.0", publicPort: 8080 },
        { privatePort: 80, protocol: "tcp", ip: "::", publicPort: 8080 },
      ]),
    ).toBe("8080→80/tcp");
    const rows = fakeContainers();
    expect(rows.filter(isProblem).map((r) => r.name)).toEqual(["shop-worker-1", "stopped"]);
    expect(rows.filter((r) => matchesFilter(r, "stopped")).map((r) => r.name)).toEqual(["stopped"]);
    expect(rows.filter((r) => matchesSearch(r, "service=web")).map((r) => r.name)).toEqual(["shop-web-1"]);
    expect(rows.filter((r) => matchesSearch(r, "BUSYBOX")).length).toBe(4);
    expect(commandLine(["sh", "-c", "echo hi; sleep 1"])).toBe("sh -c 'echo hi; sleep 1'");
    expect(imageLabel("busybox:1.37@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec")).toBe("busybox:1.37");
    expect(imageLabel("ghcr.io/acme/shop-api:2.4.1")).toBe("ghcr.io/acme/shop-api:2.4.1");
  });

  test("projects first by name with their working dir, running first, the others last", () => {
    const rows = [fakeContainer("z-loose"), ...fakeContainers(), fakeContainer("a-proj", { project: "alpha", service: "a" })];
    const groups = groupByProject(rows);
    expect(groups.map((g) => g.project)).toEqual(["alpha", "shop", null]);
    expect(groups[1]!.workingDir).toBe("/srv/shop");
    expect(groups[1]!.rows.map((r) => r.name)).toEqual(["shop-web-1", "shop-worker-1"]);
    expect(groups[2]!.rows.map((r) => r.name)).toEqual(["tty", "z-loose", "stopped"]);
    const tree = containersTree("p", fakeContainers());
    expect(tree.map((n) => n.label)).toEqual(["shop", "tty", "stopped"]);
    expect(tree[0]!.children!.map((n) => n.label)).toEqual(["web", "worker"]);
    expect(tree[0]!.children![0]!.open).toEqual({ kind: "docker.container", params: { id: "shop-web-1", view: "overview" }, title: "shop-web-1" });
  });

  test("events that change a row; jsonl chunks; resuming logs skips what was shown", () => {
    const event = (action: string, kind = "container") => ({ kind, action, id: "x", attributes: {}, timeMs: 0 });
    expect(changesRows(event("health_status: unhealthy"))).toBe(true);
    expect(changesRows(event("die"))).toBe(true);
    expect(changesRows(event("exec_start: sh"))).toBe(false);
    expect(changesRows(event("create", "volume"))).toBe(false);
    const bytes = new TextEncoder().encode('{"ts":"a","stream":"stdout","text":"1"}\n{"ts":"b","stream":"stderr","text":"2"}\n');
    const lines = parseLines<DockerLogLine>(bytes);
    expect(lines.map((l) => l.text)).toEqual(["1", "2"]);
    expect(pickStream(lines, "stderr").map((l) => l.text)).toEqual(["2"]);
    const again: DockerLogLine[] = [
      { ts: "2026-11-20T08:00:01Z", stream: "stdout", text: "seen 1" },
      { ts: "2026-11-20T08:00:02Z", stream: "stdout", text: "seen 2" },
      { ts: "2026-11-20T08:00:02Z", stream: "stdout", text: "new at the same time" },
      { ts: "2026-11-20T08:00:03Z", stream: "stdout", text: "new" },
    ];
    expect(newerThan(again, "2026-11-20T08:00:02Z", 1).map((l) => l.text)).toEqual(["new at the same time", "new"]);
  });

  test("the subtitle's run time and the limits", () => {
    const o = fakeInspect(fakeContainers()[0]!).overview;
    expect(runningFor(o, Date.parse("2026-11-20T10:00:01Z"))).toBe("up 3 hours");
    const stopped = fakeInspect(fakeContainers()[2]!).overview;
    expect(runningFor(stopped, Date.parse("2026-11-20T07:01:02Z"))).toBe("exited (3) 1 minute ago");
    expect(limitsText({ ...o, cpus: 2, memoryLimit: 1024 ** 3 })).toBe("2 CPUs · 1 GiB");
    expect(limitsText({ ...o, memoryLimit: 256 * 1024 ** 2 })).toBe("256 MiB");
    expect(limitsText(o)).toBe("none");
  });

  test("routes and tab titles: /containers/<name>/<view>", () => {
    const kind = dockerTool.tabKinds["docker.container"]!;
    expect(kind.href!({ id: "shop-web-1", view: "logs" })).toEqual({ path: "containers/shop-web-1/logs" });
    expect(kind.href!({ id: "shop-web-1" })).toEqual({ path: "containers/shop-web-1/overview" });
    expect(kind.title({ id: "shop-web-1" })).toBe("shop-web-1");
    expect(dockerTool.tabKinds["docker.containers"]!.href!({})).toEqual({ path: "containers" });
  });
});

describe("Containers", () => {
  test("grouped by project, filtered by chips and text; the tree gets the list; no axe violations", async () => {
    const { fake, connId } = await connected();
    const { p } = props(fake, connId, { kind: "docker.containers", params: {} });
    const { container } = render(<ContainersTab {...p} />);
    await waitFor(() => rowOf("shop-web-1") !== null, "the containers");
    expect(byText("shop")).not.toBeNull();
    expect(byText(/2 containers · 1 running · 1 restarting/)).not.toBeNull();
    expect(byText("/srv/shop")).not.toBeNull();
    expect(byText("No project")).not.toBeNull();
    expect(rowOf("shop-web-1")!.textContent).toContain("127.0.0.1:18080→8080/tcp");
    expect(treeContainersOf(connId)?.length).toBe(4);
    await waitFor(() => calls(fake, "docker.events").length === 1, "the events stream");
    expect(calls(fake, "docker.events")[0]).toMatchObject({ connId, types: ["container"] });
    expect(await axeViolations(container)).toEqual([]);

    await click(byRole("button", /^Problems/));
    expect(rowOf("shop-web-1")).toBeNull();
    expect(rowOf("stopped")).not.toBeNull();
    expect(rowOf("shop-worker-1")).not.toBeNull();
    await click(byRole("button", /^All/));
    const search = container.querySelector<HTMLInputElement>("input[aria-label='Filter containers']")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "tty");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(rowOf("tty")).not.toBeNull();
    expect(rowOf("shop-web-1")).toBeNull();
  });

  test("Start on the selection; a refused one stays selected with its reason; an event reloads", async () => {
    const { fake, connId } = await connected();
    fake.server.dockerRefuse.set(fakeContainers()[3]!.id, "cannot start: the image is gone");
    const notices: Notice[] = [];
    const { p } = props(fake, connId, { kind: "docker.containers", params: {} });
    render(withNotices(<ContainersTab {...p} />, notices));
    await waitFor(() => rowOf("stopped") !== null, "the containers");
    await click(checkboxOf("Select stopped"));
    await click(checkboxOf("Select tty"));
    expect(byText("2 selected")).not.toBeNull();
    // tty runs: Start acts on the stopped one only; Stop is on for tty.
    await click(byRole("button", "Start"));
    await waitFor(() => calls(fake, "docker.containers.start").length === 1, "the start");
    expect(calls(fake, "docker.containers.start")[0]).toMatchObject({ ids: [fakeContainers()[2]!.id] });
    await waitFor(() => notices.length === 1, "the notice");
    expect(notices[0]!.title).toBe("Started 1 container");

    await click(checkboxOf("Select tty"));
    await click(byRole("button", "Restart"));
    await waitFor(() => notices.length === 2, "the refusal");
    expect(notices[1]).toMatchObject({ title: "Could not restart tty", description: "cannot start: the image is gone", type: "warning" });
    expect(checkboxOf("Select tty")!.getAttribute("aria-checked")).toBe("true");

    const lists = calls(fake, "docker.containers.list").length;
    await act(async () => {
      for (const push of fake.server.dockerPush.events) push([{ kind: "container", action: "die", id: "x", name: "tty", attributes: {}, timeMs: Date.now() }]);
    });
    await waitFor(() => calls(fake, "docker.containers.list").length > lists, "the reload after the event");
    await waitFor(() => byText(/last event .* \(tty die\)/) !== null, "the footer's last event");
  });

  test("Remove asks with the options; a project's restart asks once", async () => {
    const { fake, connId } = await connected();
    const notices: Notice[] = [];
    const { p } = props(fake, connId, { kind: "docker.containers", params: {} });
    render(withNotices(<ContainersTab {...p} />, notices));
    await waitFor(() => rowOf("stopped") !== null, "the containers");
    await click(checkboxOf("Select stopped"));
    await click(byRole("button", "Remove…"));
    await waitFor(() => byRole("alertdialog") !== null, "the remove dialog");
    expect(byText(/named volumes stay/)).not.toBeNull();
    expect(byText(/none are running/)).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
    await click(byRole("button", "Remove 1 container"));
    await waitFor(() => calls(fake, "docker.containers.remove").length === 1, "the remove");
    expect(calls(fake, "docker.containers.remove")[0]).toMatchObject({ force: false, volumes: true });
    await waitFor(() => rowOf("stopped") === null, "the row gone");
    expect(notices.at(-1)!.title).toBe("Removed 1 container");

    await click(byRole("button", "Actions for project shop"));
    await click(byRole("menuitem", /Restart all/));
    await waitFor(() => byText("Restart the project shop?") !== null, "the project confirmation");
    expect(calls(fake, "docker.containers.restart")).toHaveLength(0);
    await click(byRole("button", "Restart 2 containers"));
    await waitFor(() => calls(fake, "docker.containers.restart").length === 1, "one restart call");
    expect((calls(fake, "docker.containers.restart")[0]!["ids"] as string[]).length).toBe(2);
  });
});

describe("a container", () => {
  test("Overview: facts, networks, the environment hidden until shown; Inspect; no axe violations", async () => {
    const { fake, connId } = await connected();
    const { p, navigate } = props(fake, connId, { kind: "docker.container", params: { id: "shop-web-1", view: "overview" }, title: "shop-web-1" });
    const { container } = render(<ContainerTab {...p} />);
    await waitFor(() => byText("unless-stopped") !== null, "the overview");
    expect(byText("healthy")).not.toBeNull();
    expect(byText("shop_default")).not.toBeNull();
    expect(byText("127.0.0.1:18080 → 8080/tcp")).not.toBeNull();
    expect(byText("sk_test_hidden")).toBeNull();
    expect(byText(/wget -qO- localhost:8080/)).not.toBeNull();
    await click(byRole("button", "Show STRIPE_API_KEY"));
    expect(byText("sk_test_hidden")).not.toBeNull();
    expect(byText("info")).toBeNull();
    await click(byRole("button", /Show all/));
    expect(byText("info")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
    expect(calls(fake, "docker.events")[0]).toMatchObject({ container: "shop-web-1" });

    await click(byRole("tab", "Inspect"));
    expect(navigate).toHaveBeenCalledWith({ kind: "docker.container", params: { id: "shop-web-1", view: "inspect" }, title: "shop-web-1" }, { replace: true });
    await waitFor(() => byRole("tree", "docker inspect shop-web-1") !== null, "the inspect JSON");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Logs: Docker's lines with stderr apart, followed lines appended, a stopped container read once", async () => {
    const { fake, connId } = await connected();
    fake.server.dockerLogs.set("shop-web-1", [
      { ts: "2026-11-20T08:00:01.1Z", stream: "stdout", text: "listening on :8080" },
      { ts: "2026-11-20T08:00:02.2Z", stream: "stderr", text: "warning: slow disk" },
    ]);
    fake.server.dockerFollow.add("shop-web-1");
    const { p } = props(fake, connId, { kind: "docker.container", params: { id: "shop-web-1", view: "logs" }, title: "shop-web-1" });
    const { container } = render(<ContainerTab {...p} />);
    await waitFor(() => byText("listening on :8080") !== null, "the log");
    expect(calls(fake, "docker.containers.logs")[0]).toMatchObject({ id: "shop-web-1", follow: true, tail: 1000, since: null });
    expect(byText("warning: slow disk")).not.toBeNull();
    await act(async () => {
      for (const push of fake.server.dockerPush.logs.get("shop-web-1") ?? []) push([{ ts: "2026-11-20T08:00:03Z", stream: "stdout", text: "GET /health 200" }]);
    });
    await waitFor(() => byText("GET /health 200") !== null, "the followed line");
    await click(byRole("button", "stderr"));
    await waitFor(() => byText("listening on :8080") === null, "stdout hidden");
    expect(byText("warning: slow disk")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    cleanup();
    const stopped = props(fake, connId, { kind: "docker.container", params: { id: "stopped", view: "logs" }, title: "stopped" });
    render(<ContainerTab {...stopped.p} />);
    await waitFor(() => calls(fake, "docker.containers.logs").length === 2, "the stopped container's log");
    expect(calls(fake, "docker.containers.logs")[1]).toMatchObject({ id: "stopped", follow: false });
  });
});

describe("stats and the terminal", () => {
  const sample = (t: number, patch: Record<string, unknown> = {}) => ({
    timeMs: Date.parse("2026-11-20T08:00:00Z") + t * 1000,
    cpuPercent: 38.24,
    onlineCpus: 4,
    memoryUsed: 418 * 1024 ** 2,
    memoryLimit: 1024 ** 3,
    rxBytes: 1_000_000 + t * 1_200_000,
    txBytes: 10_000 + t * 340_000,
    blockRead: 12_000_000,
    blockWrite: 3_000_000,
    pids: 23,
    ...patch,
  });

  test("helpers: rates from totals, units, the command line, base64", () => {
    const a = sample(0);
    const b = withRates(a, sample(2));
    expect(b.rxRate).toBe(1_200_000);
    expect(withRates(sample(2), sample(3, { rxBytes: 5 })).rxRate).toBe(0);
    expect(withRates(undefined, a).txRate).toBe(0);
    expect(formatRate(1_200_000)).toBe("1.2 MB/s");
    expect(formatBytes(340_000)).toBe("340 kB");
    expect(formatBytes(12)).toBe("12 B");
    expect(formatMiB(418 * 1024 ** 2)).toBe("418 MiB");
    expect(formatMiB(1.5 * 1024 ** 3)).toBe("1.5 GiB");
    expect(cpuBase({ cpus: 2 }, { onlineCpus: 8 })).toEqual({ cpus: 2, limit: true });
    expect(cpuBase({}, { onlineCpus: 8 })).toEqual({ cpus: 8, limit: false });
    expect(splitCommand("sh -c 'echo hi; ls'")).toEqual(["sh", "-c", "echo hi; ls"]);
    expect(splitCommand(' python  "my script.py" ')).toEqual(["python", "my script.py"]);
    expect(splitCommand("sh -c ''")).toEqual(["sh", "-c", ""]);
    expect(splitCommand("   ")).toBeNull();
    expect(atob(toBase64(new TextEncoder().encode("ls\r")))).toBe("ls\r");
  });

  test("Stats: tiles, a pushed sample, the table; a stopped container is not running; no axe violations", async () => {
    const { fake, connId } = await connected();
    fake.server.dockerStats = [sample(0), sample(1)];
    const { p } = props(fake, connId, { kind: "docker.container", params: { id: "shop-web-1", view: "stats" }, title: "shop-web-1" });
    const { container } = render(<ContainerTab {...p} />);
    await waitFor(() => byText("38.2 %") !== null, "the CPU tile");
    expect(calls(fake, "docker.containers.stats")[0]).toMatchObject({ connId, id: "shop-web-1" });
    expect(byText("of 4 CPUs")).not.toBeNull();
    expect(byText("418 MiB")).not.toBeNull();
    expect(byText("no limit · host 1.0 GiB")).not.toBeNull();
    expect(formatPercent(38.24)).toBe("38.2 %");
    expect(formatPercent(0.042)).toBe("0.042 %");
    expect(formatPercent(0.5)).toBe("0.50 %");
    expect(formatPercent(0)).toBe("0 %");
    expect(byText("1.2 MB/s")).not.toBeNull();
    expect(byText("out 340 kB/s")).not.toBeNull();
    expect(byText("limit none")).not.toBeNull();
    expect(byRole("img", "CPU, last 5 minutes") ?? container.querySelector("[aria-label='CPU, last 5 minutes']")).not.toBeNull();
    await act(async () => fake.pushStats([sample(2, { cpuPercent: 71.4, pids: 30 })]));
    await waitFor(() => byText("71.4 %") !== null, "the pushed sample");
    await click(byRole("button", "Table"));
    await waitFor(() => container.querySelector("table[aria-label='Samples, newest first']") !== null, "the table view");
    expect(container.querySelectorAll("table[aria-label='Samples, newest first'] tbody tr").length).toBe(3);
    expect(await axeViolations(container)).toEqual([]);

    cleanup();
    const stopped = props(fake, connId, { kind: "docker.container", params: { id: "stopped", view: "stats" }, title: "stopped" });
    render(<ContainerTab {...stopped.p} />);
    await waitFor(() => byText(/Not running: stopped is exited/) !== null, "not running");
    expect(calls(fake, "docker.containers.stats")).toHaveLength(1);
  });

  test("Terminal: Connect runs the exec; keys go out batched; the exit code shows; Disconnect ends it", async () => {
    const { fake, connId } = await connected();
    const { p } = props(fake, connId, { kind: "docker.container", params: { id: "shop-web-1", view: "terminal" }, title: "shop-web-1" });
    const { container } = render(<ContainerTab {...p} />);
    await waitFor(() => byRole("button", "Connect") !== null, "the terminal's bar");
    expect(await axeViolations(container)).toEqual([]);
    await click(byRole("button", "Connect"));
    await waitFor(() => fake.server.dockerExec !== null, "the exec");
    expect(calls(fake, "docker.containers.exec")[0]).toMatchObject({ id: "shop-web-1", cmd: null, user: null, workdir: null });
    await waitFor(() => xterm.terminals.at(-1)?.output().includes("$ ") === true, "the prompt");
    await waitFor(() => byRole("button", "Disconnect") !== null, "connected");
    const term = xterm.terminals.at(-1)!;
    await act(async () => {
      term.type("l");
      term.type("s\r");
      await new Promise((r) => setTimeout(r, 30));
    });
    await waitFor(() => fake.server.dockerExec?.input === "ls\r", "the keys on the server");
    expect(calls(fake, "term.write")).toHaveLength(1);
    await act(async () => fake.server.dockerExec!.output("bin  etc\r\n$ "));
    await waitFor(() => term.output().includes("bin  etc"), "the output");
    await act(async () => fake.server.dockerExec!.exit(3));
    await waitFor(() => term.output().includes("[exited with code 3]"), "the exit code in the scrollback");
    await waitFor(() => byText("Exited with code 3") !== null, "the exit code in the footer");

    await click(byRole("button", "New session"));
    await waitFor(() => byRole("button", "Disconnect") !== null, "the second session");
    await click(byRole("button", "Disconnect"));
    await waitFor(() => byText("Disconnected") !== null, "disconnected");
    expect(fake.server.dockerExec).toBeNull();
    expect(calls(fake, "docker.containers.exec")).toHaveLength(2);
  });

  test("Terminal: a stopped container has none", async () => {
    const { fake, connId } = await connected();
    const { p } = props(fake, connId, { kind: "docker.container", params: { id: "stopped", view: "terminal" }, title: "stopped" });
    render(<ContainerTab {...p} />);
    await waitFor(() => byText(/Not running: start stopped/) !== null, "not running");
    expect(byRole("button", "Terminal")?.hasAttribute("disabled") || byRole("button", "Terminal")?.getAttribute("aria-disabled") === "true").toBe(true);
  });
});

// Keeps the type import used when a test above changes.
export type { ContainerRow };
