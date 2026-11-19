// JetStream in the NATS tool (Mightyconsole spec §6.3 to §6.5, TSK-85 batch 2): the stream form's
// model, the streams list and New stream, a stream's Info, Messages (browse on the messaging core,
// Load full payload through getMessage) and Consumers, the purge and delete confirmations, the
// consumer screen with its position bar, the consumer form, and the tree's Streams group, against
// stub clients.
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ServicesContext, type MightyClient } from "@/app/client";
import { describeError } from "@/app/messages";
import { ProgressBus } from "@/app/progress";
import { loadPersisted, StoreProvider } from "@/app/store";
import type { NatsConsumerInfo, NatsStreamConfig, NatsStreamInfo, NatsStreamSummary, TailSummary } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { MemoryStorage } from "@/profiles/storage";
import { COLUMNS } from "@/messaging/columns";
import { natsTool } from "@/tools/nats";
import { CONSUMER_REFRESH_MS, ConsumerTab, positionOf } from "@/tools/nats/ConsumerTab";
import { EMPTY_CONSUMER, consumerConfigOf, consumerErrors } from "@/tools/nats/ConsumerSheet";
import { purgeCount } from "@/tools/nats/JetStreamDialogs";
import { browseStart, DEFAULT_BROWSE } from "@/tools/nats/StreamMessages";
import { StreamTab, consumerKind, discardLine } from "@/tools/nats/StreamTab";
import { StreamsTab } from "@/tools/nats/StreamsTab";
import { profile as schema } from "@/tools/nats/profile";
import { EMPTY_STREAM, FIXED_AFTER_CREATE, configOf, draftOf, exactSize, parseCount, parseSize, readOnlyReason, streamErrors } from "@/tools/nats/stream-form";
import { isBackingStream, natsTreeData, resetTreeData } from "@/tools/nats/tree-data";
import type { TabProps } from "@/tools/types";
import { messageCall, messageTable } from "./support/messages";
import { axeViolations, byRole, byText, cleanup, click, render, type, waitFor } from "./support/render";

afterEach(() => {
  cleanup();
  resetTreeData();
});

function record(): ProfileRecord {
  const d = schema.defaults();
  return { id: "01N", tool: "nats", version: 1, name: "edge-nats", createdAt: "x", updatedAt: "x", ...d };
}

function props(client: unknown, kind: string, params: Record<string, unknown> = {}): TabProps {
  return {
    tab: { id: "t1", tool: "nats", profileId: "01N", kind, params, title: "t", pinned: false },
    profile: record(),
    connId: "conn-1",
    client: client as MightyClient,
    active: true,
    useTabActions: () => {},
    onLive: () => {},
    note: describeError,
    openTab: vi.fn(),
  };
}

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

const summary = (patch: Partial<TailSummary> = {}): TailSummary => ({ scanned: 0, matched: 0, dropped: 0, decodeErrors: 0, endReason: "end", lastPositions: [], ...patch });

const ORDERS: NatsStreamConfig = {
  name: "ORDERS",
  subjects: ["orders.>"],
  storage: "file",
  retention: "limits",
  discard: "old",
  discardNewPerSubject: false,
  maxBytes: 1024 ** 3,
  maxMessages: 5_000_000,
  maxAgeMs: 86_400_000,
  maxMessageSize: 1024 * 1024,
  replicas: 3,
  duplicateWindowMs: 120_000,
  allowDirect: true,
  allowRollup: false,
  denyDelete: false,
  denyPurge: false,
  compression: "s2",
  sealed: false,
  sources: [],
};

const info = (patch: Partial<NatsStreamInfo> = {}, config: Partial<NatsStreamConfig> = {}): NatsStreamInfo => ({
  config: { ...ORDERS, ...config },
  createdUs: 1_794_000_000_000_000,
  state: { messages: 1_284_507, bytes: 812 * 1024 * 1024, firstSequence: 1_002_113, firstUs: Date.now() * 1000 - 8 * 3_600_000_000, lastSequence: 2_286_619, lastUs: Date.now() * 1000, consumers: 2, subjects: 14, deleted: 0 },
  cluster: { name: "eu", leader: "nats-2", replicas: [{ name: "nats-1", current: true, offline: false, lag: 0, activeMs: 10 }, { name: "nats-3", current: true, offline: false, lag: 12, activeMs: 12 }] },
  sources: [],
  subjectCounts: [
    { subject: "orders.created", messages: 512_000 },
    { subject: "orders.paid", messages: 498_000 },
  ],
  ...patch,
});

