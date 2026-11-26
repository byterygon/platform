// Docker's transports in the UI (DOC-23 §6, TSK-116 batch 2; mockup frames routes-docker-ssh,
// routes-docker-socket, routes-docker-tcp-tls, routes-docker-tcp-plain, routes-docker-host-plain):
// the profile's validation per transport, the Transport control (each transport keeps its own
// fields, a TCP profile never carries an SSH host), the local socket's usual places and warning,
// TCP with TLS (the CA, client certificate and key required) or without (the danger alert and the
// tick that accepts it, asked again for another host), the Unencrypted badge and the Host page's
// banner that cannot be dismissed. Axe on the form and the banner.
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { serverSecrets } from "@/profiles/server";
import type { ProfileRecord } from "@/profiles/record";
import { resetSshHosts } from "@/profiles/ssh-hosts";
import { ConnectionForm } from "@/tools/docker/ConnectionForm";
import { UnencryptedBanner, hostSubtitle } from "@/tools/docker/HostTab";
import { dockerTool } from "@/tools/docker";
import { profile, targetOf, transportOf, withTransport } from "@/tools/docker/profile";
import { fakeHostInfo } from "./support/fake-services";
import { axeViolations, byRole, byText, cleanup, click, render, settle, type } from "./support/render";

afterEach(() => {
  cleanup();
  resetSshHosts();
});

function record(fields: Record<string, unknown>, patch: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    id: "01DOCKER",
    tool: "docker",
    version: 2,
    name: "edge-02",
    createdAt: "2026-11-26T10:00:00.000Z",
    updatedAt: "2026-11-26T10:00:00.000Z",
    fields,
    secrets: {},
    extras: {},
    ...patch,
  };
}

const PEM = "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n";
const STAMP = { acceptedBy: "human:account:ada", acceptedAt: "2026-11-24T09:00:00Z" };

describe("profile", () => {
  test("a profile saved before transports is SSH, and validates as it did", () => {
    expect(transportOf({ sshHostId: "H1" })).toBe("ssh");
    expect(profile.validate(record({ sshHostId: "H1", socketPath: "/var/run/docker.sock" }))).toEqual({});
    expect(Object.keys(profile.validate(record({ sshHostId: "" })))).toEqual(["sshHostId"]);
  });

  test("a local socket needs a path the server can open", () => {
    expect(profile.validate(record({ transport: "socket", socketPath: "~/.colima/default/docker.sock" }))).toEqual({});
    expect(profile.validate(record({ transport: "socket", socketPath: "//./pipe/docker_engine" }))).toEqual({});
    expect(Object.keys(profile.validate(record({ transport: "socket", socketPath: "" })))).toEqual(["socketPath"]);
    expect(Object.keys(profile.validate(record({ transport: "socket", socketPath: "docker.sock" })))).toEqual(["socketPath"]);
  });

  test("TCP with TLS needs the pinned CA, the client certificate and its key", () => {
    const tls = { transport: "tcp", host: "docker2.prod.internal", tls: { enabled: true, caPem: PEM, clientCertPem: PEM } };
    expect(Object.keys(profile.validate(record(tls)))).toEqual(["tls.clientKeyPem"]);
    expect(profile.validate(record(tls, { secrets: { clientKeyPem: "key" } }))).toEqual({});
    expect(profile.validate(record(tls, { storedSecrets: ["clientKeyPem"] }))).toEqual({});
    const bare = profile.validate(record({ transport: "tcp", host: "tcp://h:2376", tls: { enabled: true } }));
    expect(Object.keys(bare).sort()).toEqual(["host", "tls.caPem", "tls.clientCertPem", "tls.clientKeyPem"]);
  });

  test("plain TCP needs the tick, or the server's record of it", () => {
    const plain = { transport: "tcp", host: "10.40.3.8", port: 2375, tls: { enabled: false } };
    expect(Object.keys(profile.validate(record(plain)))).toEqual(["unencrypted"]);
    expect(profile.validate(record({ ...plain, unencrypted: { accepted: true } }))).toEqual({});
    expect(profile.validate(record({ ...plain, unencrypted: STAMP }))).toEqual({});
    expect(targetOf(record(plain))).toBe("10.40.3.8:2375");
    expect(targetOf(record({ transport: "tcp", host: "::1", tls: { enabled: true } }))).toBe("[::1]:2376");
  });

  test("changing the transport keeps only the new one's fields, and gives back what was left", () => {
    const ssh = { sshHostId: "H1", socketPath: "/run/user/1000/docker.sock" };
    const tcp = withTransport(ssh, "tcp", undefined);
    expect(tcp).toEqual({ transport: "tcp", host: "", tls: { enabled: true } });
    const back = withTransport(tcp, "ssh", ssh);
    expect(back).toEqual(ssh);
  });

  test("the client key goes up as the server's tls.clientKeyPem", () => {
    expect(serverSecrets("docker", { clientKeyPem: "key" })).toEqual({ "tls.clientKeyPem": "key" });
  });

  test("only a plain TCP profile carries the Unencrypted badge", () => {
    expect(dockerTool.profileBadges?.(record({ transport: "tcp", host: "h", tls: { enabled: false }, unencrypted: STAMP }))).toEqual([expect.objectContaining({ label: "Unencrypted", tone: "warning" })]);
    expect(dockerTool.profileBadges?.(record({ transport: "tcp", host: "h", tls: { enabled: true } }))).toEqual([]);
    expect(dockerTool.profileBadges?.(record({ sshHostId: "H1" }))).toEqual([]);
  });
});

