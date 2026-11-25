// The Docker tool's UI, batch 1 (Mightyconsole spec §10.1, §10.2, §10.4; TSK-81): the profile's
// validation (an SSH host to name, TSK-144), trust on first use through the shell (the dialog
// shows the fingerprint, Trust stores it in the profile's SSH host and connects again; a changed key asks to replace it, Cancel leaves the profile alone), Test
// connection in the profile sheet, and the Host page. Axe on the dialog and the page.
import { afterEach, describe, expect, test } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { HostKeyDialog, hostKeyFile, keyTypeLabel } from "@/app/dialogs/HostKeyDialog";
import { StoreProvider, loadPersisted } from "@/app/store";
import type { ProfileRecord } from "@/profiles/record";
import { containerCounts, formatMemory, hostSubtitle } from "@/tools/docker/HostTab";
import { resetSshHosts } from "@/profiles/ssh-hosts";
import { profile, targetOf } from "@/tools/docker/profile";
import { FAKE_HOST_KEY, createFakeServices, fakeHostInfo } from "./support/fake-services";
import { act, axeViolations, byRole, byText, cleanup, click, dialogWith, key, render, settle, waitFor } from "./support/render";

afterEach(() => {
  cleanup();
  resetSshHosts();
});

type Fake = ReturnType<typeof createFakeServices>;