const consumer = (patch: Partial<NatsConsumerInfo> = {}): NatsConsumerInfo => ({
  stream: "ORDERS",
  name: "billing",
  createdUs: Date.now() * 1000 - 3 * 86_400_000_000,
  config: { name: "billing", durable: true, filterSubjects: ["orders.paid"], deliver: "all", ackPolicy: "explicit", ackWaitMs: 30_000, maxDeliver: 5, replay: "instant", headersOnly: false },
  delivered: { consumer: 1_279_700, stream: 2_281_807 },
  ackFloor: { consumer: 1_279_663, stream: 2_281_770 },
  numPending: 4812,
  numAckPending: 37,
  numRedelivered: 5,
  numWaiting: 2,
  pushBound: false,
  paused: false,
  ...patch,
});

describe("the stream form's model (spec §6.3)", () => {
  test("a configuration goes to the form and back unchanged; sizes stay exact", () => {
    const d = draftOf(ORDERS);
    expect(d).toMatchObject({ maxBytes: "1 GiB", maxMessages: "5000000", maxAge: "1d", maxMessageSize: "1 MiB", replicas: "3", duplicateWindow: "2m" });
    expect(configOf(d, ORDERS)).toEqual(ORDERS);
    expect(exactSize(1_000_000)).toBe("1000000");
    expect(parseSize("1.5 GiB")).toBe(1.5 * 1024 ** 3);
    expect(parseSize("512mb")).toBe(512 * 1024 ** 2);
    expect(parseSize("lots")).toBeNaN();
    expect(parseCount("5,000,000")).toBe(5_000_000);
    expect(FIXED_AFTER_CREATE).toEqual(["name", "storage", "retention"]);
  });

  test("names, subjects, limits and replicas are checked before sending", () => {
    expect(streamErrors(EMPTY_STREAM)).toMatchObject({ name: expect.stringMatching(/required/), subjects: expect.stringMatching(/at least one/) });
    const bad = { ...EMPTY_STREAM, name: "orders.eu", subjects: ["a.>.b"], maxBytes: "a lot", maxAge: "soon", replicas: "7" };
    expect(Object.keys(streamErrors(bad)).sort()).toEqual(["maxAge", "maxBytes", "name", "replicas", "subjects"]);
    expect(streamErrors({ ...EMPTY_STREAM, name: "ORDERS", subjects: ["orders.>"] })).toEqual({});
  });

  test("sealed and mirror streams cannot be edited or purged, and say why", () => {
    expect(readOnlyReason(ORDERS)).toEqual({ edit: null, purge: null });
    expect(readOnlyReason({ ...ORDERS, sealed: true }).edit).toMatch(/sealed/);
    expect(readOnlyReason({ ...ORDERS, mirror: { name: "ORIGIN" } }).purge).toMatch(/mirror of ORIGIN/);
    expect(readOnlyReason({ ...ORDERS, denyPurge: true }).purge).toMatch(/denies purge/);
  });
});

