// "Move my profiles to the server" (DOC-25 §3.4.9, TSK-139) from a seeded IndexedDB (on
// fake-indexeddb): each record is imported, checked, and only then loses its secrets in the
// browser; a failure half way leaves the rest untouched and running the step again resumes
// without importing anything twice; once all have moved the browser's profile stores are empty.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, test } from "vitest";
import { moveToServer, toMove } from "@/profiles/move";
import type { ProfileRecord } from "@/profiles/record";
import { MemoryStorage, openStorage } from "@/profiles/storage";
import { createFakeServices } from "./support/fake-services";

const now = "2026-11-25T10:00:00.000Z";

function rec(id: string, tool: string, name: string, fields: Record<string, unknown>, secrets: Record<string, string>): ProfileRecord {
  return { id, tool, version: 1, name, createdAt: now, updatedAt: now, fields, secrets, extras: {} };
}

const RECORDS = [
  rec("01A", "nats", "orders", { servers: ["nats://a:4222"], auth: "userPassword", user: "u", tls: { enabled: true }, schemaRegistry: { url: "https://r", auth: "basic", username: "ru" } }, { password: "pw-a", clientKeyPem: "KEY-A", registryPassword: "reg-a" }),
  rec("01B", "langgraph", "agents", { url: "http://127.0.0.1:2024" }, { apiKey: "key-b", headerLines: "X-Team: blue\nX-Env: lab" }),
  rec("01C", "echo", "sample", {}, { token: "tok-c" }),
];

async function seeded() {
  const browser = await openStorage(new IDBFactory());
  expect(browser.kind).toBe("indexeddb");
  for (const r of RECORDS) await browser.putProfile(r);
  return browser;
}

describe("moving the browser's profiles to the server", () => {
  test("a failure half way, then a second run that resumes and clears the browser", async () => {
    const browser = await seeded();
    const fake = createFakeServices(new MemoryStorage());
    const client = fake.services.client;

    // The server goes away after the first record.
    const first = await moveToServer(client, browser, await browser.listProfiles(), new Set(), () => {
      fake.server.down = true;
    });
    expect(first.moved.map((m) => m.from)).toEqual(["01A"]);
    expect(first.failed?.record.id).toBe("01B");
    expect(first.cleared).toBe(false);
    const after = await browser.listProfiles();
    const a = after.find((r) => r.id === "01A")!;
    expect(a.secrets).toEqual({});
    expect(a.importedAs).toBe(first.moved[0]!.to);
    // The others are as they were, secrets included.
    expect(after.find((r) => r.id === "01B")).toEqual(RECORDS[1]);
    expect(after.find((r) => r.id === "01C")).toEqual(RECORDS[2]);
    expect(toMove(after).map((r) => r.id)).toEqual(["01B", "01C"]);

    // The server keeps the secrets under its own names (DOC-25 §3.4.1, Open question 23).
    const sent = fake.server.calls.filter((c) => c.procedure === "profiles.import").map((c) => c.input as { sourceId: string; secrets: string[] });
    expect(sent[0]).toMatchObject({ sourceId: "01A", secrets: ["password", "tls.clientKeyPem", "schemaRegistry.password"] });

    // Again: the rest moves, nothing twice, and the browser keeps no profile.
    fake.server.down = false;
    const second = await moveToServer(client, browser, await browser.listProfiles());
    expect(second.moved.map((m) => m.from)).toEqual(["01B", "01C"]);
    expect(second.cleared).toBe(true);
    expect(await browser.listProfiles()).toEqual([]);
    expect(await browser.listBackups()).toEqual([]);
    const onServer = await fake.storage.listProfiles();
    expect(onServer.map((r) => r.name).sort()).toEqual(["agents", "orders", "sample"]);
    const agents = onServer.find((r) => r.name === "agents")!;
    expect(agents.secrets).toEqual({ apiKey: "key-b", headerLines: "X-Team: blue\nX-Env: lab" });
    // The header names (not secret) are in the fields; their values only in the secret.
    expect(agents.fields["headers"]).toEqual(["X-Team", "X-Env"]);
    const lg = fake.server.calls.find((c) => c.procedure === "profiles.import" && (c.input as { sourceId: string }).sourceId === "01B")!.input as { secrets: string[] };
    expect(lg.secrets).toEqual(["apiKey", "headerValues"]);
  });

  test("an import the server already made is not made again (a crash before the browser wrote importedAs)", async () => {
    const browser = await seeded();
    const fake = createFakeServices(new MemoryStorage());
    const records = await browser.listProfiles();
    // The first run reached the server but not the browser: the records still look unmoved.
    await moveToServer(fake.services.client, new MemoryStorage(), records);
    const result = await moveToServer(fake.services.client, browser, records);
    expect(result.cleared).toBe(true);
    expect((await fake.storage.listProfiles()).length).toBe(3);
  });

  test("a record whose secret the server did not keep stays in the browser", async () => {
    const browser = await seeded();
    const fake = createFakeServices(new MemoryStorage());
    const client = fake.services.client;
    const status = client.secrets.status;
    // A server that answers without the record's secrets.
    (client.secrets as { status: typeof status }).status = async () => ({ secrets: [] });
    const result = await moveToServer(client, browser, await browser.listProfiles());
    expect(result.failed?.record.id).toBe("01A");
    expect(String(result.failed?.error)).toMatch(/does not have password/);
    expect((await browser.listProfiles()).find((r) => r.id === "01A")).toEqual(RECORDS[0]);
  });
});

