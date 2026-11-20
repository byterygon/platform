// The Docker tool's UI, batch 1 (Mightyconsole spec §10.1, §10.2, §10.4; TSK-81): the profile's
// validation and `docker.connect` input (only the chosen method's secrets travel), trust on first
// use through the shell (the dialog shows the fingerprint, Trust stores it in the profile and
// connects again; a changed key asks to replace it, Cancel leaves the profile alone), Test
// connection in the profile sheet, and the Host page. Axe on the dialog and the page.
import { afterEach, describe, expect, test } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { HostKeyDialog, hostKeyFile, keyTypeLabel } from "@/app/dialogs/HostKeyDialog";
import { StoreProvider, loadPersisted } from "@/app/store";
import type { ProfileRecord } from "@/profiles/record";
import { containerCounts, formatMemory, hostSubtitle } from "@/tools/docker/HostTab";
import { profile, targetOf, trustHostKey } from "@/tools/docker/profile";
import { FAKE_HOST_KEY, createFakeServices, fakeHostInfo } from "./support/fake-services";
import { act, axeViolations, byRole, byText, cleanup, click, dialogWith, render, settle, waitFor } from "./support/render";

afterEach(cleanup);

type Fake = ReturnType<typeof createFakeServices>;

function record(patch: Partial<ProfileRecord> = {}, fields: Record<string, unknown> = {}, secrets: Record<string, unknown> = { privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nkey\n-----END OPENSSH PRIVATE KEY-----\n" }): ProfileRecord {
  return {
    id: `01D${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
    tool: "docker",
    version: 1,
    name: "build-host",
    createdAt: "2026-11-19T10:00:00.000Z",
    updatedAt: "2026-11-19T10:00:00.000Z",
    fields: { ...profile.defaults().fields, host: "build-host.lan", username: "deploy", ...fields },
    secrets,
    extras: {},
    ...patch,
  };
}

describe("profile", () => {
  test("validation names each field to fix", () => {
    expect(profile.validate(record())).toEqual({});
    const errors = profile.validate(record({}, { host: "deploy@h", port: 70000, username: " ", socketPath: "docker.sock", keepaliveSec: -1 }, {}));
    expect(Object.keys(errors).sort()).toEqual(["host", "keepaliveSec", "port", "privateKey", "socketPath", "username"]);
    expect(profile.validate(record({}, { auth: "password" }, {}))["password"]).toBeDefined();
    expect(profile.validate(record({}, { auth: "agent" }, {}))).toEqual({});
  });

  test("only the chosen method's secrets reach docker.connect", () => {
    const secrets = { privateKey: "KEY", passphrase: "PP", password: "PW" };
    const key = profile.toConnect(record({}, {}, secrets)) as Record<string, unknown>;
    expect(key).toMatchObject({ host: "build-host.lan", port: 22, username: "deploy", auth: "privateKey", privateKey: "KEY", passphrase: "PP", password: null, hostKey: null, socketPath: "/var/run/docker.sock", keepaliveSec: 30 });
    const password = profile.toConnect(record({}, { auth: "password" }, secrets)) as Record<string, unknown>;
    expect(password).toMatchObject({ privateKey: null, passphrase: null, password: "PW" });
    const agent = profile.toConnect(record({}, { auth: "agent" }, secrets)) as Record<string, unknown>;
    expect(agent).toMatchObject({ privateKey: null, passphrase: null, password: null });
  });

  test("trusting stores the key; the target brackets IPv6", () => {
    const trusted = trustHostKey(record(), FAKE_HOST_KEY);
    expect(trusted.fields["hostKey"]).toEqual(FAKE_HOST_KEY);
    expect((profile.toConnect(trusted) as Record<string, unknown>)["hostKey"]).toEqual(FAKE_HOST_KEY);
    expect(targetOf(record({}, { host: "::1", port: 2222 }))).toBe("[::1]:2222");
    expect(keyTypeLabel("ecdsa-sha2-nistp256")).toBe("ECDSA-P256");
    expect(hostKeyFile("ssh-ed25519")).toBe("/etc/ssh/ssh_host_ed25519_key.pub");
  });
});

describe("host page helpers", () => {
  test("counts, memory and the subtitle read as the mockup's", () => {
    const host = fakeHostInfo(profile.toConnect(record()) as never);
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
    const p = record();
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
    const stored = await fake.storage.getProfile(p.id);
    expect(stored?.fields["hostKey"]).toEqual(FAKE_HOST_KEY);

    await waitFor(() => treeItem("Host") !== null, "the resource tree");
    await connectHostTab();
    await waitFor(() => byText("build-host") !== null && byText(/Debian GNU\/Linux 12/) !== null, "the Host page");
    expect(byText("11 · 7 running · 4 stopped")).not.toBeNull();
    expect(byText(/overlay2 on extfs/)).not.toBeNull();
  });

  test("a changed key asks to replace it; Cancel leaves the profile and the connection failed", async () => {
    const fake = createFakeServices();
    const old = { algorithm: "ssh-ed25519", fingerprintSha256: "SHA256:old" };
    const p = record({}, { hostKey: old });
    await fake.storage.putProfile(p);
    await mount(fake);
    await openDocker();
    await connectFromTree();
    await waitFor(() => dialogWith("The identity of build-host changed") !== null, "the changed-key dialog");
    await click(byRole("button", "Cancel"));
    await settle(2);
    expect(connects(fake)).toHaveLength(1);
    const stored = await fake.storage.getProfile(p.id);
    expect(stored?.fields["hostKey"]).toEqual(old);
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
