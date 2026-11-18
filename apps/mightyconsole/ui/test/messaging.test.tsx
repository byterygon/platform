// The messaging core in the UI (Mightyconsole spec §5.5 to §5.7, TSK-80 acceptance "components",
// "arrow", "live-tail"): MessageViewer on real §5.1 Arrow batches (decoded in-thread as the Worker
// does), its detail pane, the window, Pause holding the pull, Clear, export; the FilterBar's server
// check; the Composer's Validate and Send; and the echo tabs on the test backend through the shell.
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProgressBus } from "@/app/progress";
import type { FilterCheckOutput, LastPosition, TailSummary } from "@/gen/api";
import { Composer, type ComposerDraft, EMPTY_DRAFT } from "@/messaging/Composer";
import { EMPTY_DRAFT as EMPTY_FILTER, FilterBar, toFilter } from "@/messaging/FilterBar";
import { MessageViewer } from "@/messaging/MessageViewer";
import { exportObject, toJsonLines } from "@/messaging/export";
import { parseSchemaRef } from "@/messaging/schema-ref";
import { useLiveTail } from "@/messaging/useLiveTail";
import { messageCall, messageTable, type TestMessage } from "./support/messages";
import { fake as monaco } from "../../../../packages/ui/test/fakes/monaco.ts";
import { act, axeViolations, byRole, byText, cleanup, click, editorArea, key, render, settle, type, waitFor } from "./support/render";

afterEach(cleanup);

const summary = (patch: Partial<TailSummary> = {}): TailSummary => ({ scanned: 0, matched: 0, dropped: 0, decodeErrors: 0, endReason: "end", lastPositions: [], ...patch });
const services = { decoder: inThreadArrowDecoder(), progress: new ProgressBus() };
const note = (e: unknown) => {
  const code = (e as { code?: string }).code;
  return { title: e instanceof Error ? e.message : String(e), ...(code ? { code } : {}) };
};

function Viewer({ open, maxMessages, onPositions }: { open: (id: string, resume: readonly LastPosition[] | null) => ReturnType<typeof messageCall>["call"]; maxMessages?: number; onPositions?: (p: LastPosition[]) => void }) {
  const tail = useLiveTail(services, open as never, note);
  return (
    <MessageViewer
      system="kafka"
      tail={tail}
      {...(maxMessages ? { maxMessages } : {})}
      onLoadFull={async () => new TextEncoder().encode("the whole payload")}
      loadSchema={async (ref) => `schema of ${JSON.stringify(ref.schema)}`}
      {...(onPositions ? { onPositions } : {})}
    />
  );
}

const orders: TestMessage[] = [
  { partition: 0, offset: 0n, key: "k-0", value: '{"id":"o-0","total":12}', headers: [["trace", "abc", "text"]], schemaRef: "local:orders#lab.orders.Order", codec: "protobuf" },
  { partition: 1, offset: 0n, key: "k-1", value: "plain text", codec: "utf8" },
  { partition: 1, offset: 1n, value: "\u0000\u0001", codec: "hex", decodeError: "not valid UTF-8 at byte 0" },
  { partition: 2, offset: 0n, value: "x".repeat(32), size: 2_000_000, truncated: true, codec: "utf8", decodeError: "the payload is 2000000 bytes; the first 32 are shown (Load full payload)" },
];

const gridRows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>(".bdg-body > [role=row]:not([hidden])")];
const start = () => click(byRole("button", /^(Start|Restart)$/));

