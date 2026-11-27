// Routes in the UI (DOC-23 §10, TSK-117 batch 3): the editor's draft and its checks, the path
// figure (its accessible name, the failing hop and the hops after it), Settings → Routes (the
// chips, Not confirmed, Duplicate, the delete that lists the profiles), the route editor (adding,
// reordering by keyboard and buttons, Test with one line per hop, the confirmation after saving a
// command) and Connect through (Direct, a route's small path, Route missing). Axe on each.
import { afterEach, describe, expect, test } from "vitest";
import { ServicesContext } from "@/app/client";
import { ConnectThrough, noRouteReason, targetOf } from "@/app/routes/ConnectThrough";
import { PathFigure, describePath, resultsOf, resultsOfError } from "@/app/routes/PathFigure";
import { RouteEditor } from "@/app/routes/RouteEditor";
import { RoutesSection, copyName } from "@/app/routes/RoutesSection";
import type { HopInput, RouteView } from "@/gen/api";
import { type DraftHop, hopKey, moveHop, proxyUrl, reloadRoutes, resetRoutes, validateRoute } from "@/profiles/routes";
import { reloadSshHosts, resetSshHosts } from "@/profiles/ssh-hosts";
import { createFakeServices } from "./support/fake-services";
import { axeViolations, byRole, byText, cleanup, click, dialogWith, key, render, settle, type, waitFor } from "./support/render";

afterEach(() => {
  cleanup();
  resetRoutes();
  resetSshHosts();
});

/** An ordered or plain list by its label (they carry no explicit role). */
const listOf = (label: string): HTMLElement | null => document.querySelector<HTMLElement>(`ol[aria-label="${label}"], ul[aria-label="${label}"]`);
const hop = (h: HopInput): DraftHop => ({ key: hopKey(), hop: h });
const LOGIN = { host: "bastion.prod", port: 22, username: "deploy", auth: "agent" as const, keepaliveSec: null, hostKey: null };

describe("the draft", () => {
  test("a route needs a name and 1 to 8 hops; a command comes first; a node is passed once", () => {
    expect(validateRoute({ name: "", kind: "path", hops: [], shared: false })).toMatchObject({ name: expect.any(String), hops: expect.any(String) });
    const cmd = hop({ kind: "command", program: "tsh", args: [], env: [], cwd: null });
    const ssh = hop({ kind: "ssh", sshHostId: "H1" });
    expect(validateRoute({ name: "r", kind: "path", hops: [ssh, cmd], shared: false }).hop1).toMatch(/first/);
    expect(validateRoute({ name: "r", kind: "path", hops: [ssh, hop({ kind: "ssh", sshHostId: "H1" })], shared: false }).hop1).toMatch(/once/);
    expect(validateRoute({ name: "r", kind: "path", hops: [cmd, ssh], shared: false })).toEqual({});
    const bad = hop({ kind: "command", program: "x", args: [], env: [{ name: "1A", secret: false, value: "" }], cwd: null });
    expect(validateRoute({ name: "r", kind: "path", hops: [bad], shared: false }).hop0).toMatch(/variable/);
    expect(validateRoute({ name: "r", kind: "system", hops: [], shared: false })).toEqual({});
  });

  test("moving a hop keeps the others in order", () => {
    const [a, b, c] = [hop({ kind: "ssh", sshHostId: "A" }), hop({ kind: "ssh", sshHostId: "B" }), hop({ kind: "ssh", sshHostId: "C" })];
    expect(moveHop([a, b, c], 2, 0).map((h) => (h.hop as { sshHostId: string }).sshHostId)).toEqual(["C", "A", "B"]);
  });

  test("labels", () => {
    expect(proxyUrl({ kind: "socks5", tls: false, host: "p", port: 1080 })).toBe("socks5://p:1080");
    expect(proxyUrl({ kind: "httpConnect", tls: true, host: "fd00::1", port: 443 })).toBe("https://[fd00::1]:443");
    expect(copyName("prod", ["prod", "prod copy"])).toBe("prod copy 2");
    expect(noRouteReason("nats", {})).toMatch(/TSK-118/);
    expect(noRouteReason("docker", { transport: "socket" })).toMatch(/local socket/);
    expect(noRouteReason("temporal", {})).toBeNull();
    expect(targetOf("langgraph", { url: "https://lg.example/api" })).toBe("lg.example:443");
    expect(targetOf("docker", { transport: "tcp", host: "d", tls: { enabled: true } })).toBe("d:2376");
  });
});