describe("Streams (spec §6.5 nats.js.streams.list, create)", () => {
  const list: NatsStreamSummary[] = [
    { name: "KV_config", subjects: ["$KV.config.>"], messages: 7, bytes: 546, consumers: 0, createdUs: Date.now() * 1000, storage: "file", retention: "limits", sealed: false },
    { name: "ORDERS", subjects: ["orders.>"], messages: 1051, bytes: 1_700_000, consumers: 1, createdUs: Date.now() * 1000, storage: "file", retention: "limits", sealed: false },
  ];

  test("the streams behind KV buckets and object stores are listed apart", async () => {
    expect(isBackingStream(list[0]!)).toBe(true);
    expect(isBackingStream({ name: "OBJ_files", subjects: ["$O.files.C.>", "$O.files.M.>"] })).toBe(true);
    expect(isBackingStream({ name: "KV_mine", subjects: ["kv.mine.>"] })).toBe(false);
    render(<StreamsTab {...props({ nats: { js: { streams: { list: vi.fn(async () => list) } } } }, "nats.streams")} />);
    await waitFor(() => byRole("button", "ORDERS") !== null, "the list");
    expect(byRole("button", "KV_config")).toBeNull();
    await click(byRole("switch") ?? document.querySelector("[role=switch]"));
    await waitFor(() => byRole("button", "KV_config") !== null, "the KV stream");
  });

  test("the list opens a stream; New stream creates one; Conflict marks the name and keeps the form", async () => {
    const streamsList = vi.fn(async () => list);
    let created: NatsStreamConfig | null = null;
    const create = vi.fn(async ({ config }: { config: NatsStreamConfig }) => {
      if (config.name === "ORDERS") throw new RpcError("FailedPrecondition", "stream name already in use", { details: { kind: "Conflict", system: "nats", message: "stream name already in use", field: "name", retryable: false } });
      created = config;
      return info({}, config);
    });
    const p = props({ nats: { js: { streams: { list: streamsList, create }, consumers: { list: vi.fn(async () => []) } } } }, "nats.streams");
    const { container } = render(<StreamsTab {...p} />);
    await waitFor(() => byRole("button", "ORDERS") !== null, "the list");
    expect(byText("1,051")).not.toBeNull();
    await click(byRole("button", "ORDERS"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "nats.stream", params: { stream: "ORDERS" }, title: "ORDERS" });
    expect(await axeViolations(container)).toEqual([]);

    await click(byRole("button", "New stream"));
    await waitFor(() => document.querySelector("form[aria-label='New stream']") !== null, "the sheet");
    await click(byRole("button", "Create stream"));
    await waitFor(() => byText("A stream name is required.") !== null, "the form's check");
    expect(create).not.toHaveBeenCalled();
    await type(byRole("textbox", /^Name\*?$/) as HTMLInputElement, "ORDERS");
    const add = byRole("textbox", "Subjects: add") as HTMLInputElement;
    await type(add, "orders.>");
    add.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await type(byRole("textbox", "Max messages") as HTMLInputElement, "1,000");
    await click(byRole("button", "Create stream"));
    await waitFor(() => byText("stream name already in use") !== null, "the server's error");
    expect((byRole("textbox", /^Name\*?$/) as HTMLInputElement).value).toBe("ORDERS");
    expect(byRole("textbox", /^Name\*?$/)!.closest("[data-invalid]")).not.toBeNull();
    await type(byRole("textbox", /^Name\*?$/) as HTMLInputElement, "AUDIT");
    await click(byRole("button", "Create stream"));
    await waitFor(() => created !== null, "the create");
    expect(created).toMatchObject({ name: "AUDIT", subjects: ["orders.>"], maxMessages: 1000, storage: "file", retention: "limits", replicas: 1 });
  });
});