describe("MessageViewer (spec §5.6)", () => {
  test("rows from the Arrow batches in the system's columns; the detail pane reads the rest", async () => {
    const built = messageCall(messageTable(orders), summary({ scanned: 4, matched: 4, lastPositions: [{ source: "echo", partition: 1, offset: "1", timestampUs: 0 }] }));
    const { container } = render(<Viewer open={() => built.call} />);
    await start();
    await waitFor(() => byText(/Ended \(end of data\)/) !== null, "the end");
    expect(byText("4 records shown")).not.toBeNull();
    const headers = [...container.querySelectorAll("[role=columnheader] .bdg-name")].map((h) => h.textContent);
    expect(headers).toEqual(["partition", "offset", "timestamp", "keyText", "payloadText"]);
    // Select the first row (the grid's cell) and read the detail pane.
    const firstCell = gridRows(container)[0]!.querySelector<HTMLElement>("[role=gridcell]")!;
    await click(firstCell);
    await waitFor(() => container.querySelector("[data-slot=message-detail]") !== null, "the detail pane");
    const detail = container.querySelector<HTMLElement>("[data-slot=message-detail]")!;
    expect(detail.textContent).toContain("local:orders#lab.orders.Order");
    expect(detail.querySelector("[role=tree]")).not.toBeNull(); // JSON value in the JsonViewer
    await click(byRole("tab", "Headers", detail));
    expect(detail.textContent).toContain("trace");
    await click(byRole("tab", "Metadata", detail));
    expect(detail.textContent).toContain("2026-11-18T00:00:00.000000Z (create)");
    await click(byRole("tab", "Schema", detail));
    await click(byRole("button", "Show the schema", detail));
    await waitFor(() => detail.textContent!.includes('schema of {"local":"orders"}'), "the schema text");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a cut payload offers Load full payload; binary values show as hex", async () => {
    const built = messageCall(messageTable(orders), summary());
    const { container } = render(<Viewer open={() => built.call} />);
    await start();
    await waitFor(() => gridRows(container).length === 4, "the rows");
    await click(gridRows(container)[3]!.querySelector("[role=gridcell]"));
    const detail = () => container.querySelector<HTMLElement>("[data-slot=message-detail]")!;
    await waitFor(() => detail() !== null, "the detail");
    expect(detail().textContent).toContain("Payload cut");
    await click(byRole("button", /Load full payload/, detail()));
    // The Text view is a read-only CodeEditor (TSK-93): the text is in its text area.
    await waitFor(() => editorArea("Value")?.value.includes("the whole payload") === true, "the full payload");
    expect(detail().querySelector('[data-slot="code-editor"][data-readonly]')).not.toBeNull();
    await click(gridRows(container)[2]!.querySelector("[role=gridcell]"));
    await waitFor(() => detail().querySelector("[data-slot=hex-view]") !== null, "the hex view");
    expect(detail().textContent).toContain("Not decoded as chosen");
  });

  test("the window keeps the newest messages and says so; Clear empties the view", async () => {
    const many = Array.from({ length: 600 }, (_, i): TestMessage => ({ partition: 0, offset: BigInt(i), value: `{"n":${i}}` }));
    const built = messageCall(messageTable(many, 100), summary());
    const { container } = render(<Viewer open={() => built.call} maxMessages={250} />);
    await start();
    await waitFor(() => byText(/Ended/) !== null, "the end");
    expect(byText("200 records shown")).not.toBeNull();
    expect(byText("Showing the latest 200")).not.toBeNull();
    // The grid follows the newest rows; whichever row is clicked, the detail pane reads the batch
    // that stayed: row n (1-based, renumbered after the drop) is message 400 + n - 1.
    const row = gridRows(container)[0]!;
    const n = Number(row.querySelector("[role=rowheader]")!.textContent);
    await click(row.querySelector("[role=gridcell]"));
    await waitFor(() => container.querySelector("[data-slot=message-detail]") !== null, "the detail");
    await click(byRole("tab", "Metadata"));
    const meta = container.querySelector("[data-slot=message-detail]")!.textContent!;
    expect(meta, meta).toContain(`Offset${400 + n - 1}`);
    await click(byRole("button", "Clear"));
    await waitFor(() => byText("0 records shown") !== null, "the cleared view");
  });

  test("Pause stops pulling chunks (no credit reaches the server) and Resume goes on", async () => {
    const many = Array.from({ length: 2000 }, (_, i): TestMessage => ({ partition: 0, offset: BigInt(i), value: `{"n":${i}}` }));
    const built = messageCall(messageTable(many, 100), summary(), { endless: true, delayMs: 20 });
    render(<Viewer open={() => built.call} />);
    await start();
    await waitFor(() => built.state.pulled > 2, "the first chunks");
    await click(byRole("button", "Pause"));
    // A pull already in flight may still land; after that, nothing is pulled.
    const wait = (ms: number) => act(async () => new Promise<void>((r) => setTimeout(r, ms)));
    await wait(100);
    const atPause = built.state.pulled;
    await wait(200);
    expect(built.state.pulled).toBe(atPause);
    expect(atPause).toBeLessThan(built.chunks);
    await click(byRole("button", "Resume"));
    await waitFor(() => built.state.pulled === built.chunks, "every chunk after Resume");
    await click(byRole("button", "Stop"));
    await waitFor(() => byRole("button", "Restart") !== null, "Restart");
  });

  test("Restart after Stop continues from the last positions the view saw", async () => {
    const calls: (readonly LastPosition[] | null)[] = [];
    const many = Array.from({ length: 300 }, (_, i): TestMessage => ({ partition: i % 3, offset: BigInt(Math.floor(i / 3)), value: "{}" }));
    const open = (_id: string, resume: readonly LastPosition[] | null) => {
      calls.push(resume);
      return messageCall(messageTable(many, 100), summary(), { endless: true }).call;
    };
    render(<Viewer open={open} />);
    await start();
    await waitFor(() => byText("300 records shown") !== null, "the rows");
    await click(byRole("button", "Stop"));
    await waitFor(() => byRole("button", "Restart") !== null, "Restart");
    await start();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBeNull();
    const resume = [...(calls[1] ?? [])].sort((a, b) => (a.partition ?? 0) - (b.partition ?? 0));
    expect(resume.map((p) => [p.partition, p.offset])).toEqual([[0, "99"], [1, "99"], [2, "99"]]);
  });

  test("export: JSON Lines of the loaded messages, JSON values parsed, binary as base64", () => {
    const m = {
      rowId: "0", source: "echo", subject: null, partition: 1, offset: "7", sequence: null, timestampUs: "1794960000000000", timestampKind: "create", operation: null, replyTo: null,
      headers: [["a", "1", "text"], ["b", "/w==", "base64"]] as [string, string, "text" | "base64"][],
      keyRaw: new Uint8Array([0xff]), keyText: null, keyCodec: "hex", payloadRaw: new TextEncoder().encode('{"x":1}'), payloadSize: 7, payloadTruncated: false, payloadText: '{"x":1}', payloadCodec: "json", schemaRef: null, decodeError: null,
    };
    expect(exportObject(m)).toEqual({
      source: "echo", subject: null, partition: 1, offset: "7", sequence: null, timestamp: "2026-11-18T00:00:00.000000Z",
      headers: [{ name: "a", value: "1" }, { name: "b", base64: "/w==" }], key: { base64: "/w==" }, value: { x: 1 }, keyCodec: "hex", valueCodec: "json",
    });
    expect(toJsonLines([m, m]).split("\n")).toHaveLength(3);
  });

  test("schema references", () => {
    expect(parseSchemaRef("registry:7")).toEqual({ schema: { registry: { id: 7 } }, messageType: null });
    expect(parseSchemaRef("registry:orders-value/3")).toEqual({ schema: { registry: { subject: "orders-value", version: 3 } }, messageType: null });
    expect(parseSchemaRef("local:s1#lab.Order")).toEqual({ schema: { local: "s1" }, messageType: "lab.Order" });
    expect(parseSchemaRef(null)).toBeNull();
  });
});

