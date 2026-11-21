// A container's Files, read only, TSK-81 batch 4c (DOC-21 Open question 45 q, mockup frame
// docker-files): the path helpers (join, `..`, a symlink's target, the path bar's steps, the mode
// as `ls` shows it, the preview's language), and the view against the fake host: folders opened
// and gone back up, a symlink followed, a text file previewed read only, a binary and a large one
// explained, a folder downloaded, a listing that stopped early said, a missing folder's error.
// Axe on the view with a preview.
import { afterEach, describe, expect, test, vi } from "vitest";
import { describeError } from "@/app/messages";
import type { MightyClient } from "@/app/client";
import type { ProfileRecord } from "@/profiles/record";
import { dockerTool } from "@/tools/docker";
import { ContainerTab } from "@/tools/docker/ContainerTab";
import { joinPath, modeText, normalPath, pathSteps, previewLanguage, resolveLink } from "@/tools/docker/FilesPanel";
import { profile as schema } from "@/tools/docker/profile";
import type { TabProps, TabView } from "@/tools/types";
import { createFakeServices } from "./support/fake-services";
import { axeViolations, byText, cleanup, click, editorArea, render, waitFor } from "./support/render";

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

type Fake = ReturnType<typeof createFakeServices>;

async function connected(): Promise<{ fake: Fake; connId: string }> {
  const fake = createFakeServices();
  const out = await fake.services.client.docker.connect({ profile: { name: "build-host", host: "h", username: "u", hostKey: { algorithm: "ssh-ed25519", fingerprintSha256: "SHA256:q7Lw3Gm0bX9yT2vR8cKpN5sUe1JhAa4FzQ6dWiYoV0E" } } });
  return { fake, connId: out.connId };
}

function props(fake: Fake, connId: string, tab: Partial<TabView> & { kind: string; params: Record<string, unknown> }): TabProps {
  const profile: ProfileRecord = { id: "01D", tool: "docker", version: 1, name: "build-host", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  return { tab: { id: "t", tool: "docker", profileId: "01D", title: "t", pinned: false, ...tab }, profile, connId, client: fake.services.client as MightyClient, active: true, useTabActions: () => {}, onLive: () => {}, note: describeError, openTab: vi.fn(), go: vi.fn(), navigate: vi.fn() };
}

const calls = (fake: Fake, procedure: string) => fake.server.calls.filter((c) => c.procedure === procedure).map((c) => c.input as Record<string, unknown>);
const names = () => Array.from(document.querySelectorAll("table[aria-label='Files'] tbody tr")).map((r) => r.querySelector("td button")?.textContent ?? "");
const entry = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("table[aria-label='Files'] tbody td button")).find((b) => b.textContent?.startsWith(name)) ?? null;
const step = (label: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("nav[aria-label='Folder'] button")).find((b) => b.textContent === label) ?? null;
const here = () => document.querySelector("nav[aria-label='Folder'] [aria-current='location']")?.textContent;

describe("paths", () => {
  test("join, normalise, a symlink's target, the path bar's steps", () => {
    expect(joinPath("/", "app")).toBe("/app");
    expect(joinPath("/app", "media")).toBe("/app/media");
    expect(normalPath("/app/media/../x/./y/")).toBe("/app/x/y");
    expect(normalPath("/../..")).toBe("/");
    expect(resolveLink("/app/media", "../exports")).toBe("/app/exports");
    expect(resolveLink("/app/media", "/data/exports")).toBe("/data/exports");
    expect(pathSteps("/app/media")).toEqual([
      { label: "/", path: "/" },
      { label: "app", path: "/app" },
      { label: "media", path: "/app/media" },
    ]);
  });

  test("the mode as ls shows it; the preview's language", () => {
    expect(modeText("dir", 0o755)).toBe("drwxr-xr-x");
    expect(modeText("file", 0o644)).toBe("-rw-r--r--");
    expect(modeText("symlink", 0o777)).toBe("lrwxrwxrwx");
    expect(modeText("file", 0o4755)).toBe("-rwsr-xr-x");
    expect(modeText("dir", 0o1777)).toBe("drwxrwxrwt");
    expect(modeText("file", 0o2644)).toBe("-rw-r-Sr--");
    expect(previewLanguage("config.JSON")).toBe("json");
    expect(previewLanguage("compose.yml")).toBe("yaml");
    expect(previewLanguage("robots.txt")).toBe("plaintext");
  });
});

