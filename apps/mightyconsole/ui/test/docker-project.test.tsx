// A Compose project's tab, TSK-81 batch 4b (DOC-21 Open question 45 q, mockup frame
// docker-project-logs): the merge helpers (Docker's timestamps without trailing zeros put in time
// order, a cut piece kept with its line, a resumed stream's repeats dropped, a label per service
// or per replica, a colour per label), and the tab against the fake host: one stream per container
// merged by time with the service column, a service hidden and shown, a stop leaving a line, a
// container that starts later joining, the Containers view kept to the project, the tree's link
// and the route. Axe on both views.
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { ProfileRecord } from "@/profiles/record";
import { dockerTool } from "@/tools/docker";
import { containersTree } from "@/tools/docker";
import { profile as schema } from "@/tools/docker/profile";
import { LogMerger, labelColors, serviceLabels, timeKey } from "@/tools/docker/project-logs";
import { ProjectTab } from "@/tools/docker/ProjectTab";
import type { TabProps, TabView } from "@/tools/types";
import { createFakeServices, fakeContainers } from "./support/fake-services";
import { act, axeViolations, byText, cleanup, click, render, waitFor } from "./support/render";

afterEach(cleanup);

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
const line = (ts: string, text: string) => ({ ts, stream: "stdout" as const, text });
/** The log's texts in the order they show. */
const shown = (...texts: string[]) => {
  const leaves = Array.from(document.querySelectorAll<HTMLElement>("[role=log] *")).filter((el) => el.childElementCount === 0);
  return texts.map((t) => leaves.findIndex((el) => el.textContent === t));
};
const pushEvent = (fake: Fake, event: Record<string, unknown>) => {
  for (const send of fake.server.dockerPush.events) send([{ kind: "container", attributes: {}, timeMs: Date.parse("2026-11-20T08:00:05Z"), ...event }]);
};

describe("merging", () => {
  test("Docker's times without trailing zeros sort in time order", () => {
    const ts = ["2026-11-20T08:00:01.123Z", "2026-11-20T08:00:01Z", "2026-11-20T08:00:01.1Z", "2026-11-20T08:00:00.999999999Z"];
    expect([...ts].sort((a, b) => (timeKey(a) < timeKey(b) ? -1 : 1))).toEqual(["2026-11-20T08:00:00.999999999Z", "2026-11-20T08:00:01Z", "2026-11-20T08:00:01.1Z", "2026-11-20T08:00:01.123Z"]);
    expect(timeKey("")).toBe("");
  });

  test("a merger hands lines over in time order, keeps a cut piece with its line, drops a resumed stream's repeats", () => {
    const m = new LogMerger();
    m.push("web-1", "web", [line("2026-11-20T08:00:02Z", "web two"), line("", "…its cut piece")]);
    m.push("db-1", "db", [line("2026-11-20T08:00:01.5Z", "db one"), line("2026-11-20T08:00:03Z", "db three")]);
    expect(m.take().map((l) => `${l.label}: ${l.text}`)).toEqual(["db: db one", "web: web two", "web: …its cut piece", "db: db three"]);
    expect(m.size).toBe(0);
    const after = m.lastKey("web-1");
    m.push("web-1", "web", [line("2026-11-20T08:00:02Z", "web two"), line("2026-11-20T08:00:04Z", "web four")], after);
    expect(m.take().map((l) => l.text)).toEqual(["web four"]);
  });

  test("a label per service, the container's name for replicas; a colour per label", () => {
    const labels = serviceLabels([
      { name: "shop-web-1", service: "web" },
      { name: "shop-worker-1", service: "worker" },
      { name: "shop-worker-2", service: "worker" },
      { name: "loose" },
    ]);
    expect([...labels.values()]).toEqual(["web", "shop-worker-1", "shop-worker-2", "loose"]);
    const colors = labelColors(Array.from({ length: 9 }, (_, i) => `s${i}`));
    expect(colors["s0"]).toBe("cat-1");
    expect(colors["s8"]).toBe("cat-1");
    expect(colors["s7"]).toBe("cat-8");
  });
});