describe("FilterBar (spec §5.4)", () => {
  test("quick fields build the filter; the server's check marks the field; Enter applies", async () => {
    const check = vi.fn(async (f: Record<string, unknown>): Promise<FilterCheckOutput> => (f["jq"] === ".a ==" ? { ok: false, errors: [{ part: "jq", message: "expected term", line: 1, column: 5 }] } : { ok: true, errors: [] }));
    const onApply = vi.fn();
    const { container } = render(<FilterBar system="kafka" applied={{}} onApply={onApply} check={check as never} debounceMs={0} />);
    const input = (label: string) => [...container.querySelectorAll<HTMLInputElement>("input")].find((i) => i.labels?.[0]?.textContent === label)!;
    await type(input("Key contains"), "order");
    await type(input("Header"), "tag=eu");
    const jq = () => editorArea("jq")!;
    await type(jq(), ".a ==");
    await waitFor(() => byText(/expected term \(line 1, column 5\)/) !== null, "the jq error");
    expect(byRole("button", "Apply")!.hasAttribute("disabled") || byRole("button", "Apply")!.getAttribute("aria-disabled") === "true").toBe(true);
    await waitFor(() => (monaco.markers as unknown[]).length === 1, "the jq marker");
    expect(monaco.markers).toEqual([{ startLineNumber: 1, startColumn: 5, endLineNumber: 1, endColumn: 6, message: "expected term", severity: 8 }]);
    await type(jq(), ".value.total > 10");
    await waitFor(() => byText(/expected term/) === null, "the error cleared");
    await key("Enter", {}, jq());
    expect(onApply).toHaveBeenLastCalledWith({ key: { op: "contains", value: "order", caseSensitive: false }, headers: [{ name: "tag", match: { op: "equals", value: "eu" } }], jq: ".value.total > 10" });
    expect(await axeViolations(container)).toEqual([]);
  });

  test("subjects for NATS views; ranges", () => {
    expect(toFilter({ ...EMPTY_FILTER, subject: "orders.>", from: "2026-11-18T00:00:00Z", positionTo: "40" })).toEqual({ subject: "orders.>", time: { from: "2026-11-18T00:00:00Z", to: null }, position: { from: null, to: "40" } });
    expect(toFilter(EMPTY_FILTER)).toEqual({});
  });
});