describe("the Files view", () => {
  test("folders, a symlink followed, a text preview, binary and large files, a download, back up; no axe violations", async () => {
    const { fake, connId } = await connected();
    const created: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      created.push(b);
      return "blob:files";
    });
    URL.revokeObjectURL = vi.fn();
    const clicked = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { container } = render(<ContainerTab {...props(fake, connId, { kind: "docker.container", params: { id: "shop-web-1", view: "files" }, title: "shop-web-1" })} />);
    await waitFor(() => names().length === 3, "the root");
    expect(names()).toEqual(["app", "etc", "big"]);
    expect(calls(fake, "docker.containers.files.list")[0]).toEqual({ connId, id: "shop-web-1", path: "/" });

    await click(entry("app")!);
    await waitFor(() => here() === "app", "/app");
    await click(entry("media")!);
    await waitFor(() => here() === "media", "/app/media");
    expect(names()).toEqual(["invoices", "logo.png", "robots.txt", "exports→ ../exports", "huge.log"]);
    const row = Array.from(document.querySelectorAll("table[aria-label='Files'] tbody tr")).find((r) => r.textContent?.includes("robots.txt"))!;
    expect(Array.from(row.querySelectorAll("td")).map((c) => c.textContent).slice(1, 3)).toEqual(["68 B", "-rw-r--r--"]);

    // A text file opens beside, read only.
    await click(entry("robots.txt")!);
    await waitFor(() => document.querySelector("aside[aria-label='Preview of robots.txt']") !== null && byText("68 B · text") !== null, "the preview");
    await waitFor(() => (editorArea("robots.txt, read only")?.value ?? "").includes("Disallow: /api/"), "the text in the editor");
    expect(await axeViolations(container)).toEqual([]);

    // A binary file and a large one say why there is no text.
    await click(entry("logo.png")!);
    await waitFor(() => byText("Not text: download it to open it.") !== null, "binary");
    await click(entry("huge.log")!);
    await waitFor(() => byText("Larger than 1 MiB: download it to read it.") !== null, "too large");

    // The folder as .tar.
    await click(Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((b) => b.textContent?.includes("Download folder (.tar)"))!);
    await waitFor(() => clicked.mock.calls.length === 1, "the download");
    expect(calls(fake, "docker.containers.files.download")[0]).toMatchObject({ connId, id: "shop-web-1", path: "/app/media" });
    expect(await created[0]!.text()).toBe("tar of /app/media");

    // A symlink goes to its target; the path bar goes back up.
    await click(entry("exports")!);
    await waitFor(() => here() === "exports" && names().includes("orders.csv"), "/app/exports");
    await click(step("/")!);
    await waitFor(() => here() === "/" && names().length === 3, "back at the root");
  });

  test("a listing that stopped early says so; a missing folder's error; the files route", async () => {
    const { fake, connId } = await connected();
    render(<ContainerTab {...props(fake, connId, { kind: "docker.container", params: { id: "stopped", view: "files" }, title: "stopped" })} />);
    await waitFor(() => names().length === 3, "the root");
    await click(entry("big")!);
    await waitFor(() => document.body.textContent?.includes("stopped at 2,000 entries") === true, "the truncation");
    expect(await fake.services.client.docker.containers.files.list({ connId, id: "stopped", path: "/gone" }).catch((e) => describeError(e).code)).toBe("NotFound");
    expect(dockerTool.tabKinds["docker.container"]!.href!({ id: "shop-web-1", view: "files" })).toEqual({ path: "containers/shop-web-1/files" });
  });
});