describe("Stream (spec §6.3)", () => {
  const client = (over: Record<string, unknown> = {}) => {
    const streams = { info: vi.fn(async () => info()), purge: vi.fn(async () => ({ purged: 512_000 })), delete: vi.fn(async () => ({})), update: vi.fn(async ({ config }: { config: NatsStreamConfig }) => info({}, config)), list: vi.fn(async () => []), browse: vi.fn(), getMessage: vi.fn(), ...over };
    return { nats: { js: { streams, consumers: { list: vi.fn(async () => [consumer()]), create: vi.fn() } } }, messaging: { filter: { check: vi.fn(async () => ({ ok: true, errors: [] })) }, schemas: { inspect: vi.fn() } } };
  };

  test("Info: counts, limits as bars, the configuration, the cluster and the busiest subjects", async () => {
    const c = client();
    const p = props(c, "nats.stream", { stream: "ORDERS" });
    const { container } = await mountWithStore(<StreamTab {...p} />);
    await waitFor(() => byText("1,284,507") !== null, "the facts");
    expect(c.nats.js.streams.info).toHaveBeenCalledWith({ connId: "conn-1", stream: "ORDERS", subjectCounts: true });
    expect(byText(/seq 1,002,113/)).not.toBeNull();
    expect(byRole("progressbar", "Bytes")).not.toBeNull();
    expect(byText("812 MiB / 1 GiB")).not.toBeNull();
    expect(byText("Discard old: at a limit the oldest messages go first.")).not.toBeNull();
    expect(byText("file, s2 compression")).not.toBeNull();
    expect(byText("current · lag 12")).not.toBeNull();
    expect(byText(/file · limits/)).not.toBeNull();
    // A subject opens Messages filtered by it.
    await click(byRole("button", "orders.paid"));
    await waitFor(() => (byRole("textbox", "Subject filter") as HTMLInputElement | null)?.value === "orders.paid", "the filtered Messages");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Messages: browse from a sequence with a subject filter; Load full payload uses getMessage", async () => {
    const built = messageCall(
      messageTable([
        { subject: "orders.paid", sequence: 10n, value: '{"id":10}' },
        { subject: "orders.paid", sequence: 11n, value: "x".repeat(32), size: 1_600_000, truncated: true, codec: "utf8" },
      ]),
      summary({ scanned: 2, matched: 2 }),
    );
    const browse = vi.fn(() => built.call);
    const getMessage = vi.fn(async () => ({ source: "ORDERS", subject: "orders.paid", sequence: "11", timestampUs: 0, timestampKind: "stored", headers: [], payloadRaw: btoa("the whole payload"), payloadSize: 17, payloadTruncated: false, payloadText: "the whole payload", payloadCodec: "utf8" }));
    const p = props(client({ browse, getMessage }), "nats.stream", { stream: "ORDERS", section: "messages" });
    const { container } = await mountWithStore(<StreamTab {...p} />);
    await waitFor(() => byRole("group", "Browse from") !== null, "the browse bar");
    await click(byRole("button", "Sequence"));
    await type(byRole("textbox", "Sequence") as HTMLInputElement, "10");
    await type(byRole("textbox", "Subject filter") as HTMLInputElement, "orders.paid");
    await click(byRole("button", "Browse"));
    await waitFor(() => byText("orders.paid") !== null, "the rows");
    const [input, options] = browse.mock.calls[0]! as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(input).toMatchObject({ connId: "conn-1", stream: "ORDERS", start: { from: "sequence", sequence: 10 }, subject: "orders.paid", follow: false });
    expect(options).toEqual({ timeoutMs: 300_000 });
    expect(COLUMNS.jetstream).toEqual(["sequence", "subject", "timestamp", "payloadSize", "payloadText"]);
    const cutRow = () => [...container.querySelectorAll<HTMLElement>(".bdg-body > [role=row]:not([hidden])")].find((r) => [...r.querySelectorAll("[role=gridcell]")].some((c) => c.textContent === "11"));
    await waitFor(() => cutRow() !== undefined, "the cut row");
    await click(cutRow()!.querySelector("[role=gridcell]"));
    const detail = () => container.querySelector<HTMLElement>("[data-slot=message-detail]");
    await waitFor(() => detail() !== null && byRole("button", /Load full payload/, detail()!) !== null, "the detail with Load full payload");
    await click(byRole("button", /Load full payload/, detail()!));
    await waitFor(() => getMessage.mock.calls.length === 1, "the full payload");
    expect(getMessage).toHaveBeenCalledWith(expect.objectContaining({ connId: "conn-1", stream: "ORDERS", sequence: 11 }));
    expect(byText(/stops at seq 2,286,619 unless Follow is on/)).not.toBeNull();
  });

  test("the browse's start: first, last n, a sequence or a time", () => {
    expect(browseStart(DEFAULT_BROWSE)).toEqual({ start: { from: "last", n: 1000 } });
    expect(browseStart({ ...DEFAULT_BROWSE, from: "first" })).toEqual({ start: { from: "first" } });
    expect(browseStart({ ...DEFAULT_BROWSE, from: "sequence", sequence: "0" })).toHaveProperty("error");
    const t = browseStart({ ...DEFAULT_BROWSE, from: "time", time: "2026-11-19T10:00:00" });
    expect("start" in t && t.start.from === "time" && (t.start.timeUs ?? 0) > 0).toBe(true);
  });

  test("Purge: all needs the typed name; a subject says how many go; the server's count is shown", async () => {
    const c = client();
    const p = props(c, "nats.stream", { stream: "ORDERS" });
    await mountWithStore(<StreamTab {...p} />);
    await waitFor(() => byRole("button", "Purge…") !== null && !(byRole("button", "Purge…") as HTMLButtonElement).disabled, "the header");
    await click(byRole("button", "Purge…"));
    await waitFor(() => byRole("alertdialog") !== null, "the dialog");
    expect(byText("Purge messages from ORDERS on edge-nats?")).not.toBeNull();
    const purgeAll = () => byRole("button", "Purge 1,284,507 messages") as HTMLButtonElement;
    expect(purgeAll().disabled).toBe(true);
    await type(byRole("textbox", "Type ORDERS to purge all") as HTMLInputElement, "ORDERS");
    expect(purgeAll().disabled).toBe(false);
    await click(byRole("radio", "Only a subject"));
    await waitFor(() => byRole("button", "Purge 512,000 messages") !== null, "the subject's count");
    await click(byRole("button", "Purge 512,000 messages"));
    await waitFor(() => c.nats.js.streams.purge.mock.calls.length === 1, "the purge");
    expect(c.nats.js.streams.purge).toHaveBeenCalledWith({ connId: "conn-1", stream: "ORDERS", subject: "orders.created" });
    expect(purgeCount(info(), "keep", "", 1000)).toBe(1_283_507);
    expect(purgeCount(info(), "sequence", "", null)).toBeNull();
  });

  test("Delete stream asks for the name; a mirror cannot be edited or purged", async () => {
    const c = client();
    await mountWithStore(<StreamTab {...props(c, "nats.stream", { stream: "ORDERS" })} />);
    await waitFor(() => byText("1,284,507") !== null, "the stream");
    await click(byRole("button", /More: Delete stream/));
    await click(byRole("menuitem", /Delete stream/));
    await waitFor(() => byRole("alertdialog") !== null, "the dialog");
    expect(byText(/2 consumers are deleted from every replica/)).not.toBeNull();
    const del = () => byRole("button", "Delete stream") as HTMLButtonElement;
    expect(del().disabled).toBe(true);
    await type(byRole("textbox", "Type ORDERS to confirm") as HTMLInputElement, "ORDERS");
    await click(del());
    await waitFor(() => c.nats.js.streams.delete.mock.calls.length === 1, "the delete");
    cleanup();
    const mirror = client({ info: vi.fn(async () => info({ mirror: { name: "ORIGIN", lag: 3 } }, { mirror: { name: "ORIGIN" } })) });
    await mountWithStore(<StreamTab {...props(mirror, "nats.stream", { stream: "ORDERS" })} />);
    await waitFor(() => byText(/mirror of ORIGIN/) !== null, "the mirror");
    expect((byRole("button", "Edit") as HTMLButtonElement).disabled).toBe(true);
    expect((byRole("button", "Purge…") as HTMLButtonElement).disabled).toBe(true);
    expect(byText(/its settings follow the origin/)).not.toBeNull();
  });

  test("Consumers: the table opens a consumer", async () => {
    const p = props(client(), "nats.stream", { stream: "ORDERS", section: "consumers" });
    await mountWithStore(<StreamTab {...p} />);
    await waitFor(() => byRole("button", "billing") !== null, "the table");
    expect(byText("pull · durable")).not.toBeNull();
    expect(byText("4,812")).not.toBeNull();
    await click(byRole("button", "billing"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "nats.consumer", params: { stream: "ORDERS", consumer: "billing" }, title: "billing" });
    expect(consumerKind(consumer({ config: { ...consumer().config, durable: false, deliverSubject: "d.x" } }))).toBe("push · ephemeral");
    expect(discardLine(info({}, { retention: "workQueue" }))).toMatch(/Work queue/);
  });
});

