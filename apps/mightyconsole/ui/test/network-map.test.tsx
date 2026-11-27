// The network map in the UI (DOC-23 §10, (aa) to (ad), TSK-145; mockup frames routes-map,
// routes-map-edge, routes-map-add, routes-map-test): nodes and links drawn from the server's rows,
// the way in a node has, dragging from a dot to link two nodes (and the refusal when it may not),
// the link panel with its method and a command's confirmation, Test route link by link with "Use SSH
// command instead", Save as route, Delete on a link, and "Connect to…" doing what dragging does.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ServicesContext } from "@/app/client";
import { SettingsDialog } from "@/app/dialogs/SettingsDialog";
import { NetworkMap } from "@/app/map/NetworkMap";
import { DEFAULT_SETTINGS } from "@/app/store";
import type { LinkView, Method, Node, ProxyView } from "@/gen/api";
import { reloadLinks, resetLinks } from "@/profiles/links";
import { reloadRoutes, resetRoutes } from "@/profiles/routes";
import { reloadSshHosts, resetSshHosts } from "@/profiles/ssh-hosts";
import { createFakeServices } from "./support/fake-services";

type Fake = ReturnType<typeof createFakeServices>;
import { axeViolations, byRole, cleanup, click, key, render, settle, waitFor } from "./support/render";

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    // No storage in this run.
  }
});
afterEach(() => {
  cleanup();
  resetRoutes();
  resetSshHosts();
  resetLinks();
});

const LOGIN = { host: "bastion.prod", port: 22, username: "deploy", auth: "agent" as const, keepaliveSec: null, hostKey: null };
const SERVER: Node = { kind: "server" };
const H = (id: string): Node => ({ kind: "sshHost", id });
const P = (id: string): Node => ({ kind: "proxy", id });

let order = 0;
function link(id: string, from: Node, to: Node, method: Method, patch: Partial<LinkView> = {}): LinkView {
  const cmd = method === "command" || method === "sshCommand";
  return { id, from, to, method, args: [], env: [], needsConfirmation: cmd, owner: { kind: "personal" }, etag: "1", createdAt: String(++order).padStart(4, "0"), updatedAt: "", createdBy: "", updatedBy: "", access: "owner", usedBy: [], usedByHidden: 0, ...patch };
}

const proxyView = (id: string, name: string): ProxyView => ({ id, name, fields: { kind: "socks5", host: "proxy.corp", port: 1080, tls: false, username: null, caPem: null }, url: "socks5://proxy.corp:1080", owner: { kind: "personal" }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 });

/** corp (SOCKS5) → bastion → docker1, and docker1 also reached directly; lab alone. */
async function setup() {
  order = 0;
  const fake = createFakeServices();
  const bastion = fake.storeSshHost("bastion", LOGIN);
  const docker = fake.storeSshHost("docker1", { ...LOGIN, host: "docker1.internal" });
  const lab = fake.storeSshHost("lab", { ...LOGIN, host: "lab-gw.internal" });
  fake.server.proxies = [proxyView("PX", "corp")];
  fake.server.links = [link("e1", SERVER, P("PX"), "tcp"), link("e2", P("PX"), H(bastion), "connect"), link("e3", H(bastion), H(docker), "ssh"), link("e4", SERVER, H(docker), "tcp")];
  const client = fake.services.client;
  await Promise.all([reloadSshHosts(client), reloadRoutes(client), reloadLinks(client)]);
  return { fake, ids: { bastion, docker, lab } };
}

async function open(fake: Fake, profiles: { id: string; tool: string; name: string; fields: Record<string, unknown> }[] = []) {
  const view = render(
    <ServicesContext.Provider value={fake.services}>
      <NetworkMap client={fake.services.client} profiles={profiles} />
    </ServicesContext.Provider>,
  );
  await settle();
  return view;
}