/** The form in a sheet's place: the fields and secrets it changes, as the sheet keeps them. */
function Harness({ initial, onChange }: { initial: Record<string, unknown>; onChange(fields: Record<string, unknown>): void }) {
  const [fields, setFields] = useState(initial);
  const [secrets, setSecrets] = useState<Record<string, unknown>>({});
  return (
    <form aria-label="Docker profile">
      <ConnectionForm
        fields={fields}
        secrets={secrets}
        storedSecrets={new Set()}
        errors={profile.validate(record(fields, { secrets }))}
        onFields={(patch) =>
          setFields((f) => {
            const next = { ...f, ...patch };
            onChange(next);
            return next;
          })
        }
        onSecrets={(patch) => setSecrets((s) => ({ ...s, ...patch }))}
      />
    </form>
  );
}

const defined = (fields: Record<string, unknown>) => Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

describe("the form", () => {
  test("TCP without TLS shows the danger alert, and the tick accepts it; another host asks again", async () => {
    let fields: Record<string, unknown> = {};
    render(<Harness initial={{ transport: "tcp", host: "10.40.3.8", port: 2375, tls: { enabled: false }, unencrypted: STAMP }} onChange={(f) => (fields = f)} />);
    await settle();
    expect(byText(/anyone on the network who reaches this port is root on that host/)).not.toBeNull();
    const tick = byRole("checkbox", /I understand, and I accept this for 10\.40\.3\.8/);
    expect(tick?.getAttribute("aria-checked")).toBe("true");
    expect(byText(/Accepted on 2026-11-24/)).not.toBeNull();
    expect(await axeViolations()).toEqual([]);
    // Another host: the recorded acceptance is for the old one.
    await type(byRole("textbox", "Host") as HTMLInputElement, "10.40.3.9");
    expect(defined(fields)["unencrypted"]).toBeUndefined();
    expect(byRole("checkbox", /I accept this for 10\.40\.3\.9/)?.getAttribute("aria-checked")).toBe("false");
    await click(byRole("checkbox", /I accept this for 10\.40\.3\.9/));
    expect(fields["unencrypted"]).toEqual({ accepted: true });
  });

  test("TCP with TLS has the CA, the client certificate, the key and the server name, and no way to skip", async () => {
    render(<Harness initial={{ transport: "tcp", host: "docker2.prod.internal", tls: { enabled: true } }} onChange={() => undefined} />);
    await settle();
    for (const label of ["CA certificate (PEM)", "Client certificate (PEM)", "Client key (PEM)", "Server name"]) expect(byRole("textbox", label), label).not.toBeNull();
    expect(byText(/skip verification/i)?.textContent).toMatch(/no option to skip verification/);
    expect(byText(/root on that host/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });

  test("the Transport control switches the fields; a TCP profile never keeps the SSH host", async () => {
    let fields: Record<string, unknown> = { sshHostId: "H1", socketPath: "/var/run/docker.sock" };
    render(<Harness initial={fields} onChange={(f) => (fields = f)} />);
    await settle();
    expect(byRole("group", "Transport")).not.toBeNull();
    await click(byRole("button", /TCP/));
    expect(defined(fields)).toEqual({ transport: "tcp", host: "", tls: { enabled: true } });
    await click(byRole("button", /Local socket/));
    expect(defined(fields)).toEqual({ transport: "socket", socketPath: "" });
    expect(byText(/Whoever can open this page is root on the server's machine/)).not.toBeNull();
    await click(byRole("button", /Usual places/));
    await settle();
    await click(byText("~/.colima/default/docker.sock"));
    expect(fields["socketPath"]).toBe("~/.colima/default/docker.sock");
    await click(byRole("button", /SSH/));
    expect(defined(fields)).toEqual({ sshHostId: "H1", socketPath: "/var/run/docker.sock" });
  });
});

describe("the Host page", () => {
  test("the subtitle says the transport; the banner of an unencrypted profile has no Dismiss", async () => {
    const ssh = fakeHostInfo({ name: "lab", host: "build-host.lan", username: "deploy" } as never);
    expect(hostSubtitle({ ...ssh, transport: "tcp", endpoint: "10.40.3.8:2375", tls: false, unencrypted: true, ssh: undefined } as never)).toBe(`tcp://10.40.3.8:2375 · no TLS · ping ${ssh.pingMs} ms`);
    expect(hostSubtitle({ ...ssh, transport: "socket", endpoint: "/var/run/docker.sock", ssh: undefined } as never)).toBe(`local socket /var/run/docker.sock · ping ${ssh.pingMs} ms`);
    render(<UnencryptedBanner endpoint="10.40.3.8:2375" acceptedAt="2026-11-24T09:00:00Z" />);
    await settle();
    expect(byText(/This connection is not encrypted/)).not.toBeNull();
    expect(byText(/You accepted this on 2026-11-24/)).not.toBeNull();
    expect(byRole("button", /Dismiss/)).toBeNull();
    expect(await axeViolations()).toEqual([]);
  });
});
