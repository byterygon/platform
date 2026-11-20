// The NATS tool's first batch in the UI (Mightyconsole spec §6, TSK-85): the profile (defaults,
// validation per authentication, `toConnect` sending only the chosen secret), the module in the
// navigation, the Server screen with the JetStream account, Subscribe (subjects as tags, the queue
// group, the live tail of the messaging core) and Publish (publish, request with the reply beside
// the form, no responders, the send history), against stub clients.
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ServicesContext, type MightyClient } from "@/app/client";
import { describeError } from "@/app/messages";
import { ProgressBus } from "@/app/progress";
import { loadPersisted, StoreProvider } from "@/app/store";
import type { ConnectNatsProfile, NatsRequestOutput, NatsServerInfoOutput, TailSummary } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { MemoryStorage } from "@/profiles/storage";
import { COLUMNS } from "@/messaging/columns";
import { natsTool } from "@/tools/nats";
import { PublishTab, remember, replyText, type SendRecord } from "@/tools/nats/PublishTab";
import { ServerTab, formatSize } from "@/tools/nats/ServerTab";
import { SubscribeTab, subscribeTitle } from "@/tools/nats/SubscribeTab";
import { profile as schema, validatePattern, validateServer, validateSubject } from "@/tools/nats/profile";
import { orderedTools, TOOLS, toolCategory } from "@/tools/registry";
import type { TabProps } from "@/tools/types";
import { messageCall, messageTable } from "./support/messages";
import { axeViolations, byRole, byText, cleanup, click, editorArea, render, type, waitFor } from "./support/render";

afterEach(cleanup);

function record(patch: { fields?: Record<string, unknown>; secrets?: Record<string, unknown>; extras?: Record<string, unknown> } = {}): ProfileRecord {
  const d = schema.defaults();
  return { id: "01N", tool: "nats", version: 1, name: "edge-nats", createdAt: "x", updatedAt: "x", fields: { ...d.fields, ...patch.fields }, secrets: { ...d.secrets, ...patch.secrets }, extras: { ...d.extras, ...patch.extras } };
}

function props(client: unknown, kind: string, params: Record<string, unknown> = {}, profile = record()): TabProps & { updateProfile: ReturnType<typeof vi.fn> } {
  return {
    tab: { id: "t1", tool: "nats", profileId: "01N", kind, params, title: "t", pinned: false },
    profile,
    connId: "conn-1",
    client: client as MightyClient,
    active: true,
    useTabActions: () => {},
    onLive: () => {},
    note: describeError,
    openTab: vi.fn(),
    updateProfile: vi.fn(async () => {}),
  };
}