const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure);
const node = (name: string): SVGGElement => document.querySelector<SVGGElement>(`[data-n][aria-label^="${name},"]`)!;
const edge = (from: string, to: string): SVGGElement => document.querySelector<SVGGElement>(`[data-e][aria-label^="Link ${from} to ${to},"]`)!;
const panel = () => document.querySelector<HTMLElement>("aside[aria-label='Details']")!;
const status = () => document.querySelector<HTMLElement>("[role='status']")!.textContent ?? "";

/** The centre of a node's box in the map's coordinates (jsdom has no layout: client = map). */
function centre(name: string): { x: number; y: number } {
  const g = node(name);
  const [, x, y] = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(g.getAttribute("transform") ?? "")!;
  const rect = g.querySelector("rect")!;
  return { x: Number(x) + Number(rect.getAttribute("width")) / 2, y: Number(y) + Number(rect.getAttribute("height")) / 2 };
}

/** Drags from a node's dot to a point, releasing there. */
async function dragDot(from: string, to: { x: number; y: number }) {
  const dot = node(from).querySelector<SVGCircleElement>("[data-hd]")!;
  const svg = document.querySelector("svg[aria-label^='Network map']")!;
  const init = (p: { x: number; y: number }) => ({ bubbles: true, cancelable: true, pointerId: 1, clientX: p.x, clientY: p.y, isPrimary: true });
  await act(async () => {
    dot.dispatchEvent(new PointerEvent("pointerdown", init(centre(from))));
  });
  await act(async () => {
    svg.dispatchEvent(new PointerEvent("pointermove", init(to)));
  });
  await act(async () => {
    svg.dispatchEvent(new PointerEvent("pointerup", init(to)));
  });
  await settle();
}

describe("the map", () => {
  test("draws every node and link from the server's rows, and nothing in it is a violation", async () => {
    const { fake } = await setup();
    await open(fake);
    expect(document.body.textContent).toContain("5 nodes · 4 links");
    for (const name of ["This server", "corp", "bastion", "docker1", "lab"]) expect(node(name), name).toBeTruthy();
    expect(edge("This server", "corp")).toBeTruthy();
    expect(edge("corp", "bastion").getAttribute("aria-label")).toMatch(/SOCKS5/);
    expect(edge("bastion", "docker1").getAttribute("aria-label")).toMatch(/SSH channel/);
    expect(await axeViolations(document.body)).toEqual([]);
  });

  test("a node with two ways in has one chosen, the route to it follows, and the choice is kept", async () => {
    const { fake } = await setup();
    await open(fake);
    await click(node("docker1"));
    const steps = () => [...panel().querySelectorAll("ol li")].map((li) => li.textContent);
    expect(panel().textContent).toContain("Route to here");
    // The first way in is the long one; the other is direct.
    expect(steps().length).toBe(3);
    await click([...panel().querySelectorAll("button")].find((b) => /This server · TCP/.test(b.textContent ?? ""))!);
    await waitFor(() => steps().length === 1, "the direct way");
    expect(JSON.parse(localStorage.getItem("mightyconsole.network-map.v1") ?? "{}").via["host:" + [...fake.server.sshHosts.keys()][1]]).toBe("e4");
  });

  test("a click on a link opens its panel with the methods its source allows", async () => {
    const { fake } = await setup();
    await open(fake);
    await click(edge("bastion", "docker1"));
    const p = panel();
    expect(p.textContent).toContain("bastion → docker1");
    expect(p.textContent).toContain("SSH channel");
    expect(p.textContent).toContain("SSH command");
    expect(p.textContent).toContain("direct-tcpip");
    await click(edge("corp", "bastion"));
    expect(panel().textContent).toContain("A proxy has one way");
  });
});