function record(patch: Partial<ProfileRecord> = {}, fields: Record<string, unknown> = {}): ProfileRecord {
  return {
    id: `01D${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    tool: "docker",
    version: 2,
    name: "build-host",
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: "2026-11-19T10:00:00.000Z",
    fields: { ...profile.defaults().fields, sshHostId: "H1", ...fields },
    secrets: {},
    extras: {},
    ...patch,
  };
}

const LOGIN = { host: "build-host.lan", port: 22, username: "deploy", auth: "privateKey" as const, keepaliveSec: null, hostKey: null };
const KEY = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n" };

describe("profile", () => {
  test("validation asks for the SSH host and an absolute socket; version 1 is the server's to migrate", () => {
    expect(profile.validate(record())).toEqual({});
    const errors = profile.validate(record({}, { sshHostId: "", socketPath: "docker.sock" }));
    expect(Object.keys(errors).sort()).toEqual(["socketPath", "sshHostId"]);
    expect(profile.version).toBe(2);
    expect(profile.serverMigratesFrom).toBe(1);
  });

  test("the target is the SSH host's address, IPv6 in brackets", () => {
    resetSshHosts([{ id: "H1", name: "lo", fields: { ...LOGIN, host: "::1", port: 2222 }, owner: { kind: "personal" }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 }]);
    expect(targetOf(record())).toBe("[::1]:2222");
    expect(targetOf(record({}, { sshHostId: "gone" }))).toBe("build-host");
    expect(keyTypeLabel("ecdsa-sha2-nistp256")).toBe("ECDSA-P256");
    expect(hostKeyFile("ssh-ed25519")).toBe("/etc/ssh/ssh_host_ed25519_key.pub");
  });
});

describe("host page helpers", () => {
  test("counts, memory and the subtitle read as the mockup's", () => {
    const host = fakeHostInfo({ name: "build-host", host: "build-host.lan", port: 22, username: "deploy", auth: "privateKey", hostKey: FAKE_HOST_KEY, socketPath: "/var/run/docker.sock" });
    expect(containerCounts(host)).toBe("11 · 7 running · 4 stopped");
    expect(formatMemory(33_600_000_000)).toBe("31.3 GiB");
    expect(hostSubtitle(host)).toBe("deploy@build-host.lan:22 · private key · ED25519 host key trusted · socket /var/run/docker.sock · ping 3 ms");
  });
});

describe("host key dialog", () => {
  test("first use shows the fingerprint; a changed key both keys and a danger button; no axe violations", async () => {
    let trusted: unknown = null;
    const view = render(<HostKeyDialog open name="build-host" target="build-host.lan:22" details={{ state: "unknown", ...FAKE_HOST_KEY }} onCancel={() => undefined} onTrust={(k) => (trusted = k)} />);
    await settle();
    expect(byText("Trust build-host?")).not.toBeNull();
    expect(byText(FAKE_HOST_KEY.fingerprintSha256)).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
    await click(byRole("button", /Trust and connect/));
    expect(trusted).toEqual(FAKE_HOST_KEY);
    view.unmount();

    const expected = { algorithm: "ssh-ed25519", fingerprintSha256: "SHA256:8vKd2Lq" };
    render(<HostKeyDialog open name="build-host" target="build-host.lan:22" details={{ state: "changed", ...FAKE_HOST_KEY, expected }} onCancel={() => undefined} onTrust={() => undefined} />, { theme: "dark" });
    await settle();
    expect(byText(/The identity of build-host changed/)).not.toBeNull();
    expect(byText(/SHA256:8vKd2Lq/)).not.toBeNull();
    expect(byRole("button", "Replace the trusted key")).not.toBeNull();
    expect(byRole("button", /connect once/i)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});

async function mount(fake: Fake) {
  const persisted = await loadPersisted(fake.storage, ["docker"]);
  render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App />
      </StoreProvider>
    </ServicesContext.Provider>,
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "the events subscription");
}

const treeItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]")).find((el) => el.textContent?.includes(label)) ?? null;
const connects = (fake: Fake) => fake.server.calls.filter((c) => c.procedure === "docker.connect").map((c) => (c.input as { profile: Record<string, unknown> }).profile);

async function openDocker() {
  const nav = Array.from(document.querySelectorAll<HTMLElement>("button, a, [role=tab], [role=treeitem]")).find((el) => el.textContent?.trim() === "Docker" || el.getAttribute("aria-label")?.startsWith("Docker"));
  await click(nav ?? null);
  await waitFor(() => treeItem("build-host") !== null, "the Docker profiles");
}

async function connectFromTree() {
  const item = treeItem("build-host")!;
  await click(item);
  await act(async () => {
    item.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}

describe("trust on first use in the shell", () => {
  test("an unknown key asks first; Trust stores it and connects; the Host page shows the host", async () => {
    const fake = createFakeServices();
    const hostId = fake.storeSshHost("build-host", LOGIN, KEY);
    const p = record({}, { sshHostId: hostId });
    await fake.storage.putProfile(p);
    await mount(fake);
    await openDocker();
    await connectFromTree();
    await waitFor(() => dialogWith("Trust build-host?") !== null, "the trust dialog");
    expect(connects(fake)).toHaveLength(1);
    expect(connects(fake)[0]!["hostKey"]).toBeNull();
    expect(byText(/first connection to build-host.lan:22/)).not.toBeNull();
    await click(byRole("button", /Trust and connect/));
    await waitFor(() => connects(fake).length === 2, "the second connect");
    expect(connects(fake)[1]!["hostKey"]).toEqual(FAKE_HOST_KEY);
    // The key is the SSH host's: every Docker host that uses it is trusted at once.
    expect(fake.server.sshHosts.get(hostId)?.view.fields.hostKey).toEqual(FAKE_HOST_KEY);
    expect((await fake.storage.getProfile(p.id))?.fields["hostKey"]).toBeUndefined();

    await waitFor(() => treeItem("Host") !== null, "the resource tree");
    await connectHostTab();
    await waitFor(() => byText("build-host") !== null && byText(/Debian GNU\/Linux 12/) !== null, "the Host page");
    expect(byText("11 · 7 running · 4 stopped")).not.toBeNull();
    expect(byText(/overlay2 on extfs/)).not.toBeNull();
  });

  test("a changed key asks to replace it; Cancel leaves the profile and the connection failed", async () => {
    const fake = createFakeServices();
    const old = { algorithm: "ssh-ed25519", fingerprintSha256: "SHA256:old" };
    const hostId = fake.storeSshHost("build-host", { ...LOGIN, hostKey: old }, KEY);
    const p = record({}, { sshHostId: hostId });
    await fake.storage.putProfile(p);
    await mount(fake);
    await openDocker();
    await connectFromTree();
    await waitFor(() => dialogWith("The identity of build-host changed") !== null, "the changed-key dialog");
    await click(byRole("button", "Cancel"));
    await settle(2);
    expect(connects(fake)).toHaveLength(1);
    expect(fake.server.sshHosts.get(hostId)?.view.fields.hostKey).toEqual(old);
    await waitFor(() => treeItem("build-host")?.querySelector("[data-status=failed]") != null, "the failed state");
  });
});

async function connectHostTab() {
  const host = treeItem("Host")!;
  await click(host);
  await act(async () => {
    host.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}

describe("Settings → SSH hosts (TSK-144)", () => {
  test("lists the hosts with who uses them; a host in use is not deleted and says by whom; no axe violations", async () => {
    const fake = createFakeServices();
    const used = fake.storeSshHost("build-host", { ...LOGIN, hostKey: FAKE_HOST_KEY }, KEY);
    fake.storeSshHost("spare", { ...LOGIN, host: "spare.lan", auth: "agent" });
    await fake.storage.putProfile(record({}, { sshHostId: used }));
    await mount(fake);
    await key(",", { ctrlKey: true });
    await waitFor(() => dialogWith("Changes apply at once") !== null, "Settings");
    await click(byRole("tab", "SSH hosts"));
    await waitFor(() => byText("spare.lan:22") !== null, "the hosts table");
    const table = document.querySelector<HTMLElement>("[aria-label='SSH hosts'] table, table[aria-label='SSH hosts']") ?? byRole("table", "SSH hosts");
    expect(table?.textContent).toContain("build-host.lan:22");
    expect(table?.textContent).toContain("Docker build-host");
    expect(table?.textContent).toContain("ssh-agent");
    expect(await axeViolations(dialogWith("Changes apply at once")!)).toEqual([]);

    await click(byRole("button", "Delete build-host"));
    await waitFor(() => dialogWith("build-host is in use") !== null, "the in-use dialog");
    expect(fake.server.calls.some((c) => c.procedure === "sshHosts.delete")).toBe(false);
    await click(byRole("button", "Close"));
    await waitFor(() => dialogWith("build-host is in use") === null, "the dialog to close");
  });
});
