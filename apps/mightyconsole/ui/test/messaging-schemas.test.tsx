// The decoding UI of the messaging core (TSK-85 batch 4, DOC-21 Open question 45 (p)): the model
// (subject matching, where a kept mapping goes, the codec choices), the Schemas tab on a NATS
// connection (status, counts, order, delete with undo), the mapping sheet's test on the last
// messages, the schema sheet's compile errors at file and line and its message types, and
// "Decode as…" in the detail pane, against stub clients.
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MightyClient } from "@/app/client";
import { describeError } from "@/app/messages";
import { NoticeContext } from "@/app/page";
import type { Inspection, LocalSchema, MappingTestOutput, SchemaMapping, SchemasStatusOutput } from "@/gen/api";
import type { MessageRow } from "@/messaging/arrow";
import { LABELS } from "@/messaging/columns";
import { MessageDetail } from "@/messaging/MessageDetail";
import type { DecodeAs } from "@/messaging/schemas/DecodeAs";
import { choiceText, decodeChoices, firstMapping, insertAbove, mappingFromChoice, mappingMatches, mappingSchemaText, moveItem, newId, subjectMatches, targetProblem } from "@/messaging/schemas/model";
import { registryOf, registryProblems, splitPatterns, withRegistry } from "@/messaging/schemas/registry";
import { importPath, issueText } from "@/messaging/schemas/SchemaSheet";
import { schemaChoices } from "@/messaging/schemas/use-decoding";
import type { ProfileRecord } from "@/profiles/record";
import { natsTool } from "@/tools/nats";
import { SchemasTab, bucketPlace, subjectPlace } from "@/tools/nats/SchemasTab";
import { profile as schema } from "@/tools/nats/profile";
import type { TabProps } from "@/tools/types";
import { axeViolations, byRole, byText, cleanup, click, render, settle, type, waitFor } from "./support/render";

afterEach(() => cleanup());

const ORDERS: LocalSchema = { id: "s1", name: "orders", type: "protobuf", files: [{ path: "lab/orders/order.proto", text: "syntax = \"proto3\";" }, { path: "lab/common/money.proto", text: "" }] };
const AUDIT: LocalSchema = { id: "s2", name: "audit", type: "avro", files: [{ path: "audit.avsc", text: "{}" }] };
const M_ORDERS: SchemaMapping = { id: "m1", target: { kind: "subject", pattern: "orders.>" }, part: "value", codec: "protobuf", schemaId: "s1", messageType: "lab.orders.Order" };
const M_SESSIONS: SchemaMapping = { id: "m2", target: { kind: "kvBucket", bucket: "sessions" }, part: "value", codec: "cbor" };
const M_PAYMENTS: SchemaMapping = { id: "m3", target: { kind: "stream", name: "PAYMENTS" }, part: "value", schemaId: "s1", wireFormat: "confluent" };

function record(extras: Record<string, unknown> = {}): ProfileRecord {
  const d = schema.defaults();
  return { id: "01N", tool: "nats", version: 1, name: "edge-nats", createdAt: "x", updatedAt: "x", ...d, extras: { ...d.extras, ...extras } };
}