describe("the project tab", () => {
  test("logs merged by time with the service column, a service hidden, a stop leaves a line, a new container joins; no axe violations", async () => {
    const { fake, connId } = await connected();
    fake.server.dockerLogs.set("shop-web-1", [line("2026-11-20T08:00:01.5Z", "web a"), line("2026-11-20T08:00:03Z", "web b")]);
    fake.server.dockerLogs.set("shop-worker-1", [line("2026-11-20T08:00:01Z", "worker a"), line("2026-11-20T08:00:02.25Z", "worker b")]);
    fake.server.dockerFollow.add("shop-web-1");
    fake.server.dockerFollow.add("shop-worker-1");
    const { container } = render(<ProjectTab {...props(fake, connId, { kind: "docker.project", params: { project: "shop", view: "logs" }, title: "shop" })} />);
    await waitFor(() => byText("web b") !== null, "the merged log");
    expect(shown("worker a", "web a", "worker b", "web b")).toEqual([...shown("worker a", "web a", "worker b", "web b")].sort((a, b) => a - b));
    expect(calls(fake, "docker.containers.logs").map((c) => [c["id"], c["follow"], c["tail"]])).toEqual([
      ["shop-web-1", true, 1000],
      ["shop-worker-1", true, 1000],
    ]);
    // The service column names each line's service.
    expect(byText("worker")).not.toBeNull();
    expect(byText("Following 2 of 2 containers · ordered by Docker's timestamps")).not.toBeNull();
    expect(byText("build-host · 2 containers · 1 running · 1 restarting · /srv/shop")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    await click(document.querySelector<HTMLElement>("[role=group][aria-label='Services'] button[aria-pressed='true']:last-child")!);
    await waitFor(() => byText("worker a") === null, "the worker hidden");
    expect(byText("web a")).not.toBeNull();
    await click(document.querySelector<HTMLElement>("[role=group][aria-label='Services'] button[aria-pressed='false']")!);
    await waitFor(() => byText("worker a") !== null, "the worker shown again");

    await waitFor(() => fake.server.dockerPush.events.length > 0, "the events stream");
    await act(async () => {
      pushEvent(fake, { action: "die", id: "w1", name: "shop-worker-1", attributes: { "com.docker.compose.project": "shop", exitCode: "1" } });
      pushEvent(fake, { action: "start", id: "w2", name: "shop-web-2", attributes: { "com.docker.compose.project": "shop", "com.docker.compose.service": "web" } });
      pushEvent(fake, { action: "start", id: "x", name: "elsewhere", attributes: { "com.docker.compose.project": "other" } });
    });
    await waitFor(() => byText("[shop-worker-1 stopped, exit code 1]") !== null, "the stop's line");
    await waitFor(() => calls(fake, "docker.containers.logs").length === 3, "the new container's stream");
    expect(calls(fake, "docker.containers.logs")[2]).toMatchObject({ id: "shop-web-2", follow: true, tail: null, since: String(Date.parse("2026-11-20T08:00:05Z") / 1000) });
  });

  test("Containers keeps to the project; the tree's project opens its logs; the route; no axe violations", async () => {
    const { fake, connId } = await connected();
    const { container } = render(<ProjectTab {...props(fake, connId, { kind: "docker.project", params: { project: "shop", view: "containers" }, title: "shop" })} />);
    await waitFor(() => document.querySelector("table[aria-label='Containers'] tbody") !== null, "the project's containers");
    const text = document.querySelector("table[aria-label='Containers']")!.textContent!;
    expect(text).toContain("shop-web-1");
    expect(text).toContain("shop-worker-1");
    expect(text).not.toContain("tty");
    expect(document.querySelector("button[aria-label='Actions for project shop']")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);

    const node = containersTree("p", fakeContainers()).find((n) => n.label === "shop")!;
    expect(node.open).toEqual({ kind: "docker.project", params: { project: "shop", view: "logs" }, title: "shop" });
    expect(dockerTool.tabKinds["docker.project"]!.href!({ project: "shop", view: "containers" })).toEqual({ path: "projects/shop/containers" });
    expect(dockerTool.tabKinds["docker.project"]!.href!({ project: "shop" })).toEqual({ path: "projects/shop/logs" });
  });
});