describe("the path figure", () => {
  const hops = [
    { kind: "socks5", label: "proxy.corp:1080", name: "corp" },
    { kind: "ssh", label: "bastion.prod:22", name: "bastion" },
  ];

  test("names the hops in order and where a test stopped; no axe violations", async () => {
    expect(describePath(hops, "t:7233")).toBe("Path: This server, then hop 1, SOCKS5 corp (proxy.corp:1080), then hop 2, SSH bastion (bastion.prod:22), then target t:7233.");
    const results = resultsOf([{ hop: { index: 0 }, ok: true }, { hop: { index: 1 }, ok: false }], 2);
    expect(results).toEqual(["ok", "failed", "notTried"]);
    expect(resultsOfError(1, 2)).toEqual(["ok", "failed", "notTried"]);
    const { container } = render(<PathFigure hops={hops} target="t:7233" results={results} tls />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-label")).toMatch(/stopped at hop 2/);
    expect(container.querySelector("[data-node='2']")?.getAttribute("data-state")).toBe("failed");
    expect(container.querySelector("[data-node='3']")?.getAttribute("data-state")).toBe("notTried");
    expect(container.querySelector("[data-arrow='2']")?.getAttribute("data-state")).toBe("failed");
    expect(container.textContent).toContain("SSH channel");
    expect(container.textContent).toContain("the tool's TLS, end to end");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a leading command is spawned and runs on the server's own machine", () => {
    const { container } = render(<PathFigure hops={[{ kind: "command", label: "tsh" }]} target={null} />);
    expect(container.textContent).toContain("spawn");
    expect(container.querySelector("[data-node='1'] rect")?.getAttribute("stroke-dasharray")).toBe("4 3");
  });
});

function route(patch: Partial<RouteView> = {}): RouteView {
  return {
    id: "R1",
    name: "prod",
    kind: "path",
    hops: [
      { kind: "socks5", label: "proxy.corp:1080", proxyId: "P1", nodeName: "corp", linkId: "L1", needsConfirmation: false, args: [], env: [] },
      { kind: "ssh", label: "bastion.prod:22", sshHostId: "H1", nodeName: "bastion", linkId: "L2", needsConfirmation: false, args: [], env: [] },
    ],
    confirmed: true,
    owner: { kind: "personal" },
    etag: "1",
    createdAt: "",
    updatedAt: "",
    createdBy: "",
    updatedBy: "",
    access: "owner",
    usedBy: [{ id: "T1", tool: "temporal", name: "Prod" }],
    usedByHidden: 0,
    ...patch,
  };
}

describe("Settings → Routes", () => {
  test("lists each route's hops as chips and who uses it; deleting lists the profiles; duplicate copies; no axe violations", async () => {
    const fake = createFakeServices();
    fake.server.routes = [route(), route({ id: "R2", name: "agent", confirmed: false, usedBy: [], hops: [{ kind: "command", label: "tsh", program: "/usr/bin/tsh", linkId: "L3", needsConfirmation: true, args: [], env: [] }] })];
    await reloadRoutes(fake.services.client);
    render(
      <ServicesContext.Provider value={fake.services}>
        <RoutesSection client={fake.services.client} />
      </ServicesContext.Provider>,
    );
    await settle();
    const table = (document.querySelector<HTMLElement>("[aria-label='Routes'] table, table[aria-label='Routes']") ?? byRole("table", "Routes"))!;
    expect(table.textContent).toContain("SOCKS5 corp");
    expect(table.textContent).toContain("SSH bastion");
    expect(table.textContent).toContain("Prod (temporal)");
    expect(table.textContent).toContain("Not confirmed");
    expect(await axeViolations(document.body)).toEqual([]);

    await click(byRole("button", "Duplicate prod"));
    await waitFor(() => fake.server.routes.some((r) => r.name === "prod copy"), "the copy");

    await click(byRole("button", "Delete prod"));
    await waitFor(() => dialogWith("Delete route prod?") !== null, "the delete dialog");
    expect(dialogWith("Delete route prod?")!.textContent).toContain("Route missing");
    expect(dialogWith("Delete route prod?")!.textContent).toContain("Prod");
    await click(byRole("button", "Delete route"));
    await waitFor(() => !fake.server.routes.some((r) => r.id === "R1"), "the route to go");
  });
});

describe("the route editor", () => {
  test("adds hops, reorders them by keyboard, tests the draft, and saves; no axe violations", async () => {
    const fake = createFakeServices();
    const a = fake.storeSshHost("jump1", LOGIN);
    const b = fake.storeSshHost("jump2", { ...LOGIN, host: "jump2.internal" });
    await reloadSshHosts(fake.services.client);
    await reloadRoutes(fake.services.client);
    const saved: RouteView[] = [];
    fake.server.routes = [];
    const initial = route({ id: "R9", name: "two jumps", usedBy: [], hops: [
      { kind: "ssh", label: "bastion.prod:22", sshHostId: a, nodeName: "jump1", linkId: "La", needsConfirmation: false, args: [], env: [] },
      { kind: "ssh", label: "jump2.internal:22", sshHostId: b, nodeName: "jump2", linkId: "Lb", needsConfirmation: false, args: [], env: [] },
    ] });
    fake.server.routes.push(initial);
    render(
      <ServicesContext.Provider value={fake.services}>
        <RouteEditor open onOpenChange={() => {}} client={fake.services.client} route={initial} testTarget="echo.internal:7" onSaved={(r) => saved.push(r)} />
      </ServicesContext.Provider>,
    );
    await settle();
    const hopsList = listOf("Hops")!;
    expect(hopsList.textContent).toMatch(/jump1[\s\S]*jump2/);
    // Space lifts hop 2, the up arrow moves it, Space drops it.
    const grip = byRole("button", "Reorder hop 2")!;
    grip.focus();
    await key(" ");
    await key("ArrowUp");
    await settle(1);
    expect(listOf("Hops")!.textContent).toMatch(/jump2[\s\S]*jump1/);
    await key(" ");
    // And back with the button.
    await click(byRole("button", "Move hop 1 down"));
    expect(listOf("Hops")!.textContent).toMatch(/jump1[\s\S]*jump2/);

    await click(byRole("button", "Test"));
    await waitFor(() => listOf("Test result") !== null, "the test lines");
    expect(listOf("Test result")!.textContent).toContain("Target echo.internal:7");
    const call = fake.server.calls.find((c) => c.procedure === "routes.test")!;
    expect(call.input).toMatchObject({ target: { host: "echo.internal", port: 7 }, hops: [{ kind: "ssh", sshHostId: a }, { kind: "ssh", sshHostId: b }] });
    expect(await axeViolations(document.body)).toEqual([]);

    await click(byRole("button", "Save route"));
    await waitFor(() => saved.length === 1, "the save");
    expect(fake.server.calls.some((c) => c.procedure === "routes.update")).toBe(true);
  });

  test("a saved command asks to be confirmed, showing every argument", async () => {
    const fake = createFakeServices();
    await reloadRoutes(fake.services.client);
    const saved: RouteView[] = [];
    render(
      <ServicesContext.Provider value={fake.services}>
        <RouteEditor open onOpenChange={() => {}} client={fake.services.client} onSaved={(r) => saved.push(r)} />
      </ServicesContext.Provider>,
    );
    await settle();
    await type(byRole("textbox", "Name") as HTMLInputElement, "agent");
    await click(byRole("button", "Add hop"));
    await waitFor(() => byText("Local command (first hop)") !== null, "the hop kinds");
    await click(byText("Local command (first hop)"));
    await settle();
    await type(byRole("textbox", "Program") as HTMLInputElement, "/usr/bin/ssh");
    await click(byRole("button", "Add argument"));
    await type(byRole("textbox", "Argument 1") as HTMLInputElement, "-W");
    await click(byRole("button", "Save route"));
    await waitFor(() => dialogWith("Read the commands of agent") !== null, "the confirmation");
    const dialog = dialogWith("Read the commands of agent")!;
    expect(dialog.textContent).toContain("/usr/bin/ssh");
    expect(dialog.textContent).toContain("-W");
    expect(await axeViolations(dialog)).toEqual([]);
    await click(byRole("button", "Let this route run it"));
    await waitFor(() => saved.length === 1, "the confirmed route");
    expect(saved[0]!.confirmed).toBe(true);
  });
});

describe("Connect through", () => {
  test("Direct by default, a route's small path, and Route missing never turns Direct on its own", async () => {
    const fake = createFakeServices();
    fake.server.routes = [route()];
    await reloadRoutes(fake.services.client);
    const changes: (string | null)[] = [];
    const view = (fields: Record<string, unknown>) =>
      render(
        <ServicesContext.Provider value={fake.services}>
          <ConnectThrough client={fake.services.client} tool="temporal" fields={fields} shared={false} onChange={(id) => changes.push(id)} />
        </ServicesContext.Provider>,
      );
    const direct = view({ address: "t:7233" });
    await settle();
    expect(document.body.textContent).toContain("Direct: the server connects to the target itself");
    direct.unmount();

    const through = view({ address: "t:7233", routeId: "R1" });
    await settle();
    expect(document.querySelector("svg[data-path-figure='small']")?.getAttribute("aria-label")).toMatch(/target t:7233/);
    expect(await axeViolations(document.body)).toEqual([]);
    through.unmount();

    view({ address: "t:7233", routeId: "GONE" });
    await settle();
    expect(document.body.textContent).toContain("Route missing");
    expect(changes).toEqual([]);
    await click(byRole("button", "Connect Direct…"));
    await waitFor(() => dialogWith("Connect Direct?") !== null, "the confirmation");
    await click(byRole("button", "Connect Direct"));
    expect(changes).toEqual([null]);
  });
});

describe("export and import", () => {
  test("a file carries the routes its profiles name, their proxies and SSH hosts, never a secret value", async () => {
    const { exportFile, planImport, remapHop } = await import("@/profiles/transfer");
    const withCommand = route({
      id: "R2",
      name: "agent",
      hops: [
        { kind: "command", label: "tsh", program: "/usr/bin/tsh", args: ["proxy", "ssh"], env: [{ name: "TOKEN", secret: true, set: true }, { name: "MODE", secret: false, value: "x", set: true }], linkId: "L9", needsConfirmation: true },
        ...route().hops,
      ],
    });
    const proxy = { id: "P1", name: "corp", fields: { kind: "socks5" as const, host: "proxy.corp", port: 1080, tls: false, username: "u", caPem: null }, url: "socks5://proxy.corp:1080", owner: { kind: "personal" as const }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 };
    const host = { id: "H1", name: "bastion", fields: LOGIN, owner: { kind: "personal" as const }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 };
    const profile = { id: "T1", tool: "temporal", version: 1, name: "Prod", createdAt: "", updatedAt: "", fields: { address: "t:7233", routeId: "R2" }, secrets: {}, extras: {} };
    const file = exportFile([profile], { includeSecrets: false, app: "test", routes: [route(), withCommand], proxies: [proxy], hosts: [host] });
    expect(file.routes?.map((r) => r.id)).toEqual(["R2"]);
    expect(file.proxies?.map((p) => p.id)).toEqual(["P1"]);
    expect(file.sshHosts?.map((h) => h.id)).toEqual(["H1"]);
    const command = file.routes?.[0]?.hops[0];
    expect(command).toMatchObject({ kind: "command", env: [{ name: "TOKEN", secret: true, value: null }, { name: "MODE", secret: false, value: "x" }] });
    const plan = planImport(JSON.stringify(file), [], () => undefined);
    expect(plan.routes.map((r) => r.id)).toEqual(["R2"]);
    expect(plan.proxies.map((p) => p.id)).toEqual(["P1"]);
    const ids = new Map([["P1", "P9"], ["H1", "H9"]]);
    expect(remapHop({ kind: "proxy", proxyId: "P1" }, ids)).toEqual({ kind: "proxy", proxyId: "P9" });
    expect(remapHop({ kind: "sshCommand", sshHostId: "H1", command: "nc" }, ids)).toEqual({ kind: "sshCommand", sshHostId: "H9", command: "nc" });
  });
});