describe("linking", () => {
  test("dragging from the dot of a node to another links them with the first method the source allows", async () => {
    const { fake, ids } = await setup();
    await open(fake);
    await dragDot("This server", centre("lab"));
    await waitFor(() => calls(fake, "links.create").length === 1, "the link");
    expect(calls(fake, "links.create")[0]!.input).toMatchObject({ owner: { kind: "personal" }, from: { kind: "server" }, to: { kind: "sshHost", id: ids.lab }, spec: { method: "tcp" } });
    await waitFor(() => edge("This server", "lab") !== null, "the new link");
    expect(status()).toContain("Linked This server to lab");
    expect(panel().textContent).toContain("This server → lab");
  });

  test("a refusal says why and creates nothing", async () => {
    const { fake } = await setup();
    await open(fake);
    await dragDot("docker1", centre("This server"));
    expect(status()).toBe("Nothing connects into this server.");
    await dragDot("docker1", centre("bastion"));
    expect(status()).toBe("That would make a loop.");
    await dragDot("bastion", centre("docker1"));
    expect(status()).toMatch(/bastion already reaches docker1/);
    expect(calls(fake, "links.create")).toEqual([]);
  });

  test("Connect to… does what dragging does, and lists only the nodes that may be reached", async () => {
    const { fake, ids } = await setup();
    await open(fake);
    await click(node("lab"));
    await click(byRole("combobox", "Connect lab to", panel()));
    const options = [...document.querySelectorAll("[role='option']")].map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(["bastion", "docker1"]));
    expect(options).not.toContain("This server");
    expect(options).not.toContain("lab");
    await click(byRole("option", "docker1"));
    await waitFor(() => calls(fake, "links.create").length === 1, "the link");
    expect(calls(fake, "links.create")[0]!.input).toMatchObject({ from: { kind: "sshHost", id: ids.lab }, to: { kind: "sshHost", id: ids.docker }, spec: { method: "ssh" } });
  });

  test("Delete on a focused link removes it", async () => {
    const { fake } = await setup();
    await open(fake);
    const e = edge("This server", "docker1");
    e.focus();
    await key("Delete", {}, e);
    await waitFor(() => calls(fake, "links.delete").length === 1, "the delete");
    expect(calls(fake, "links.delete")[0]!.input).toEqual({ id: "e4" });
    await waitFor(() => document.body.textContent?.includes("4 nodes · 3 links") === false && document.body.textContent?.includes("5 nodes · 3 links") === true, "the link gone");
  });
});

describe("a command link", () => {
  test("is not confirmed until read; changing what it runs asks again", async () => {
    const { fake, ids } = await setup();
    fake.server.links.push(link("c1", SERVER, H(ids.lab), "command", { program: "tsh", args: ["proxy", "ssh", "{host}:{port}"] }));
    await reloadLinks(fake.services.client);
    await open(fake);
    await click(edge("This server", "lab"));
    expect(panel().textContent).toContain("Not confirmed");
    expect(panel().textContent).toContain("tsh proxy ssh lab-gw.internal:22");
    expect(edge("This server", "lab").getAttribute("aria-label")).toMatch(/not confirmed/);
    await click(byRole("button", "Confirm it may run", panel()));
    await waitFor(() => calls(fake, "links.confirm").length === 1, "the confirmation");
    await waitFor(() => !panel().textContent?.includes("Not confirmed"), "confirmed");

    // Another argument: saved on Save link, and the confirmation is gone.
    const args = panel().querySelector<HTMLTextAreaElement>("textarea")!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(args, "-v\nproxy\nssh\n{host}:{port}");
      args.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settle();
    expect(panel().textContent).toContain("the confirmation is cleared");
    await click(byRole("button", "Save link", panel()));
    await waitFor(() => calls(fake, "links.update").length === 1, "the update");
    expect(calls(fake, "links.update")[0]!.input).toMatchObject({ id: "c1", spec: { method: "command", program: "tsh", args: ["-v", "proxy", "ssh", "{host}:{port}"] } });
    await waitFor(() => panel().textContent?.includes("Not confirmed") === true, "not confirmed again");
  });

  test("a method with nothing to read is saved at once; a command waits for Save link", async () => {
    const { fake } = await setup();
    await open(fake);
    await click(edge("bastion", "docker1"));
    await click([...panel().querySelectorAll("button")].find((b) => b.textContent === "SSH command")!);
    expect(calls(fake, "links.update")).toEqual([]);
    expect(panel().querySelector<HTMLInputElement>("input")!.value).toBe("nc {host} {port}");
    await click(byRole("button", "Save link", panel()));
    await waitFor(() => calls(fake, "links.update").length === 1, "the update");
    expect(calls(fake, "links.update")[0]!.input).toMatchObject({ id: "e3", spec: { method: "sshCommand", command: "nc {host} {port}" } });
  });
});