describe("Consumer (spec §6.3)", () => {
  test("pending, ack pending, redelivered and waiting; the position bar; Pause refresh", async () => {
    const consumersInfo = vi.fn(async () => consumer());
    const c = { nats: { js: { consumers: { info: consumersInfo, delete: vi.fn(async () => ({})) }, streams: { info: vi.fn(async () => info()) } } } };
    const p = props(c, "nats.consumer", { stream: "ORDERS", consumer: "billing" });
    const { container } = render(<ConsumerTab {...p} />);
    await waitFor(() => byText("4,812") !== null, "the state");
    expect(byText("37")).not.toBeNull();
    expect(byText(/Consumer of ORDERS · filter orders.paid · ack explicit · ack wait 30 s · max deliver 5/)).not.toBeNull();
    const bar = byRole("img", /Acknowledged up to stream sequence 2,281,770/)!;
    const acked = bar.querySelector<HTMLElement>("[data-part=acked]")!.style.width;
    expect(Number.parseFloat(acked)).toBeGreaterThan(99);
    expect(byText("Refreshing every 2 s")).not.toBeNull();
    await click(byRole("button", "Pause refresh"));
    expect(byText("Refreshing every 2 s")).toBeNull();
    expect(byRole("button", "Resume refresh")).not.toBeNull();
    expect(CONSUMER_REFRESH_MS).toBe(2000);
    expect(await axeViolations(container)).toEqual([]);
    await click(byRole("button", "Delete…"));
    await waitFor(() => byText("Delete consumer billing of ORDERS on edge-nats?") !== null, "the confirmation");
    await click(byRole("button", "Delete consumer"));
    await waitFor(() => byText("billing was deleted.") !== null, "the deleted state");
  });

  test("the position: acknowledged, delivered and not acknowledged, the rest", () => {
    const p = positionOf({ firstSequence: 1, lastSequence: 100, messages: 100 }, { ackFloor: { consumer: 0, stream: 50 }, delivered: { consumer: 0, stream: 60 } });
    expect(p).toEqual({ first: 1, last: 100, acked: 50, delivered: 10, rest: 40 });
    expect(positionOf({ firstSequence: 0, lastSequence: 0, messages: 0 }, { ackFloor: { consumer: 0, stream: 0 }, delivered: { consumer: 0, stream: 0 } }).rest).toBe(100);
  });

  test("the consumer form: checks and the configuration it makes", () => {
    expect(consumerErrors(EMPTY_CONSUMER)).toHaveProperty("name");
    expect(consumerErrors({ ...EMPTY_CONSUMER, name: "x", kind: "push" })).toHaveProperty("deliverSubject");
    expect(consumerErrors({ ...EMPTY_CONSUMER, name: "x", deliver: "byStartSequence" })).toHaveProperty("startSequence");
    const c = consumerConfigOf({ ...EMPTY_CONSUMER, name: "billing", filterSubjects: ["orders.eu.>"], maxDeliver: "5", durable: false, inactiveThreshold: "10m" });
    expect(c).toEqual({ name: "billing", durable: false, filterSubjects: ["orders.eu.>"], deliver: "all", ackPolicy: "explicit", ackWaitMs: 30_000, maxDeliver: 5, replay: "instant", headersOnly: false, inactiveThresholdMs: 600_000 });
  });
});