describe("Docker profiles of version 1 (TSK-144)", () => {
  test("stay as they are in the browser, move as an SSH host holding the key and a profile naming it", async () => {
    const { loadProfiles } = await import("@/profiles/migrate");
    const { profile: docker } = await import("@/tools/docker/profile");
    const browser = await openStorage(new IDBFactory());
    // idb opens the global factory: start from an empty store.
    for (const r of await browser.listProfiles()) await browser.deleteProfile(r.id);
    const old = rec("01D", "docker", "build", { host: "build.lan", port: 22, username: "deploy", auth: "privateKey", hostKey: null, socketPath: "/var/run/docker.sock" }, { privateKey: "KEY-D" });
    await browser.putProfile(old);
    // Not migrated in the browser: the server does it on import.
    const loaded = await loadProfiles(browser, (tool) => (tool === "docker" ? docker : undefined));
    expect(loaded.states["01D"]).toEqual({ kind: "current" });
    expect(loaded.records[0]?.version).toBe(1);

    const fake = createFakeServices(new MemoryStorage());
    const result = await moveToServer(fake.services.client, browser, loaded.records);
    expect(result.failed).toBeUndefined();
    expect(result.moved).toHaveLength(1);
    const [host] = [...fake.server.sshHosts.values()];
    expect(host?.view.fields.host).toBe("build.lan");
    expect(host?.secrets).toEqual({ privateKey: "KEY-D" });
    const stored = await fake.storage.getProfile(result.moved[0]!.to);
    expect(stored?.fields).toEqual({ socketPath: "/var/run/docker.sock", sshHostId: host?.view.id });
    expect(result.cleared).toBe(true);
  });
});

describe("export files carry the SSH hosts their profiles name, never a secret", () => {
  test("export, then plan the import of the file", async () => {
    const { exportFile, planImport } = await import("@/profiles/transfer");
    const { profile: docker } = await import("@/tools/docker/profile");
    const hosts = [
      { id: "H1", name: "build", fields: { host: "build.lan", port: 22, username: "deploy", auth: "privateKey" as const, keepaliveSec: null, hostKey: null }, owner: { kind: "personal" as const }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", secrets: [{ field: "privateKey", set: true, version: 1, setBy: "", setAt: 0 }], usedBy: [], usedByHidden: 0 },
      { id: "H2", name: "unused", fields: { host: "x", port: 22, username: "u" }, owner: { kind: "personal" as const }, etag: "1", createdAt: "", updatedAt: "", createdBy: "", updatedBy: "", access: "owner", secrets: [], usedBy: [], usedByHidden: 0 },
    ];
    const profile = { ...rec("01E", "docker", "build", { sshHostId: "H1", socketPath: "/var/run/docker.sock" }, {}), version: 2 };
    const file = exportFile([profile], { includeSecrets: false, app: "test", hosts });
    expect(file.sshHosts).toEqual([{ id: "H1", name: "build", fields: hosts[0]!.fields }]);
    // The host's settings only: no secret and no secret status.
    expect(Object.keys(file.sshHosts![0]!).sort()).toEqual(["fields", "id", "name"]);
    const plan = planImport(JSON.stringify(file), [], (tool) => (tool === "docker" ? docker : undefined));
    expect(plan.hosts.map((h) => h.id)).toEqual(["H1"]);
    expect(plan.rows[0]?.skipReason).toBeNull();
  });
});
