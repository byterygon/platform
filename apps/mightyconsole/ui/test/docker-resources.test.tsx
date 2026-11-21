// The Docker tool's images, volumes and networks, TSK-81 batch 3 (Mightyconsole spec §10.4 to
// §10.6, mockup frames docker-images and docker-volumes): the helpers (a row per tag, the
// repository and tag of a registry with a port, the refusals' reasons), and the three tabs against
// the fake host: Used by with links to the containers, the filters, Inspect in a sheet, Remove off
// with its reason for an item in use, a tag taken off, a volume removed by typing its name, a
// predefined network kept, a list reloaded by an event, the tree's nodes and routes. Axe on each.
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import { NoticeContext, type Notice } from "@/app/page";
import type { ProfileRecord } from "@/profiles/record";
import { dockerTool } from "@/tools/docker";
import { ImagesTab, imageLines, matchesImage, splitTag, untagsOnly } from "@/tools/docker/ImagesTab";
import { NetworksTab, networkRefusal } from "@/tools/docker/NetworksTab";
import { profile as schema } from "@/tools/docker/profile";
import { changesUsers, namesText, removeOutcome } from "@/tools/docker/resources";
import { VolumesTab, volumeRefusal } from "@/tools/docker/VolumesTab";
import type { TabProps, TabView } from "@/tools/types";
import { createFakeServices, fakeImages, fakeNetworks, fakeVolumes } from "./support/fake-services";
import { act, axeViolations, byRole, byText, cleanup, click, key, render, type, waitFor } from "./support/render";

afterEach(cleanup);

type Fake = ReturnType<typeof createFakeServices>;

async function connected(): Promise<{ fake: Fake; connId: string }> {
  const fake = createFakeServices();
  const out = await fake.services.client.docker.connect({ profile: { name: "build-host", host: "h", username: "u", hostKey: { algorithm: "ssh-ed25519", fingerprintSha256: "SHA256:q7Lw3Gm0bX9yT2vR8cKpN5sUe1JhAa4FzQ6dWiYoV0E" } } });
  return { fake, connId: out.connId };
}

function props(fake: Fake, connId: string, tab: Partial<TabView> & { kind: string; params: Record<string, unknown> }) {
  const profile: ProfileRecord = { id: "01D", tool: "docker", version: 1, name: "build-host", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const openTab = vi.fn();
  const go = vi.fn();
  const p: TabProps = { tab: { id: "t", tool: "docker", profileId: "01D", title: "t", pinned: false, ...tab }, profile, connId, client: fake.services.client as MightyClient, active: true, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab, go, navigate: vi.fn() };
  return { p, openTab, go };
}

const withNotices = (ui: React.ReactNode, notices: Notice[]) => <NoticeContext.Provider value={(n) => notices.push(n)}>{ui}</NoticeContext.Provider>;
const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure).map((c) => c.input as Record<string, unknown>);
const rowOf = (table: string, text: string) => Array.from(document.querySelectorAll<HTMLElement>(`table[aria-label='${table}'] tbody tr`)).find((r) => r.textContent?.includes(text)) ?? null;