describe("the decoding model", () => {
  test("subjects, targets, where a kept mapping goes, ids and order", () => {
    expect(subjectMatches("orders.*.created", "orders.eu.created")).toBe(true);
    expect(subjectMatches("orders.*.created", "orders.eu.x.created")).toBe(false);
    expect(subjectMatches("orders.>", "orders.eu.created")).toBe(true);
    expect(subjectMatches("orders.>", "orders")).toBe(false);
    expect(subjectMatches("orders", "orders")).toBe(true);
    expect(subjectMatches("a.>.b", "a.x.b")).toBe(false);
    expect(mappingMatches({ kind: "stream", name: "PAYMENTS" }, { kind: "subject", subject: "pay.eu", stream: "PAYMENTS" })).toBe(true);
    expect(mappingMatches({ kind: "stream", name: "PAYMENTS" }, { kind: "subject", subject: "pay.eu" })).toBe(false);
    expect(mappingMatches({ kind: "subject", pattern: "pay.>" }, { kind: "subject", subject: "pay.eu", stream: "PAYMENTS" })).toBe(true);
    const list = [M_SESSIONS, M_ORDERS, M_PAYMENTS];
    expect(firstMapping(list, { kind: "subject", subject: "orders.legacy" }, "value")).toBe(1);
    // "Decode as…" on orders.legacy: the new mapping goes right above orders.> so it wins.
    const kept = mappingFromChoice("m4", { kind: "subject", pattern: "orders.legacy" }, "value", { codec: "protobuf", schema: { local: "s1" }, messageType: "lab.orders.Legacy" });
    expect(kept).toEqual({ id: "m4", target: { kind: "subject", pattern: "orders.legacy" }, part: "value", codec: "protobuf", schemaId: "s1", registry: null, messageType: "lab.orders.Legacy", wireFormat: null });
    expect(insertAbove(list, kept, { kind: "subject", subject: "orders.legacy" }).map((m) => m.id)).toEqual(["m2", "m4", "m1", "m3"]);
    expect(insertAbove(list, kept, { kind: "subject", subject: "other" }).map((m) => m.id)).toEqual(["m2", "m1", "m3", "m4"]);
    expect(newId("m", ["m1", "m2", "m4"])).toBe("m3");
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(targetProblem({ kind: "subject", pattern: "" })).toBe("A subject pattern is required.");
    expect(targetProblem({ kind: "subject", pattern: "a.>.b" })).toBe("> comes last.");
    expect(targetProblem({ kind: "subject", pattern: "a..b" })).not.toBeNull();
    expect(targetProblem({ kind: "kvBucket", bucket: "a.b" })).not.toBeNull();
    expect(targetProblem({ kind: "stream", name: "ORDERS" })).toBeNull();
    expect(importPath("protos/lab/orders/order.proto", "protos")).toBe("lab/orders/order.proto");
    expect(importPath("lab\\a.proto", "/")).toBe("lab/a.proto");
    expect(issueText({ file: "order.proto", line: 9, column: 3, message: "\"Status\" is not defined" })).toBe('order.proto:9:3 · "Status" is not defined');
    expect(issueText({ message: "no file" })).toBe("no file");
  });

  test("codec choices: plain codecs, then each schema and Protobuf type", () => {
    const status: SchemasStatusOutput = { schemas: [{ id: "s1", messageTypes: ["lab.orders.Order", "lab.orders.Refund"] }, { id: "s2", messageTypes: [] }], issues: [], mappings: [] };
    const choices = schemaChoices([ORDERS, AUDIT], status);
    expect(choices.map((c) => c.messageTypes.length)).toEqual([2, 0]);
    const labels = decodeChoices(choices).map((c) => c.label);
    expect(labels).toEqual(["JSON", "CBOR", "MessagePack", "UTF-8 text", "Hex", "Base64", "Protobuf · orders · lab.orders.Order", "Protobuf · orders · lab.orders.Refund", "Avro · audit"]);
    expect(choiceText({ codec: "auto" }, choices)).toBe("Auto (mappings)");
    expect(choiceText({ codec: "cbor" }, choices)).toBe("CBOR");
    expect(choiceText({ codec: "protobuf", schema: { local: "s1" }, messageType: "lab.orders.Refund" }, choices)).toBe("Protobuf · orders · lab.orders.Refund");
  });
});

function tabProps(client: unknown, profile: ProfileRecord, updateProfile: TabProps["updateProfile"], params: Record<string, unknown> = {}): TabProps {
  return {
    tab: { id: "t1", tool: "nats", profileId: "01N", kind: "nats.schemas", params, title: "Schemas", pinned: false },
    profile,
    connId: "conn-1",
    client: client as MightyClient,
    active: true,
    useTabActions: () => {},
    onLive: () => {},
    note: describeError,
    openTab: vi.fn(),
    ...(updateProfile ? { updateProfile } : {}),
  };
}