describe("the profile (spec §6.1)", () => {
  test("defaults are valid and connect to the local server without credentials", () => {
    const r = record();
    expect(schema.validate(r)).toEqual({});
    const c = schema.toConnect(r);
    expect(c).toMatchObject({ name: "edge-nats", servers: ["nats://127.0.0.1:4222"], auth: "none", user: null, password: null, token: null, nkeySeed: null, creds: null, requestTimeoutMs: 5000, inboxPrefix: "_INBOX" });
  });

  test("each authentication asks for its own value and sends only it", () => {
    expect(schema.validate(record({ fields: { auth: "userPassword" } }))).toHaveProperty("user");
    expect(schema.validate(record({ fields: { auth: "token" } }))).toHaveProperty("token");
    expect(schema.validate(record({ fields: { auth: "nkey" }, secrets: { nkeySeed: "SAxyz" } }))["nkeySeed"]).toMatch(/starts with SU/);
    expect(schema.validate(record({ fields: { auth: "creds" }, secrets: { creds: "nope" } }))["creds"]).toMatch(/whole .creds/);
    // Secrets of another authentication stay in the browser.
    const c = (schema.toConnect(record({ fields: { auth: "token", user: "lab" }, secrets: { token: "t0k", password: "pw", creds: "x" } })) as ConnectNatsProfile);
    expect(c).toMatchObject({ auth: "token", token: "t0k", user: null, password: null, creds: null });
    const u = (schema.toConnect(record({ fields: { auth: "userPassword", user: " lab " }, secrets: { password: "" } })) as ConnectNatsProfile);
    expect(u).toMatchObject({ user: "lab", password: "" });
  });

  test("servers, TLS and the timeout are checked", () => {
    expect(validateServer("tls://nats.example:4222")).toBeNull();
    expect(validateServer("127.0.0.1:4222")).toBeNull();
    expect(validateServer("http://x:1")).toMatch(/nats:\/\//);
    expect(schema.validate(record({ fields: { servers: ["nats://a:99999"] } }))["servers"]).toMatch(/port/);
    expect(schema.validate(record({ fields: { tls: { enabled: true, clientCertPem: "PEM" } } }))["tls"]).toMatch(/private key/);
    expect(schema.validate(record({ fields: { requestTimeoutMs: 0 } }))).toHaveProperty("requestTimeoutMs");
    const c = (schema.toConnect(record({ fields: { tls: { enabled: true, caPem: "CA" } }, secrets: { clientKeyPem: "" } })) as ConnectNatsProfile);
    expect(c.tls).toEqual({ enabled: true, caPem: "CA", clientCertPem: null, serverName: null, clientKeyPem: null });
  });

  test("subjects: wildcards subscribe, publishing needs a whole subject", () => {
    expect(validatePattern("orders.*.created")).toBeNull();
    expect(validatePattern("orders.>")).toBeNull();
    expect(validatePattern("a.>.b")).toMatch(/last/);
    expect(validatePattern("a..b")).toMatch(/empty/);
    expect(validateSubject("orders.eu.created")).toBeNull();
    expect(validateSubject("orders.*")).toMatch(/Wildcards/);
  });
});

describe("the module (spec §2.2, §6.2)", () => {
  test("NATS is first under Messaging, with its mark; the tree lists the bookmarks", () => {
    expect(TOOLS).toContain(natsTool);
    expect(toolCategory(natsTool)).toBe("Messaging");
    expect(orderedTools(TOOLS)[0]).toBe(natsTool);
    expect(natsTool.mark).toBeDefined();
    const tree = natsTool.sidebarTree({ profile: record({ extras: { subjects: ["orders.>"] } }), connId: "c" });
    expect(tree.map((n) => n.label)).toEqual(["Server", "Subjects", "Streams", "Key-Value", "Object Store", "Services", "Publish"]);
    const subjects = tree[1]!.children!;
    expect(subjects.map((n) => n.label)).toEqual(["Subscribe to…", "orders.>"]);
    expect(subjects[1]!.open).toEqual({ kind: "nats.subscribe", params: { subjects: ["orders.>"] }, title: "Subscribe orders.>" });
    expect(subscribeTitle({ subjects: ["a.>", "b.*"] })).toBe("Subscribe a.> +1");
  });
});

const serverInfo = (patch: Partial<NatsServerInfoOutput> = {}): NatsServerInfoOutput => ({
  server: { serverId: "NCQ4XKZ", serverName: "nats-2", version: "2.12.1", go: "go1.24", host: "0.0.0.0", port: 4222, maxPayload: 1_048_576, proto: 1, clientId: 1182, clientIp: "127.0.0.1", connectUrls: ["nats-1:4222"], headers: true, authRequired: true, tlsRequired: false, jetstream: true, lameDuckMode: false, cluster: "eu" },
  rttMs: 0.6,
  connection: { name: "mightyconsole", servers: ["nats://127.0.0.1:4222"], tls: true, auth: "nkey", state: "connected", inMessages: 10, outMessages: 4, inBytes: 2048, outBytes: 512, connects: 1 },
  jetstream: { memory: 120 * 1024 * 1024, storage: 1900 * 1024 * 1024, streams: 3, consumers: 7, limits: { maxStorage: 10 * 1024 * 1024 * 1024, maxStreams: 50 }, apiTotal: 18204, apiErrors: 2 },
  ...patch,
});

describe("Server (spec §6.3)", () => {
  test("ServerInfo, this connection and the JetStream account as bars", async () => {
    const info = vi.fn(async () => serverInfo());
    const { container } = render(<ServerTab {...props({ nats: { server: { info } } }, "nats.server")} />);
    await waitFor(() => byText("JetStream on") !== null, "the server");
    expect(byText("edge-nats · NATS 2.12.1 · cluster eu · TLS · RTT 0.6 ms")).not.toBeNull();
    expect(byText("1.9 GiB / 10 GiB")).not.toBeNull();
    expect(byText("120 MiB · no limit")).not.toBeNull();
    expect(byText("3 / 50")).not.toBeNull();
    expect(byRole("progressbar", "Storage")).not.toBeNull();
    expect(byRole("button", "Copy server ID")).not.toBeNull();
    expect(info).toHaveBeenCalledWith({ connId: "conn-1" });
    expect(await axeViolations(container)).toEqual([]);
  });

  test("JetStream off says so", async () => {
    const info = async () => serverInfo({ jetstream: null, jetstreamError: "JetStream is not enabled on this server" });
    render(<ServerTab {...props({ nats: { server: { info } } }, "nats.server")} />);
    await waitFor(() => byText("JetStream is not enabled on this server") !== null, "the reason");
    expect(byText("JetStream off")).not.toBeNull();
    expect(formatSize(1_048_576)).toBe("1 MiB");
    expect(formatSize(980)).toBe("980 B");
  });
});

const summary = (patch: Partial<TailSummary> = {}): TailSummary => ({ scanned: 0, matched: 0, dropped: 0, decodeErrors: 0, endReason: "cancelled", lastPositions: [], ...patch });

async function mountWithStore(ui: React.ReactNode) {
  const storage = new MemoryStorage();
  const persisted = await loadPersisted(storage, ["nats"]);
  const services = { decoder: inThreadArrowDecoder(), progress: new ProgressBus() };
  return render(
    <ServicesContext.Provider value={services as never}>
      <StoreProvider persisted={persisted} storage={storage} saveDelayMs={0}>
        {ui}
      </StoreProvider>
    </ServicesContext.Provider>,
  );
}

describe("Subscribe (spec §6.3)", () => {
  test("subjects as tags and a queue group; the live tail shows subject, reply and value", async () => {
    const built = messageCall(
      messageTable([
        { subject: "orders.eu.created", value: '{"id":1}', replyTo: "_INBOX.r1" },
        { subject: "orders.us.created", value: "plain", codec: "utf8" },
      ]),
      summary({ scanned: 2, matched: 2 }),
      { endless: true },
    );
    const subscribe = vi.fn(() => built.call);
    const check = vi.fn(async () => ({ ok: true, errors: [] }));
    const p = props({ nats: { core: { subscribe } }, messaging: { filter: { check } } }, "nats.subscribe", { subjects: ["orders.>"] }, record({ extras: { subjects: ["payments.*"] } }));
    const { container } = await mountWithStore(<SubscribeTab {...p} />);
    const tags = () => Array.from(document.querySelectorAll("ul[aria-label='Subjects'] li")).map((li) => li.textContent);
    expect(tags()).toEqual(["orders.>"]);
    // A bookmark adds a tag; a typed pattern too; a bad one is refused.
    await click(byRole("button", "payments.*"));
    const add = byRole("textbox", "Subjects: add") as HTMLInputElement;
    await type(add, "a.>.b");
    add.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => byText(/> comes last/) !== null, "the refused pattern");
    await type(add, "lab.*");
    add.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await waitFor(() => byRole("button", "Remove lab.*") !== null, "the new tag");
    await click(byRole("button", "Remove lab.*"));
    await type(byRole("textbox", "Queue group") as HTMLInputElement, "workers");
    await click(byRole("button", "Start"));
    await waitFor(() => byText("orders.us.created") !== null, "the rows");
    expect(subscribe).toHaveBeenCalledTimes(1);
    const [input] = subscribe.mock.calls[0]! as unknown as [Record<string, unknown>];
    expect(input).toMatchObject({ connId: "conn-1", subjects: ["orders.>", "payments.*"], queueGroup: "workers" });
    expect(COLUMNS.nats).toEqual(["timestamp", "subject", "replyTo", "payloadSize", "payloadText"]);
    // Bookmarking saves the subjects not saved yet.
    await click(byRole("button", "Bookmark subject"));
    const change = p.updateProfile.mock.calls[0]![0] as (r: ProfileRecord) => ProfileRecord;
    expect(change(p.profile).extras["subjects"]).toEqual(["payments.*", "orders.>"]);
    expect(await axeViolations(container)).toEqual([]);
    await click(byRole("button", "Stop"));
  });
});