describe("helpers", () => {
  test("a row per tag; digests and dangling ones; repository and tag with a registry port", () => {
    expect(splitTag("registry.lan:5000/tools/jq:1.7")).toEqual({ repository: "registry.lan:5000/tools/jq", tag: "1.7" });
    expect(splitTag("registry.lan:5000/tools/jq")).toEqual({ repository: "registry.lan:5000/tools/jq", tag: "latest" });
    const lines = imageLines(fakeImages());
    expect(lines.map((l) => `${l.repository}:${l.tag}`)).toEqual(["alpine:3.21", "busybox:<none>", "ghcr.io/acme/shop-api:2.4.1", "ghcr.io/acme/shop-api:latest", "registry.lan:5000/tools/jq:1.7", "<none>:<none>"]);
    const digest = lines[1]!;
    expect(digest.ref).toBe(digest.image.id);
    expect(digest.pull).toBe("busybox@sha256:a7db");
    expect(lines[5]!.pull).toBeUndefined();
    expect(untagsOnly(lines[2]!)).toBe(true);
    expect(untagsOnly(lines[0]!)).toBe(false);
    expect(matchesImage(lines[2]!, "a10000")).toBe(true);
    expect(matchesImage(lines[2]!, "jq")).toBe(false);
  });

  test("the reasons a remove is off, the names, the toast", () => {
    const [pg, backup, old] = fakeVolumes();
    expect(volumeRefusal(pg!)).toBe("In use by shop-db-1");
    expect(volumeRefusal(backup!)).toBe("In use by nightly-backup");
    expect(volumeRefusal(old!)).toBeNull();
    const networks = fakeNetworks();
    expect(networkRefusal(networks[0]!)).toBe("Every engine has bridge; Docker cannot remove it");
    expect(networkRefusal(networks[3]!)).toBe("shop-api-1 is attached and running; stop it first");
    // Stopped containers do not hold a network: Docker removes it, the dialog warns.
    expect(networkRefusal(networks[4]!)).toBeNull();
    const use = (name: string) => ({ name, state: "running" });
    expect(namesText([use("a"), use("b"), use("c")])).toBe("a, b and c");
    expect(namesText([use("a"), use("b"), use("c"), use("d")])).toBe("a, b and 2 more");
    expect(removeOutcome("volume", ["old-cache"], [])).toEqual({ title: "Removed old-cache", type: "success" });
    expect(removeOutcome("volume", [], [{ name: "x", error: "in use" }])).toEqual({ title: "Could not remove x", description: "in use", type: "warning" });
    expect(changesUsers({ kind: "container", action: "destroy", id: "x", attributes: {}, timeMs: 0 })).toBe(true);
    expect(changesUsers({ kind: "container", action: "exec_start: sh", id: "x", attributes: {}, timeMs: 0 })).toBe(false);
  });

  test("the tree's nodes and the routes /images, /volumes, /networks", () => {
    const nodes = dockerTool.sidebarTree({ profile: { id: "p", name: "build-host" } as ProfileRecord, connId: "none-yet" });
    expect(nodes.map((n) => n.label)).toEqual(["Containers", "Images", "Volumes", "Networks", "Host"]);
    expect(nodes[2]!.open).toMatchObject({ kind: "docker.volumes" });
    for (const kind of ["docker.images", "docker.volumes", "docker.networks"]) expect(dockerTool.tabKinds[kind]!.href!({})).toEqual({ path: kind.split(".")[1] });
  });
});