describe("Test and Save as route", () => {
  test("Test sends the hops of the path and colours each link; a refusal offers an SSH command", async () => {
    const { fake } = await setup();
    await open(fake);
    await click(node("docker1"));
    await click(byRole("button", "Test route", panel()));
    await waitFor(() => calls(fake, "routes.test").length === 1, "the test");
    const sent = calls(fake, "routes.test")[0]!.input as { hops: unknown[]; target: unknown };
    expect(sent.target).toEqual({ host: "docker1.internal", port: 22 });
    expect(sent.hops).toMatchObject([{ kind: "proxy", proxyId: "PX" }, { kind: "ssh" }]);
    await waitFor(() => edge("bastion", "docker1").getAttribute("data-state") === "ok", "the links coloured");
    expect(status()).toContain("reached the end");

    // The host refuses to forward.
    fake.server.routeTest = {
      lines: [
        { hop: { index: 0, kind: "socks5", label: "proxy.corp:1080" }, ok: true, ms: 3 },
        { hop: { index: 1, kind: "ssh", label: "bastion.prod:22" }, ok: true, ms: 8 },
        { hop: { index: 2, kind: "target", label: "docker1.internal:22" }, ok: false, ms: 5, failure: "Forbidden", error: { kind: "Forbidden", system: "routes", message: "bastion refused to forward to docker1.internal:22", retryable: false } },
      ],
      hops: 2,
      ms: 16,
    };
    await click(byRole("button", "Test route", panel()));
    await waitFor(() => edge("bastion", "docker1").getAttribute("data-state") === "bad", "the refused link");
    expect(panel().textContent).toContain("bastion refused to forward");
    expect(status()).toContain("stopped at bastion → docker1");
    await click(byRole("button", "Use SSH command instead", panel()));
    await waitFor(() => calls(fake, "links.update").length === 1, "the switch");
    expect(calls(fake, "links.update")[0]!.input).toMatchObject({ id: "e3", spec: { method: "sshCommand" } });
    await waitFor(() => status().includes("Switched to SSH command"), "the note");
  });

  test("a path through a command that nobody confirmed cannot be tested", async () => {
    const { fake, ids } = await setup();
    fake.server.links.push(link("c1", SERVER, H(ids.lab), "command", { program: "tsh" }));
    await reloadLinks(fake.services.client);
    await open(fake);
    await click(node("lab"));
    expect(panel().textContent).toContain("not confirmed");
    expect((byRole("button", "Test route", panel()) as HTMLButtonElement).disabled).toBe(true);
    expect(calls(fake, "routes.test")).toEqual([]);
  });

  test("Save as route saves the path ending at the node, named after it", async () => {
    const { fake } = await setup();
    await open(fake);
    await click(node("docker1"));
    const name = byRole("textbox", "Route name", panel()) as HTMLInputElement;
    expect(name.value).toBe("docker1");
    await click(byRole("button", "Save as route", panel()));
    await waitFor(() => calls(fake, "routes.create").length === 1, "the route");
    expect(calls(fake, "routes.create")[0]!.input).toMatchObject({ name: "docker1", owner: { kind: "personal" }, hops: [{ kind: "proxy", proxyId: "PX" }, { kind: "ssh" }, { kind: "ssh" }] });
    await waitFor(() => status().includes('Saved as the route "docker1"'), "the note");
  });

  test("a profile's target is drawn from its route and reached through it", async () => {
    const { fake, ids } = await setup();
    const last = link("e5", H(ids.docker), { kind: "target" }, "ssh", { usedBy: [{ id: "R1", tool: "route", name: "prod" }] });
    fake.server.links.push(last);
    fake.server.routes = [{ id: "R1", name: "prod", kind: "path", hops: [{ kind: "ssh", label: "docker1.internal:22", sshHostId: ids.docker, linkId: "e5", needsConfirmation: false, args: [], env: [] }], confirmed: true, owner: { kind: "personal" }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", usedBy: [], usedByHidden: 0 }];
    await Promise.all([reloadLinks(fake.services.client), reloadRoutes(fake.services.client)]);
    await open(fake, [{ id: "T1", tool: "temporal", name: "prod-cluster", fields: { address: "temporal.prod.internal:7233", routeId: "R1" } }]);
    expect(node("prod-cluster")).toBeTruthy();
    expect(edge("docker1", "prod-cluster").getAttribute("aria-label")).toMatch(/SSH channel/);
    await click(node("prod-cluster"));
    expect(panel().textContent).toContain("temporal.prod.internal:7233");
    // A profile's target takes no new link and cannot be removed here.
    await dragDot("lab", centre("prod-cluster"));
    expect(status()).toMatch(/profile's target/);
    expect(byRole("button", "Remove node", panel())).toBeNull();
    // The link a route ends with cannot be removed while the route uses it.
    await click(edge("docker1", "prod-cluster"));
    expect((byRole("button", "Remove link", panel()) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("adding nodes", () => {
  test("a target added here is kept in this browser, linked to, tested and removed with its links", async () => {
    const { fake } = await setup();
    await open(fake);
    await click(byRole("button", "Target"));
    const dialog = document.querySelector<HTMLElement>("[role='dialog']")!;
    const inputs = dialog.querySelectorAll("input");
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(inputs[0], "staging");
      inputs[0]!.dispatchEvent(new Event("input", { bubbles: true }));
      set.call(inputs[1], "svc.internal:443");
      inputs[1]!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(byRole("button", "Add target", dialog));
    await waitFor(() => node("staging") !== null, "the target");
    expect(JSON.parse(localStorage.getItem("mightyconsole.network-map.v1")!).scratch.targets).toMatchObject([{ name: "staging", address: "svc.internal:443" }]);

    await dragDot("docker1", centre("staging"));
    await waitFor(() => edge("docker1", "staging") !== null, "the link");
    // A link to a target of this browser is not saved on the server.
    expect(calls(fake, "links.create")).toEqual([]);
    await click(node("staging"));
    await click(byRole("button", "Test route", panel()));
    await waitFor(() => calls(fake, "routes.test").length === 1, "the test");
    expect(calls(fake, "routes.test")[0]!.input).toMatchObject({ target: { host: "svc.internal", port: 443 } });

    await click(byRole("button", "Remove node", panel()));
    await click(byRole("button", "Remove staging"));
    await waitFor(() => document.querySelector("[data-n][aria-label^='staging,']") === null, "the node gone");
    expect(document.querySelector("[data-e][aria-label^='Link docker1 to staging']")).toBeNull();
  });
});

describe("Settings → Network map", () => {
  test("is a tab of Settings, and only that tab lets the dialog grow to the window", async () => {
    const { fake } = await setup();
    render(
      <ServicesContext.Provider value={fake.services}>
        <SettingsDialog
          open
          onOpenChange={() => undefined}
          settings={DEFAULT_SETTINGS}
          onChange={() => undefined}
          serverAddress="https://localhost"
          storageKind="indexeddb"
          profileCount={0}
          storageUsed={async () => 0}
          onExportAll={() => undefined}
          onImport={() => undefined}
          onForgetEverything={async () => undefined}
          client={fake.services.client}
          profiles={[]}
        />
      </ServicesContext.Provider>,
    );
    await settle();
    const popup = () => document.querySelector<HTMLElement>("[data-slot='dialog-popup']") ?? document.querySelector<HTMLElement>("[role='dialog']")!;
    expect(popup().className).not.toContain("max-w-none");
    await click(byRole("tab", "Network map"));
    await waitFor(() => document.querySelector("[data-testid='network-map']") !== null, "the map");
    expect(popup().className).toContain("max-w-none");
    expect(document.body.textContent).toContain("5 nodes · 4 links");
    await click(byRole("tab", "Routes"));
    expect(popup().className).not.toContain("max-w-none");
  });
});