const reply = (patch: Partial<NatsRequestOutput["reply"]> = {}): NatsRequestOutput => ({
  reply: { source: "_INBOX.x.1", subject: "_INBOX.x.1", timestampUs: 0, timestampKind: "received", headers: [{ name: "Lab-Service", value: "echo", encoding: "text" }], payloadRaw: btoa('{"ok":true}'), payloadSize: 11, payloadTruncated: false, payloadText: '{"ok":true}', payloadCodec: "json", ...patch },
  elapsedMs: 12.3,
  bytes: 11,
});

describe("Publish (spec §6.3)", () => {
  const clientWith = (core: Record<string, unknown>) => ({
    nats: { core },
    messaging: { encode: vi.fn(async () => ({ bytes: "", size: 0 })), schemas: { inspect: vi.fn() } },
  });

  test("publishes with headers and a reply subject; the send goes in the history", async () => {
    const publish = vi.fn(async () => ({ bytes: 9 }));
    const p = props(clientWith({ publish }), "nats.publish");
    const { container } = render(<PublishTab {...p} />);
    await type(byRole("textbox", "Subject") as HTMLInputElement, "orders.eu.created");
    await type(byRole("textbox", "Reply subject") as HTMLInputElement, "lab.reply");
    await click(byRole("button", "Send"));
    await waitFor(() => byText("Published 9 bytes on orders.eu.created.") !== null, "the result");
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ connId: "conn-1", subject: "orders.eu.created", replyTo: "lab.reply", headers: [], payload: { codec: "json", text: "{\n  \n}" } }));
    expect(byText(/9 B published/)).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("an empty or wildcard subject is refused before sending", async () => {
    const publish = vi.fn();
    render(<PublishTab {...props(clientWith({ publish }), "nats.publish")} />);
    await click(byRole("button", "Send"));
    await waitFor(() => byText("A subject is required.") !== null, "the empty subject");
    await type(byRole("textbox", "Subject") as HTMLInputElement, "orders.*");
    await click(byRole("button", "Send"));
    await waitFor(() => byText(/Wildcards/) !== null, "the refusal");
    expect(publish).not.toHaveBeenCalled();
  });

  test("request: the reply beside the form; no responders said plainly; Use again restores the send", async () => {
    let answer: () => Promise<NatsRequestOutput> = async () => reply();
    const request = vi.fn(() => answer());
    const p = props(clientWith({ request }), "nats.publish", { mode: "request", subject: "lab.echo" });
    const { container } = render(<PublishTab {...p} />);
    await click(byRole("button", "Send"));
    await waitFor(() => byText("12 ms") !== null, "the reply");
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ subject: "lab.echo", timeoutMs: 5000 }), { timeoutMs: 10_000 });
    expect(byText("Lab-Service")).not.toBeNull();
    expect(byRole("region", "Reply payload")?.textContent ?? "").toContain('"ok": true');
    expect(await axeViolations(container)).toEqual([]);

    answer = async () => {
      throw new RpcError("Unavailable", "No responders on lab.nobody", { details: { kind: "Remote", system: "nats", message: "No responders on lab.nobody", remote: { code: "no_responders" }, retryable: false } });
    };
    await type(byRole("textbox", "Subject") as HTMLInputElement, "lab.nobody");
    await click(byRole("button", "Send"));
    await waitFor(() => byRole("alert") !== null, "the failure");
    expect(byRole("alert")?.textContent).toBe("No responders on lab.nobody");
    // The form is kept, and both sends are in the history, newest first.
    expect((byRole("textbox", "Subject") as HTMLInputElement).value).toBe("lab.nobody");
    const items = Array.from(document.querySelectorAll("section[aria-label='Send history'] li")).map((li) => li.textContent ?? "");
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("No responders");
    await click(byRole("button", /^Use again: lab\.echo/));
    expect((byRole("textbox", "Subject") as HTMLInputElement).value).toBe("lab.echo");
    expect(editorArea("Payload")).not.toBeNull();
  });

  test("history keeps the last 20; reply text is pretty JSON or the bytes as text", () => {
    let h: SendRecord[] = [];
    for (let i = 0; i < 25; i += 1) h = remember(h, { id: i, at: new Date(0), mode: "publish", subject: `s.${i}`, replyTo: "", timeoutMs: 1, draft: { key: null, headers: [], value: { codec: "utf8", text: "" } }, outcome: "", ok: true });
    expect(h).toHaveLength(20);
    expect(h[0]!.subject).toBe("s.24");
    expect(replyText(reply().reply)).toEqual({ text: '{\n  "ok": true\n}', json: true });
    const { payloadText: _drop, ...noText } = reply({ payloadRaw: btoa("hi"), payloadCodec: "hex" }).reply;
    expect(replyText(noText as NatsRequestOutput["reply"])).toEqual({ text: "hi", json: false });
  });
});