describe("images", () => {
  test("rows per tag with Used by; dangling behind a toggle; Only unused; Inspect; no axe violations", async () => {
    const { fake, connId } = await connected();
    const { p, go } = props(fake, connId, { kind: "docker.images", params: {} });
    const { container } = render(<ImagesTab {...p} />);
    await waitFor(() => rowOf("Images", "alpine") !== null, "the images");
    expect(byText(/build-host · 5 images · .* · 1 dangling \(412 MB\) hidden/)).not.toBeNull();
    expect(rowOf("Images", "e50000000000")).toBeNull();
    expect(rowOf("Images", "latest")!.textContent).toContain("shop-api-1");
    expect(await axeViolations(container)).toEqual([]);
    await waitFor(() => calls(fake, "docker.events").length === 1, "the events stream");
    expect(calls(fake, "docker.events")[0]).toMatchObject({ types: ["image", "container"] });

    await click(byRole("checkbox", /Show dangling/) ?? container.querySelectorAll<HTMLElement>("[role=checkbox]")[0]!);
    await waitFor(() => rowOf("Images", "e50000000000") !== null, "the dangling one");
    await click(container.querySelectorAll<HTMLElement>("[role=checkbox]")[1]!);
    await waitFor(() => rowOf("Images", "alpine") === null, "only unused");
    expect(rowOf("Images", "jq")).not.toBeNull();

    // A container in Used by is a link to it.
    await click(container.querySelectorAll<HTMLElement>("[role=checkbox]")[1]!);
    await waitFor(() => rowOf("Images", "alpine") !== null, "all again");
    await click(byRole("button", "nightly-backup, exited"));
    expect(go).toHaveBeenCalledWith(expect.objectContaining({ kind: "docker.container", params: { id: "nightly-backup", view: "overview" } }), expect.anything());

    await click(byRole("button", "Actions for alpine:3.21"));
    await click(byRole("menuitem", /Inspect/));
    await waitFor(() => byText("docker image inspect alpine:3.21") !== null, "the inspect sheet");
    await waitFor(() => byRole("tree") !== null || byText(/RepoTags/) !== null, "the JSON");
    expect(calls(fake, "docker.images.inspect")[0]).toMatchObject({ id: fakeImages()[1]!.id });
    expect(await axeViolations()).toEqual([]);
  });

  test("Remove is off for an image a running container uses; a tag is taken off; Force for a stopped user", async () => {
    const { fake, connId } = await connected();
    const notices: Notice[] = [];
    const { p } = props(fake, connId, { kind: "docker.images", params: {} });
    render(withNotices(<ImagesTab {...p} />, notices));
    await waitFor(() => rowOf("Images", "alpine") !== null, "the images");

    // shop-api runs: Remove is off and the menu says why. Its two tags: removing one only untags.
    fake.server.dockerImages[0]!.usedBy = [{ name: "shop-api-1", state: "running" }];
    await click(byRole("button", "Actions for ghcr.io/acme/shop-api:2.4.1"));
    expect(byRole("menuitem", /Remove/)!.getAttribute("aria-disabled")).toBe("true");
    expect(byText(/Used by 1 running container \(shop-api-1\)/)).not.toBeNull();
    // The container stops: the event reloads the list and the open menu's Remove turns on.
    fake.server.dockerImages[0]!.usedBy = [];
    await act(async () => {
      for (const push of fake.server.dockerPush.events) push([{ kind: "container", action: "die", id: "x", name: "shop-api-1", attributes: {}, timeMs: Date.now() }]);
    });
    await waitFor(() => calls(fake, "docker.images.list").length >= 2, "the reload after the event");
    await waitFor(() => byRole("menuitem", /Remove/)?.getAttribute("aria-disabled") !== "true", "Remove on");
    await click(byRole("menuitem", /Remove/));
    await waitFor(() => byRole("alertdialog") !== null, "the dialog");
    expect(byText(/Only the tag goes: .* ghcr.io\/acme\/shop-api:latest/)).not.toBeNull();
    await click(byRole("button", "Remove tag"));
    await waitFor(() => notices.length === 1, "the notice");
    expect(notices[0]).toMatchObject({ title: "Removed ghcr.io/acme/shop-api:2.4.1", type: "success" });
    expect(calls(fake, "docker.images.remove")[0]).toMatchObject({ ids: ["ghcr.io/acme/shop-api:2.4.1"], force: false });

    // alpine: a stopped container uses it; refused without Force, removed with it.
    await click(byRole("button", "Actions for alpine:3.21"));
    await click(byRole("menuitem", /Remove/));
    await waitFor(() => byText(/Stopped containers use it: nightly-backup/) !== null, "the warning");
    await click(byRole("button", "Remove image"));
    await waitFor(() => notices.length === 2, "the refusal");
    expect(notices[1]).toMatchObject({ title: "Could not remove alpine:3.21", type: "warning" });
    await click(byRole("button", "Actions for alpine:3.21"));
    await click(byRole("menuitem", /Remove/));
    await waitFor(() => byRole("alertdialog") !== null, "the dialog again");
    await click(byRole("checkbox", /Force/));
    await click(byRole("button", "Remove image"));
    await waitFor(() => notices.length === 3, "the removal");
    expect(notices[2]!.title).toBe("Removed alpine:3.21");
    await waitFor(() => rowOf("Images", "alpine") === null, "the row gone");
  });
});

