// The Docker tool's extras on the Host page and in Stats, TSK-81 batch 4a (DOC-21 Open question
// 45 q, mockup frames docker-host and docker-stats): the helpers (an event as the list says it,
// the columns of `docker top` per host, a reclaimable share), the Host page's disk usage and its
// live events (a container event loads the facts again), a container's Processes asked every 5 s
// and kept still while the page is hidden, and the tree's counts from `docker.host.counts` and
// the tabs' lists. Axe on the Host page and the Stats view.
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { ProfileRecord } from "@/profiles/record";
import { dockerTool } from "@/tools/docker";
import { ContainerTab } from "@/tools/docker/ContainerTab";
import { eventText, processColumns } from "@/tools/docker/format";
import { HostTab, reclaimableText } from "@/tools/docker/HostTab";
import { TOP_INTERVAL_MS } from "@/tools/docker/ProcessesPanel";
import { profile as schema } from "@/tools/docker/profile";
import { VolumesTab } from "@/tools/docker/VolumesTab";
import type { TabProps, TabView } from "@/tools/types";
import { createFakeServices } from "./support/fake-services";
import { act, axeViolations, byText, cleanup, render, waitFor } from "./support/render";

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

type Fake = ReturnType<typeof createFakeServices>;

async function connected(): Promise<{ fake: Fake; connId: string }> {
  const fake = createFakeServices();
  const profileId = await fake.storeProfile("docker", "build-host", { host: "h", username: "u", hostKey: { algorithm: "ssh-ed25519", fingerprintSha256: "SHA256:q7Lw3Gm0bX9yT2vR8cKpN5sUe1JhAa4FzQ6dWiYoV0E" } });
  const out = await fake.services.client.docker.connect({ profileId });
  return { fake, connId: out.connId };
}

function props(fake: Fake, connId: string, tab: Partial<TabView> & { kind: string; params: Record<string, unknown> }): TabProps {
  const profile: ProfileRecord = { id: "01D", tool: "docker", version: 1, name: "build-host", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  return { tab: { id: "t", tool: "docker", profileId: "01D", title: "t", pinned: false, ...tab }, profile, connId, client: fake.services.client as MightyClient, active: true, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab: vi.fn(), go: vi.fn(), navigate: vi.fn() };
}

const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure).map((c) => c.input as Record<string, unknown>);
const rowOf = (table: string, text: string) => Array.from(document.querySelectorAll<HTMLElement>(`table[aria-label='${table}'] tbody tr`)).find((r) => r.textContent?.includes(text)) ?? null;
const eventOf = (text: string) => Array.from(document.querySelectorAll<HTMLElement>("ol[aria-label='Events'] li")).find((r) => r.textContent?.includes(text)) ?? null;
const push = (fake: Fake, event: Record<string, unknown>) => {
  for (const send of fake.server.dockerPush.events) send([{ attributes: {}, timeMs: Date.parse("2026-11-21T10:44:01Z"), ...event }]);
};

describe("helpers", () => {
  test("an event: the action without its argument, the name, the exit code", () => {
    expect(eventText({ kind: "container", action: "die", id: "aaa", name: "shop-worker-1", attributes: { exitCode: "1" }, timeMs: 0 })).toEqual({ action: "die", detail: "shop-worker-1 · exit 1" });
    expect(eventText({ kind: "container", action: "exec_start: sh -c ls", id: "aaa", name: "shop-api-1", attributes: {}, timeMs: 0 })).toEqual({ action: "exec_start", detail: "shop-api-1 · sh -c ls" });
    expect(eventText({ kind: "container", action: "health_status: unhealthy", id: "0123456789abcdef", attributes: {}, timeMs: 0 })).toEqual({ action: "health_status", detail: "0123456789ab · unhealthy" });
    expect(eventText({ kind: "network", action: "connect", id: "n1", attributes: { name: "shop_default", container: "aaa" }, timeMs: 0 })).toEqual({ action: "connect", detail: "shop_default" });
    expect(eventText({ kind: "volume", action: "mount", id: "shop_pgdata", attributes: {}, timeMs: 0 }).detail).toBe("shop_pgdata");
  });

  test("docker top's columns per host: ps -ef, BusyBox, and one without a CPU column", () => {
    expect(processColumns(["UID", "PID", "PPID", "C", "STIME", "TTY", "TIME", "CMD"])).toEqual({ pid: 1, user: 0, cpu: 3, command: 7 });
    expect(processColumns(["PID", "USER", "TIME", "COMMAND"])).toEqual({ pid: 0, user: 1, cpu: -1, command: 3 });
    expect(processColumns(["PID", "%CPU", "ARGS"])).toEqual({ pid: 0, user: -1, cpu: 1, command: 2 });
  });

  test("reclaimable with its share", () => {
    expect(reclaimableText({ count: 3, active: 1, size: 3_100_000_000, reclaimable: 1_200_000_000 })).toBe("1.2 GB (39 %)");
    expect(reclaimableText({ count: 0, active: 0, size: 0, reclaimable: 0 })).toBe("0 B");
  });
});