describe("the tree (spec §6.2)", () => {
  test("Streams lists each stream with its consumers once loaded", async () => {
    const client = {
      nats: {
        js: {
          streams: { list: vi.fn(async () => [{ name: "ORDERS", subjects: ["orders.>"], messages: 1, bytes: 1, consumers: 1, createdUs: 0, storage: "file", retention: "limits", sealed: false }]) },
          consumers: { list: vi.fn(async () => [consumer()]) },
        },
      },
    };
    natsTreeData.load({ profile: record(), connId: "c-tree", client: client as never });
    await waitFor(() => (natsTool.sidebarTree({ profile: record(), connId: "c-tree" })[2]!.children ?? []).some((n) => (n.children ?? []).length > 0), "the consumers");
    const streams = natsTool.sidebarTree({ profile: record(), connId: "c-tree" })[2]!;
    expect(streams.open).toEqual({ kind: "nats.streams", params: {}, title: "Streams" });
    expect(streams.children!.map((n) => n.label)).toEqual(["ORDERS"]);
    expect(streams.children![0]!.children![0]!.open).toEqual({ kind: "nats.consumer", params: { stream: "ORDERS", consumer: "billing" }, title: "billing" });
    expect(Object.keys(natsTool.tabKinds)).toEqual(["nats.server", "nats.subscribe", "nats.publish", "nats.streams", "nats.stream", "nats.consumer", "nats.kvs", "nats.kv"]);
  });

  test("JetStream off: the group says why", async () => {
    const client = { nats: { js: { streams: { list: vi.fn(async () => Promise.reject(new RpcError("Unavailable", "JetStream did not answer: it is not enabled on this server or for this account"))) } } } };
    natsTreeData.load({ profile: record(), connId: "c-off", client: client as never });
    await waitFor(() => (natsTool.sidebarTree({ profile: record(), connId: "c-off" })[2]!.children ?? []).length === 1, "the reason");
    expect(natsTool.sidebarTree({ profile: record(), connId: "c-off" })[2]!.children![0]!.label).toMatch(/not enabled/);
  });
});