describe("Composer (spec §5.7)", () => {
  function Harness(props: { encode: never; onSend: never; inspect?: never }) {
    const [draft, setDraft] = useState<ComposerDraft>({ ...EMPTY_DRAFT, value: { codec: "json", text: '{"id":"o-1"}' } });
    return (
      <Composer
        target={<span>echo</span>}
        withKey
        schemas={[{ id: "orders", name: "orders.proto", type: "protobuf" }]}
        draft={draft}
        onDraftChange={setDraft}
        encode={props.encode}
        inspect={props.inspect ?? ((async () => ({ type: "protobuf", messageTypes: ["lab.Order"], jsonSchema: {}, example: '{\n  "id": ""\n}', text: "", errors: [] })) as never)}
        onSend={props.onSend}
        describe={(e) => ({ title: String((e as Error).message), field: "value", line: 1, column: 7 })}
      />
    );
  }

  test("Validate shows the size and the first bytes; Send reports the result; errors mark the payload", async () => {
    const encode = vi.fn(async () => ({ bytes: btoa('{"id":"o-1"}'), size: 12 }));
    const onSend = vi.fn(async (d: ComposerDraft) => `sent ${d.value.text}`);
    const { container } = render(<Harness encode={encode as never} onSend={onSend as never} />);
    await settle();
    await click(byRole("button", "Validate"));
    await waitFor(() => byText(/Valid: 12 bytes/) !== null, "the validation");
    expect(container.querySelector("[data-slot=composer-validated] [data-slot=hex-view]")).not.toBeNull();
    await click(byRole("button", /Send/));
    await waitFor(() => byText('sent {"id":"o-1"}') !== null, "the result");
    expect(onSend.mock.calls[0]![0].value).toEqual({ codec: "json", text: '{"id":"o-1"}' });
    encode.mockRejectedValueOnce(new Error("not valid JSON"));
    await click(byRole("button", "Validate"));
    await waitFor(() => byText("not valid JSON") !== null, "the error");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Mod+Enter in the payload sends", async () => {
    const onSend = vi.fn(async () => "ok");
    const { container } = render(<Harness encode={(async () => ({ bytes: "", size: 0 })) as never} onSend={onSend as never} />);
    await settle();
    const editor = container.querySelector<HTMLTextAreaElement>("[data-slot=code-editor] textarea")!;
    await key("Enter", { ctrlKey: true }, editor);
    await waitFor(() => onSend.mock.calls.length === 1, "the send");
  });
});