describe("the Host page", () => {
  test("disk usage per kind, events newest first, the facts loaded again after a container event; no axe violations", async () => {
    const { fake, connId } = await connected();
    const { container } = render(<HostTab {...props(fake, connId, { kind: "docker.host", params: {} })} />);
    await waitFor(() => rowOf("Disk usage", "Volumes") !== null, "the disk usage");
    expect(rowOf("Disk usage", "Images")!.textContent).toContain("3.1 GB");
    expect(rowOf("Disk usage", "Images")!.textContent).toContain("1.2 GB (39 %)");
    expect(rowOf("Disk usage", "Volumes")!.textContent).toContain("12.5 GB");
    expect(rowOf("Disk usage", "Containers")!.textContent).toMatch(/running/);
    expect(rowOf("Disk usage", "Build cache")!.textContent).toContain("0 B");
    expect(byText("None yet.")).not.toBeNull();
    await waitFor(() => fake.server.dockerPush.events.length > 0, "the events stream");
    const infos = calls(fake, "docker.host.info").length;
    await act(async () => {
      push(fake, { kind: "network", action: "connect", id: "n1", attributes: { name: "shop_default" } });
      push(fake, { kind: "container", action: "die", id: "aaa", name: "shop-worker-1", attributes: { exitCode: "1" }, timeMs: Date.parse("2026-11-21T10:44:02Z") });
    });
    await waitFor(() => eventOf("shop-worker-1 · exit 1") !== null, "the die event");
    const rows = Array.from(document.querySelectorAll("ol[aria-label='Events'] li")).map((r) => r.textContent);
    expect(rows[0]).toContain("container die");
    expect(rows[1]).toContain("network connect");
    await waitFor(() => calls(fake, "docker.host.info").length > infos, "the facts again");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a disk usage Docker cannot read says why and the facts stay", async () => {
    const { fake, connId } = await connected();
    fake.server.dockerDfError = "Docker did not answer /system/df within 30 s";
    render(<HostTab {...props(fake, connId, { kind: "docker.host", params: {} })} />);
    await waitFor(() => byText("Kernel") !== null, "the facts");
    await waitFor(() => document.body.textContent?.includes("/system/df within 30 s") === true, "the error");
    expect(document.querySelector("table[aria-label='Disk usage']")).toBeNull();
  });
});

describe("Processes", () => {
  test("beside the stats, asked every 5 s while visible, not while hidden; no axe violations", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fake, connId } = await connected();
    const { container } = render(<ContainerTab {...props(fake, connId, { kind: "docker.container", params: { id: "shop-web-1", view: "stats" }, title: "shop-web-1" })} />);
    await waitFor(() => rowOf("Processes", "gunicorn: worker") !== null, "the processes");
    const row = rowOf("Processes", "gunicorn: worker")!;
    expect(Array.from(row.querySelectorAll("td")).map((c) => c.textContent)).toEqual(["4188", "app", "11", "gunicorn: worker [shop.wsgi]"]);
    expect(calls(fake, "docker.containers.top")[0]).toMatchObject({ connId, id: "shop-web-1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TOP_INTERVAL_MS + 10);
    });
    expect(calls(fake, "docker.containers.top").length).toBe(2);
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(TOP_INTERVAL_MS * 3);
    });
    expect(calls(fake, "docker.containers.top").length).toBe(2);
    hidden.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls(fake, "docker.containers.top").length).toBe(3);
    hidden.mockRestore();
    vi.useRealTimers();
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("the tree's counts", () => {
  test("from docker.host.counts on connect, then from each tab's list", async () => {
    const { fake, connId } = await connected();
    const tree = () => dockerTool.sidebarTree({ profile: { id: "p", name: "build-host" } as ProfileRecord, connId });
    const meta = (label: string) => {
      const node = tree().find((n) => n.label === label)!;
      return node.meta ? render(<>{node.meta}</>).container.textContent : null;
    };
    expect(meta("Images")).toBeNull();
    dockerTool.sidebarData!.load({ profile: { id: "p" } as ProfileRecord, connId, client: fake.services.client as never });
    await waitFor(() => tree().find((n) => n.label === "Networks")!.meta !== undefined, "the counts");
    expect(meta("Images")).toBe(String(fake.server.dockerImages.length));
    expect(meta("Volumes")).toBe(String(fake.server.dockerVolumes.length));
    expect(meta("Networks")).toBe(String(fake.server.dockerNetworks.length));
    expect(calls(fake, "docker.host.counts")).toEqual([{ connId }]);
    fake.server.dockerVolumes = fake.server.dockerVolumes.slice(1);
    render(<VolumesTab {...props(fake, connId, { kind: "docker.volumes", params: {} })} />);
    await waitFor(() => meta("Volumes") === String(fake.server.dockerVolumes.length), "the Volumes tab's count");
  });
});