function stubClient(overrides: { status?: SchemasStatusOutput; test?: MappingTestOutput; inspect?: (input: unknown) => Inspection } = {}) {
  const status: SchemasStatusOutput = overrides.status ?? {
    schemas: [{ id: "s1", messageTypes: ["lab.orders.Order", "lab.orders.Refund"] }],
    issues: [{ schemaId: "s2", file: "audit.avsc", line: 1, column: 2, message: "not a record" }],
    mappings: [
      { id: "m1", count: { decoded: 18204, failed: 0 } },
      { id: "m2", count: { decoded: 312, failed: 2 } },
    ],
  };
  const inspection = (types: string[]): Inspection => ({ type: "protobuf", messageTypes: types, allMessageTypes: types, jsonSchema: {}, example: "{}", text: "", errors: [] });
  return {
    messaging: {
      schemas: {
        status: vi.fn(async () => status),
        update: vi.fn(async () => ({ issues: [] })),
        inspect: vi.fn(async (input: unknown) => overrides.inspect?.(input) ?? inspection(["lab.orders.Order", "lab.orders.Refund"])),
      },
      decode: vi.fn(async () => ({ codec: "protobuf", text: '{"id":"o-1"}', json: { id: "o-1" } })),
      registry: {
        test: vi.fn(async () => ({ url: "http://127.0.0.1:8081", subjects: 3, mode: "READWRITE", compatibility: "BACKWARD" })),
        set: vi.fn(async () => ({})),
        subjects: vi.fn(async () => ["orders-avro-value", "orders-proto-value", "payments-value"]),
        versions: vi.fn(async () => [1, 2]),
      },
    },
    nats: { schemas: { test: vi.fn(async () => overrides.test ?? { source: "stream ORDERS", rows: [], decoded: 0, failed: 0, issues: [] }) } },
  };
}

/** A profile store the tab writes through `updateProfile`. */
function store(initial: ProfileRecord) {
  let current = initial;
  const updateProfile = vi.fn(async (change: (r: ProfileRecord) => ProfileRecord) => {
    current = change(current);
  });
  return { updateProfile, get: () => current };
}