describe("volumes and networks", () => {
  test("Volumes: sizes and users; Remove off in use; removed by typing its name; no axe violations", async () => {
    const { fake, connId } = await connected();
    const notices: Notice[] = [];
    const { p } = props(fake, connId, { kind: "docker.volumes", params: {} });
    const { container } = render(withNotices(<VolumesTab {...p} />, notices));
    await waitFor(() => rowOf("Volumes", "old-cache") !== null, "the volumes");
    expect(byText(/build-host · 3 volumes · 2.7 GB · 1 unused/)).not.toBeNull();
    expect(rowOf("Volumes", "shop_pgdata")!.textContent).toContain("1.9 GB");
    expect(byText("Size from /system/df")).not.toBeNull();
    expect(byRole("button", "Remove shop_pgdata: In use by shop-db-1")!.getAttribute("aria-disabled")).toBe("true");
    expect(byRole("button", "Remove backup-cache: In use by nightly-backup")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    await click(byRole("button", /^Unused/));
    await waitFor(() => rowOf("Volumes", "shop_pgdata") === null, "only unused");
    await click(byRole("button", "Remove old-cache"));
    await waitFor(() => byRole("alertdialog") !== null, "the dialog");
    expect(byText(/740 MB of data on build-host are deleted/)).not.toBeNull();
    const confirm = byRole("button", "Remove volume")!;
    expect(confirm.hasAttribute("disabled") || confirm.getAttribute("aria-disabled") === "true").toBe(true);
    await type(document.querySelector<HTMLInputElement>("[role=alertdialog] input")!, "old-ca");
    expect(byRole("button", "Remove volume")!.hasAttribute("disabled") || byRole("button", "Remove volume")!.getAttribute("aria-disabled") === "true").toBe(true);
    expect(await axeViolations()).toEqual([]);
    await type(document.querySelector<HTMLInputElement>("[role=alertdialog] input")!, "old-cache");
    await click(byRole("button", "Remove volume"));
    await waitFor(() => notices.length === 1, "the notice");
    expect(notices[0]).toMatchObject({ title: "Removed old-cache", type: "success" });
    expect(calls(fake, "docker.volumes.remove")[0]).toMatchObject({ names: ["old-cache"] });
    await waitFor(() => rowOf("Volumes", "old-cache") === null, "the row gone");
  });

  test("Volumes without sizes say why", async () => {
    const { fake, connId } = await connected();
    fake.server.dockerDfError = "Docker did not answer /system/df within 30 s";
    const { p } = props(fake, connId, { kind: "docker.volumes", params: {} });
    render(<VolumesTab {...p} />);
    await waitFor(() => rowOf("Volumes", "old-cache") !== null, "the volumes");
    expect(byText(/No sizes: \/system\/df failed \(Docker did not answer/)).not.toBeNull();
    expect(byText(/build-host · 3 volumes · 1 unused/)).not.toBeNull();
  });

  test("Networks: predefined first and kept; subnets; a stopped user is named; Inspect; no axe violations", async () => {
    const { fake, connId } = await connected();
    const notices: Notice[] = [];
    const { p } = props(fake, connId, { kind: "docker.networks", params: {} });
    const { container } = render(withNotices(<NetworksTab {...p} />, notices));
    await waitFor(() => rowOf("Networks", "batch") !== null, "the networks");
    const names = Array.from(document.querySelectorAll("table[aria-label='Networks'] tbody tr")).map((r) => r.querySelector(".font-mono")?.textContent);
    expect(names).toEqual(["bridge", "host", "none", "batch", "shop_default"]);
    expect(rowOf("Networks", "shop_default")!.textContent).toContain("172.18.0.0/16 · 172.18.0.1");
    expect(byRole("button", "Remove bridge: Every engine has bridge; Docker cannot remove it")!.getAttribute("aria-disabled")).toBe("true");
    expect(byRole("button", /^Remove shop_default: shop-api-1 is attached/)).not.toBeNull();
    expect(byText(/build-host · 5 networks · 1 unused/)).toBeNull();
    expect(byText(/build-host · 5 networks · 0 unused/)).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    await click(byRole("button", "Inspect shop_default"));
    await waitFor(() => byText("docker network inspect shop_default") !== null, "the sheet");
    expect(calls(fake, "docker.networks.inspect")[0]).toMatchObject({ id: "shop_default-id" });
    await key("Escape");
    await waitFor(() => byText("docker network inspect shop_default") === null, "the sheet closed");

    await click(byRole("button", "Remove batch"));
    await waitFor(() => byText(/The stopped container nightly-backup is attached/) !== null, "the warning");
    await click(byRole("button", "Remove network"));
    await waitFor(() => notices.length === 1, "the notice");
    expect(notices[0]!.title).toBe("Removed batch");
    await waitFor(() => rowOf("Networks", "batch") === null, "the row gone");
  });
});