describe("the Schemas tab on a NATS connection", () => {
  test("the tree's Schemas node and the palette open it", () => {
    const tree = natsTool.sidebarTree({ profile: record({ schemas: [ORDERS], mappings: [M_ORDERS] }), connId: "c" });
    const node = tree.find((n) => n.label === "Schemas")!;
    expect(node.open).toEqual({ kind: "nats.schemas", params: {}, title: "Schemas" });
    expect(natsTool.actions!.map((a) => a.id)).toContain("schemas");
  });

  test("schemas with their status, mappings in order with their counts; reorder and delete with undo", async () => {
    const client = stubClient();
    const s = store(record({ schemas: [ORDERS, AUDIT], mappings: [M_ORDERS, M_SESSIONS, M_PAYMENTS] }));
    const notices: { title: string; action?: { onClick(): void } }[] = [];
    const { container } = render(
      <NoticeContext.Provider value={(n) => notices.push(n)}>
        <SchemasTab {...tabProps(client, s.get(), s.updateProfile)} />
      </NoticeContext.Provider>,
    );
    await waitFor(() => byText("compiled") !== null, "the status");
    const schemasTable = container.querySelector<HTMLElement>("table[aria-label=Schemas]")!;
    expect(schemasTable.textContent).toContain("2 files");
    expect(schemasTable.textContent).toContain("lab.orders.Order +1");
    expect(schemasTable.textContent).toContain("1 issue");
    const mappingsTable = container.querySelector<HTMLElement>("table[aria-label=Mappings]")!;
    const rows = () => Array.from(container.querySelectorAll("table[aria-label=Mappings] tbody tr")).map((r) => r.textContent ?? "");
    expect(rows()[0]).toContain("orders.>");
    expect(rows()[0]).toContain("18,204 · 0 failed");
    expect(rows()[1]).toContain("CBOR");
    expect(rows()[1]).toContain("312 · 2 failed");
    expect(rows()[2]).toContain("PAYMENTS");
    expect(rows()[2]).toContain("confluent");
    expect(mappingsTable.textContent).toContain("orders · lab.orders.Order");
    expect(await axeViolations(container)).toEqual([]);

    // Down: saved to the profile and given to the connection's codecs.
    await click(byRole("button", "Move the mapping for orders.> down"));
    await waitFor(() => client.messaging.schemas.update.mock.calls.length === 1, "the update");
    expect(((client.messaging.schemas.update.mock.calls[0] as unknown[])[0] as { mappings: SchemaMapping[] }).mappings.map((m) => m.id)).toEqual(["m2", "m1", "m3"]);
    expect((s.get().extras["mappings"] as SchemaMapping[]).map((m) => m.id)).toEqual(["m2", "m1", "m3"]);

    // A schema in use cannot go; a mapping can, with Undo.
    await click(byRole("button", "Delete orders"));
    expect(notices.at(-1)!.title).toBe("orders is used by 2 mappings");
    await click(byRole("button", "Delete the mapping for sessions"));
    await waitFor(() => notices.at(-1)!.title === "Deleted the mapping for sessions", "the notice");
    expect((s.get().extras["mappings"] as SchemaMapping[]).map((m) => m.id)).not.toContain("m2");
    notices.at(-1)!.action!.onClick();
    await waitFor(() => (s.get().extras["mappings"] as SchemaMapping[]).length === 3, "the undo");
  });

  test("Add mapping: a CBOR mapping for a KV bucket, tested on its last messages, then saved", async () => {
    const result: MappingTestOutput = {
      source: "bucket sessions",
      rows: [
        { subject: "u-2207", sequence: 7, codec: "cbor", text: '{"user":"c-2207"}' },
        { subject: "legacy", sequence: 8, codec: "hex", text: "01 02", error: "not valid CBOR" },
      ],
      decoded: 1,
      failed: 1,
      issues: [],
    };
    const client = stubClient({ test: result });
    const s = store(record({ schemas: [ORDERS], mappings: [] }));
    render(<SchemasTab {...tabProps(client, s.get(), s.updateProfile, { create: "mapping" })} />);
    await waitFor(() => byRole("dialog", /Map messages to a codec/) !== null, "the sheet");
    const sheet = byRole("dialog", /Map messages to a codec/)!;
    // Where: KV bucket; the pattern field follows.
    await click(byRole("combobox", /Where|NATS subject/, sheet));
    await click(byRole("option", "KV bucket"));
    await type(sheet.querySelector<HTMLInputElement>('input[placeholder="sessions"]')!, "sessions");
    await click(byRole("combobox", /Codec|JSON/, sheet));
    await click(byRole("option", "CBOR"));
    await click(byRole("button", "Run the test", sheet));
    await waitFor(() => byText(/1 decoded · 1 failed/, sheet) !== null, "the result");
    const tested = (client.nats.schemas.test.mock.calls[0] as unknown[])[0] as { mapping: SchemaMapping; connId: string };
    expect(tested.connId).toBe("conn-1");
    expect(tested.mapping).toMatchObject({ target: { kind: "kvBucket", bucket: "sessions" }, codec: "cbor", schemaId: null, part: "value" });
    expect(sheet.textContent).toContain("bucket sessions");
    expect(sheet.textContent).toContain("The failures are on legacy");
    await click(byRole("button", "Save mapping", sheet));
    await waitFor(() => client.messaging.schemas.update.mock.calls.length === 1, "saved");
    expect(s.get().extras["mappings"]).toEqual([{ id: "m1", target: { kind: "kvBucket", bucket: "sessions" }, part: "value", codec: "cbor", schemaId: null, registry: null, messageType: null, wireFormat: null }]);
  });

  test("Add a Protobuf schema: compile errors at file and line, then the message types to offer", async () => {
    let attempt = 0;
    const client = stubClient({
      inspect: () => {
        attempt += 1;
        return attempt === 1
          ? { type: "protobuf", messageTypes: [], allMessageTypes: [], jsonSchema: {}, example: "", text: "", errors: [{ file: "order.proto", line: 2, column: 9, message: "'Status' is not defined" }] }
          : { type: "protobuf", messageTypes: ["orders.v1.OrderEvent"], allMessageTypes: ["orders.v1.OrderEvent", "orders.v1.Refund", "orders.v1.LineItem"], jsonSchema: {}, example: "", text: "", errors: [] };
      },
    });
    const s = store(record());
    render(<SchemasTab {...tabProps(client, s.get(), s.updateProfile, { create: "schema" })} />);
    await waitFor(() => byRole("dialog", /Add a Protobuf schema/) !== null, "the sheet");
    const sheet = byRole("dialog", /Add a Protobuf schema/)!;
    await type(sheet.querySelector<HTMLInputElement>('input[placeholder="orders"]')!, "orders");
    await click(byRole("button", /Paste a file/, sheet));
    await click(byRole("button", "Compile", sheet));
    await waitFor(() => byText(/order\.proto:2:9/, sheet) !== null, "the error");
    // Saving refuses while it does not compile.
    await click(byRole("button", "Save schema", sheet));
    await settle();
    expect(s.updateProfile).not.toHaveBeenCalled();
    await click(byRole("button", "Compile", sheet));
    await waitFor(() => byText(/Compiled: 3 message types/, sheet) !== null, "compiled");
    const boxes = Array.from(sheet.querySelectorAll<HTMLElement>("[role=checkbox]"));
    expect(boxes.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false", "false"]);
    await click(boxes[1]!);
    await click(byRole("button", "Save schema", sheet));
    await waitFor(() => s.updateProfile.mock.calls.length === 1, "saved");
    const saved = (s.get().extras["schemas"] as LocalSchema[])[0]!;
    expect(saved).toMatchObject({ id: "s1", name: "orders", type: "protobuf", messageTypes: ["orders.v1.OrderEvent", "orders.v1.Refund"] });
    expect(saved.files).toEqual([{ path: "schema.proto", text: "" }]);
  });
});

function failedMessage(): MessageRow {
  const raw = new Uint8Array([0x0a, 0x05, 0x34, 0x38, 0x32, 0x33, 0x31]);
  return {
    source: "orders.legacy",
    subject: "orders.legacy",
    partition: null,
    offset: null,
    sequence: null,
    timestampUs: "1795060000000000",
    timestampKind: "received",
    keyRaw: null,
    keyText: null,
    keyCodec: null,
    payloadRaw: raw,
    payloadText: "0a0534383233 31",
    payloadCodec: "hex",
    payloadSize: raw.length,
    payloadTruncated: false,
    decodeError: "mapping m1 failed: field 1 has wire type 7",
    schemaRef: "local:s1#lab.orders.Order",
    headers: null,
    replyTo: null,
    operation: null,
  } as MessageRow;
}

describe("Decode as… in the detail pane", () => {
  test("tries a choice on the failed message's bytes, then keeps it as a mapping for its subject", async () => {
    const preview = vi.fn(async () => ({ codec: "protobuf" as const, text: '{"orderId":"48231"}', json: { orderId: "48231" } }));
    const keep = vi.fn(async () => {});
    const decodeAs: DecodeAs = { choices: [{ id: "s1", name: "orders", type: "protobuf", messageTypes: ["lab.orders.Order", "lab.orders.Legacy"] }], placeOf: (m) => subjectPlace(m), preview, keep };
    const { container } = render(<MessageDetail message={failedMessage()} labels={LABELS.nats} decodeAs={decodeAs} />);
    await click(byRole("button", "Decode as…"));
    const panel = container.querySelector<HTMLElement>("[data-slot=decode-as]")!;
    expect(panel.textContent).toContain("subject orders.legacy");
    await click(byRole("combobox", /Choose a codec|Decode as/, panel));
    await click(byRole("option", "Protobuf · orders · lab.orders.Legacy"));
    await waitFor(() => preview.mock.calls.length === 1, "the preview");
    expect(preview.mock.calls[0]).toEqual([failedMessage().payloadRaw, { codec: "protobuf", schema: { local: "s1" }, messageType: "lab.orders.Legacy" }]);
    await waitFor(() => panel.querySelector("[role=tree]") !== null, "the decoded value");
    await click(byRole("button", /Keep as a mapping for subject orders.legacy/, panel));
    await waitFor(() => keep.mock.calls.length === 1, "kept");
    expect((keep.mock.calls[0] as unknown[])[1]).toEqual({ target: { kind: "subject", pattern: "orders.legacy" }, where: { kind: "subject", subject: "orders.legacy", stream: null }, label: "subject orders.legacy" });
    await waitFor(() => byText(/Kept as a mapping/, panel) !== null, "the note");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("not offered on a message that decoded or was cut; a KV entry maps its bucket", () => {
    const ok = { ...failedMessage(), decodeError: null };
    const decodeAs: DecodeAs = { choices: [], placeOf: () => bucketPlace("sessions"), preview: vi.fn(), keep: vi.fn() };
    render(<MessageDetail message={ok} labels={LABELS.kv} decodeAs={decodeAs} />);
    expect(byRole("button", "Decode as…")).toBeNull();
    cleanup();
    render(<MessageDetail message={{ ...failedMessage(), payloadTruncated: true }} labels={LABELS.kv} decodeAs={decodeAs} />);
    expect(byRole("button", "Decode as…")).toBeNull();
    expect(bucketPlace("sessions")).toEqual({ target: { kind: "kvBucket", bucket: "sessions" }, where: { kind: "kvBucket", bucket: "sessions" }, label: "bucket sessions" });
  });
});

describe("a schema registry on a NATS profile (batch 4b)", () => {
  const REGISTRY = { url: "http://127.0.0.1:8081", auth: "basic", username: "mc", tls: {}, wireFormatSubjects: ["orders.wire.>"] };

  test("the model: fields, secrets by auth, the connect input, problems", () => {
    expect(registryOf(record())).toBeNull();
    const r = withRegistry(record(), { url: " http://127.0.0.1:8081 ", auth: "basic", username: "mc", tls: {}, wireFormatSubjects: ["orders.wire.>"] }, { password: "pw" });
    expect(r.secrets["registryPassword"]).toBe("pw");
    expect(registryOf(r)).toEqual({ url: "http://127.0.0.1:8081", auth: "basic", username: "mc", tls: {}, wireFormatSubjects: ["orders.wire.>"] });
    // A later save without the secret keeps it; a change of auth drops it.
    expect(withRegistry(r, registryOf(r), {}).secrets["registryPassword"]).toBe("pw");
    const bearer = withRegistry(r, { ...registryOf(r)!, auth: "bearer" }, { token: "t" });
    expect(bearer.secrets["registryPassword"]).toBeUndefined();
    expect(bearer.secrets["registryToken"]).toBe("t");
    expect(withRegistry(bearer, null).secrets["registryToken"]).toBeUndefined();
    // The registry the server builds from the stored profile: server/src/profiles/connect.rs.
    expect(splitPatterns(" orders.>, payments.>\naudit ")).toEqual(["orders.>", "payments.>", "audit"]);
    expect(Object.keys(registryProblems({ url: "https://r:8081", auth: "bearer", tls: {}, wireFormatSubjects: ["a..b"] }, false)).sort()).toEqual(["caPem", "secret", "wireFormatSubjects"]);
    expect(registryProblems({ url: "r:8081", auth: "none", tls: {} }, false)["url"]).toMatch(/http:\/\//);
    expect(mappingSchemaText({ id: "m", target: { kind: "subject", pattern: "x" }, part: "value", codec: "avro", registry: { subject: "orders-avro-value", version: 2 } }, [])).toBe("orders-avro-value · v2");
    expect(mappingSchemaText({ id: "m", target: { kind: "subject", pattern: "x" }, part: "value", codec: "protobuf", wireFormat: "confluent" }, [])).toBe("registry id in each message");
  });

  test("Add registry…: tested before saving, saved with its secret, given to the connection", async () => {
    const client = stubClient();
    const s = store(record({ schemas: [], mappings: [] }));
    const { container } = render(<SchemasTab {...tabProps(client, s.get(), s.updateProfile)} />);
    expect(container.textContent).toContain("no registry");
    await click(byRole("button", "Add registry…"));
    const sheet = byRole("dialog", /Add a schema registry/)!;
    expect(sheet.textContent).toContain("For NATS messages");
    await type(sheet.querySelector<HTMLInputElement>('input[placeholder="https://registry.internal:8081"]')!, "http://127.0.0.1:8081");
    await click(byRole("combobox", /Authentication|None/, sheet));
    await click(byRole("option", "Basic: user and password"));
    // Test before the user and password are in: the problems show, nothing is called.
    await click(byRole("button", "Test", sheet));
    expect(sheet.textContent).toContain("A user name is required.");
    expect(client.messaging.registry.test).not.toHaveBeenCalled();
    const inputs = () => Array.from(sheet.querySelectorAll<HTMLInputElement>("input"));
    await type(inputs().find((i) => i.closest("[data-slot=field]")?.textContent?.startsWith("User"))!, "mc");
    await type(sheet.querySelector<HTMLInputElement>('input[placeholder="Not set"]')!, "pw-1");
    await type(sheet.querySelector<HTMLInputElement>('input[placeholder="orders.>, payments.>"]')!, "orders.wire.>, audit.>");
    await click(byRole("button", "Test", sheet));
    await waitFor(() => byText(/Registry answered/, sheet) !== null, "the answer");
    expect(sheet.textContent).toContain("3 subjects · mode READWRITE · compatibility BACKWARD");
    // The profile form's draft with this registry; the typed password under its server name.
    const tested = (client.messaging.registry.test.mock.calls[0] as unknown[])[0] as { tool: string; draft: { fields: Record<string, unknown>; secrets: Record<string, string> }; basedOn: string };
    expect(tested.tool).toBe("nats");
    expect(tested.draft.fields["schemaRegistry"]).toMatchObject({ url: "http://127.0.0.1:8081", auth: "basic", username: "mc", wireFormatSubjects: ["orders.wire.>", "audit.>"] });
    expect(tested.draft.secrets).toEqual({ "schemaRegistry.password": "pw-1" });
    expect(tested.basedOn).toBe(s.get().id);
    expect(await axeViolations(sheet)).toEqual([]);
    await click(byRole("button", "Save registry", sheet));
    await waitFor(() => client.messaging.registry.set.mock.calls.length === 1, "given to the connection");
    expect(s.get().fields["schemaRegistry"]).toEqual({ url: "http://127.0.0.1:8081", auth: "basic", username: "mc", tls: {}, wireFormatSubjects: ["orders.wire.>", "audit.>"] });
    expect(s.get().secrets["registryPassword"]).toBe("pw-1");
    // The connection gets the registry the server rebuilds from the saved profile: no secret here.
    expect((client.messaging.registry.set.mock.calls[0] as unknown[])[0]).toEqual({ connId: "conn-1" });
  });

  test("a mapping to a registry subject and version; the registry cannot go while a mapping uses it", async () => {
    const client = stubClient();
    const s = store(withRegistry(record({ schemas: [], mappings: [] }), { ...REGISTRY, auth: "none" } as never));
    const notices: { title: string }[] = [];
    const { container } = render(
      <NoticeContext.Provider value={(n) => notices.push(n)}>
        <SchemasTab {...tabProps(client, s.get(), s.updateProfile, { create: "mapping" })} />
      </NoticeContext.Provider>,
    );
    expect(container.textContent).toContain("registry 127.0.0.1:8081");
    const sheet = byRole("dialog", /Map messages to a codec/)!;
    await type(sheet.querySelector<HTMLInputElement>('input[placeholder="orders.>"]')!, "orders.avro.>");
    await click(byRole("combobox", /Codec|JSON/, sheet));
    await click(byRole("option", "Avro"));
    // No local Avro schema: the registry's subjects are offered.
    await waitFor(() => client.messaging.registry.subjects.mock.calls.length === 1, "the subjects");
    const subject = sheet.querySelector<HTMLInputElement>('input[placeholder="orders-value"]')!;
    await type(subject, "orders-avro-value");
    await waitFor(() => client.messaging.registry.versions.mock.calls.length > 0, "the versions");
    await click(byRole("combobox", /Version|Latest/, sheet));
    await click(byRole("option", "Version 1"));
    await click(byRole("button", "Run the test", sheet));
    await waitFor(() => client.nats.schemas.test.mock.calls.length === 1, "the test");
    const tested = ((client.nats.schemas.test.mock.calls[0] as unknown[])[0] as { mapping: SchemaMapping }).mapping;
    expect(tested).toMatchObject({ codec: "avro", schemaId: null, registry: { subject: "orders-avro-value", version: 1 }, wireFormat: null });
    await click(byRole("button", "Save mapping", sheet));
    await waitFor(() => (s.get().extras["mappings"] as SchemaMapping[]).length === 1, "saved");
    cleanup();

    // The id in each message: the wire format follows.
    render(<SchemasTab {...tabProps(client, s.get(), s.updateProfile, { create: "mapping" })} />);
    const again = byRole("dialog", /Map messages to a codec/)!;
    await type(again.querySelector<HTMLInputElement>('input[placeholder="orders.>"]')!, "orders.wire.>");
    await click(byRole("combobox", /Codec|JSON/, again));
    await click(byRole("option", "Protobuf"));
    await click(byRole("radio", "The id in each message", again) ?? byRole("button", "The id in each message", again));
    await click(byRole("button", "Save mapping", again));
    await waitFor(() => (s.get().extras["mappings"] as SchemaMapping[]).length === 2, "saved");
    expect((s.get().extras["mappings"] as SchemaMapping[])[1]).toMatchObject({ codec: "protobuf", schemaId: null, registry: null, wireFormat: "confluent" });
    cleanup();

    // Removing the registry is refused while mappings use it.
    render(
      <NoticeContext.Provider value={(n) => notices.push(n)}>
        <SchemasTab {...tabProps(client, s.get(), s.updateProfile, { create: "registry" })} />
      </NoticeContext.Provider>,
    );
    const reg = byRole("dialog", /The schema registry/)!;
    await click(byRole("button", "Remove registry", reg));
    await waitFor(() => byText(/used by 2 mappings/, reg) !== null, "the refusal");
    expect(registryOf(s.get())).not.toBeNull();
  });
});
