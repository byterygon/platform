// Key-Value in the NATS tool (Mightyconsole spec §6.3 to §6.5, TSK-85 batch 3a): the bucket list and
// New bucket, the keys with a filter and Show deleted, a key's entry and history with two revisions
// compared and "Put revision n back" (sent with the latest revision expected; a Conflict is shown),
// delete, purge and delete bucket confirmations, Put key through the Composer without headers, the
// line diff, and the tree's Key-Value group, against stub clients.
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { RpcError } from "@byterygon/ambidex";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ServicesContext, type MightyClient } from "@/app/client";
import { describeError } from "@/app/messages";
import { ProgressBus } from "@/app/progress";
import { loadPersisted, StoreProvider } from "@/app/store";
import type { MessageRecord, NatsKvBucketInfo, NatsKvKeysOutput } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { MemoryStorage } from "@/profiles/storage";
import { natsTool } from "@/tools/nats";
import { bucketConfigOf, bucketErrors, EMPTY_BUCKET, KvBucketsTab } from "@/tools/nats/KvBuckets";
import { validateKey } from "@/tools/nats/KvPutSheet";
import { KvTab, valueText } from "@/tools/nats/KvTab";
import { diffLines } from "@/tools/nats/diff";
import { profile as schema } from "@/tools/nats/profile";
import { natsTreeData, resetTreeData } from "@/tools/nats/tree-data";
import type { TabProps } from "@/tools/types";
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

const CONFIG: NatsKvBucketInfo = { bucket: "config", values: 7, bytes: 546, history: 5, storage: "file", replicas: 1, compression: false, createdUs: Date.now() * 1000 };

const KEYS: NatsKvKeysOutput = {
  keys: [
    { key: "feature.checkout", revision: 42, operation: "put", createdUs: Date.now() * 1000, size: 30, preview: '{"enabled": true, "rollout": 25}' },
    { key: "maintenance.window", revision: 4, operation: "delete", createdUs: Date.now() * 1000, size: 0 },
  ],
  truncated: false,
};

const entry = (rev: number, value: string, operation = "put"): MessageRecord => ({ source: "config", subject: "feature.checkout", sequence: String(rev), timestampUs: Date.now() * 1000, timestampKind: "stored", operation, payloadRaw: btoa(value), payloadSize: value.length, payloadTruncated: false, payloadText: value, payloadCodec: "json" });

const HISTORY = [entry(31, '{"enabled": false}'), entry(38, '{"enabled": true, "rollout": 10}'), entry(42, '{"enabled": true, "rollout": 25}')];

describe("the KV models", () => {
  test("bucket form, keys, values and the line diff", () => {
    expect(bucketErrors(EMPTY_BUCKET)).toHaveProperty("bucket");
    expect(Object.keys(bucketErrors({ ...EMPTY_BUCKET, bucket: "con.fig", history: "65", ttl: "soon" })).sort()).toEqual(["bucket", "history", "ttl"]);
    expect(bucketConfigOf({ ...EMPTY_BUCKET, bucket: "config", history: "5", ttl: "1h", maxValueSize: "1 MiB" })).toEqual({ bucket: "config", description: null, history: 5, ttlMs: 3_600_000, maxValueSize: 1_048_576, maxBytes: null, storage: "file", replicas: 1, compression: false });
    expect(validateKey("feature.checkout")).toBeNull();
    expect(validateKey(".x")).not.toBeNull();
    expect(validateKey("a b")).not.toBeNull();
    expect(valueText(entry(1, '{"a":1}'))).toBe('{\n  "a": 1\n}');
    expect(valueText({ ...entry(1, ""), operation: "delete" })).toBe("(deleted)");
    expect(diffLines('{"enabled": true, "rollout": 10}', '{"enabled": true, "rollout": 25}')).toEqual([
      { kind: "same", text: "{" },
      { kind: "same", text: '  "enabled": true,' },
      { kind: "removed", text: '  "rollout": 10' },
      { kind: "added", text: '  "rollout": 25' },
      { kind: "same", text: "}" },
    ]);
  });
});

describe("Key-Value buckets (spec §6.5 nats.kv.buckets)", () => {
  test("the list opens a bucket; New bucket creates one", async () => {
    const create = vi.fn(async () => ({ ...CONFIG, bucket: "sessions" }));
    const p = props({ nats: { kv: { buckets: { list: vi.fn(async () => [CONFIG]), create } }, js: { streams: { list: vi.fn(async () => []) } } } }, "nats.kvs");
    const { container } = render(<KvBucketsTab {...p} />);
    await waitFor(() => byRole("button", "config") !== null, "the list");
    await click(byRole("button", "config"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "nats.kv", params: { bucket: "config" }, title: "config" });
    expect(await axeViolations(container)).toEqual([]);
    await click(byRole("button", "New bucket"));
    await waitFor(() => document.querySelector("form[aria-label='New KV bucket']") !== null, "the sheet");
    await type(byRole("textbox", /^Bucket\*?$/) as HTMLInputElement, "sessions");
    await type(byRole("textbox", "History") as HTMLInputElement, "10");
    await click(byRole("button", "Create bucket"));
    await waitFor(() => create.mock.calls.length === 1, "the create");
    expect(create).toHaveBeenCalledWith({ connId: "conn-1", config: expect.objectContaining({ bucket: "sessions", history: 10, storage: "file" }) });
  });
});

describe("Key-Value bucket (spec §6.3)", () => {
  const client = (over: Record<string, unknown> = {}) => {
    const kv = {
      buckets: { info: vi.fn(async () => CONFIG), delete: vi.fn(async () => ({})) },
      keys: vi.fn(async () => KEYS),
      history: vi.fn(async () => HISTORY),
      put: vi.fn(async () => ({ revision: 43, bytes: 30 })),
      delete: vi.fn(async () => ({})),
      purge: vi.fn(async () => ({})),
      watch: vi.fn(),
      ...over,
    };
    return { nats: { kv, js: { streams: { list: vi.fn(async () => []) } } }, messaging: { filter: { check: vi.fn(async () => ({ ok: true, errors: [] })) }, encode: vi.fn(async () => ({ bytes: "", size: 0 })), schemas: { inspect: vi.fn() } } };
  };

  test("keys with a filter and Show deleted; the entry of the selected key", async () => {
    const c = client();
    const { container } = await mountWithStore(<KvTab {...props(c, "nats.kv", { bucket: "config" })} />);
    await waitFor(() => byRole("button", "feature.checkout") !== null, "the keys");
    expect(byText(/history 5 · no TTL · file, 1 replica/)).not.toBeNull();
    expect(c.nats.kv.keys).toHaveBeenCalledWith({ connId: "conn-1", bucket: "config", filter: null, includeDeleted: false });
    const deleted = byRole("button", "maintenance.window")!;
    expect(deleted.className).toContain("line-through");
    await waitFor(() => byRole("region", "Value") !== null || document.querySelector("[aria-label='Value']") !== null, "the entry");
    expect(byText(/revision 42 · put/)).not.toBeNull();
    await type(document.querySelector("input[aria-label='Filter keys']") as HTMLInputElement, "feature.>");
    await click(byRole("switch"));
    const calls = () => c.nats.kv.keys.mock.calls as unknown as [{ filter: string | null; includeDeleted: boolean }][];
    await waitFor(() => calls().some(([input]) => input.filter === "feature.>" && input.includeDeleted), "the filtered keys");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("History: compare a revision with the latest; Put revision n back expects the latest revision; a Conflict shows", async () => {
    let conflict = true;
    const put = vi.fn(async () => {
      if (conflict) throw new RpcError("FailedPrecondition", "feature.checkout is no longer at revision 42: someone changed it; nothing was written", { details: { kind: "Conflict", system: "nats", message: "no longer at revision 42", field: "expectRevision", retryable: false } });
      return { revision: 43, bytes: 30 };
    });
    const c = client({ put });
    await mountWithStore(<KvTab {...props(c, "nats.kv", { bucket: "config" })} />);
    await waitFor(() => byRole("tab", /History/) !== null, "the key pane");
    await click(byRole("tab", /History/));
    await waitFor(() => byText("38 → 42") !== null, "the comparison");
    const diff = document.querySelector("[data-slot=diff]")!;
    expect([...diff.querySelectorAll("[data-kind=removed]")].map((l) => l.textContent)).toEqual(['-   "rollout": 10']);
    expect([...diff.querySelectorAll("[data-kind=added]")].map((l) => l.textContent)).toEqual(['+   "rollout": 25']);
    await click(byRole("button", "Compare revision 31 with the latest"));
    await waitFor(() => byText("31 → 42") !== null, "another base");
    await click(byRole("button", "Put revision 31 back…"));
    await waitFor(() => byText("Put revision 31 of feature.checkout back?") !== null, "the confirmation");
    await click(byRole("button", "Put revision 31 back"));
    await waitFor(() => byText(/no longer at revision 42/) !== null, "the conflict");
    expect(put).toHaveBeenCalledWith({ connId: "conn-1", bucket: "config", key: "feature.checkout", payload: { codec: "base64", text: btoa('{"enabled": false}') }, expectRevision: 42 });
    conflict = false;
    await click(byRole("button", "Put revision 31 back"));
    await waitFor(() => put.mock.calls.length === 2 && byText("Put revision 31 of feature.checkout back?") === null, "the put");
  });

  test("Delete and Purge a key, Delete the bucket with its name typed", async () => {
    const c = client();
    const p = props(c, "nats.kv", { bucket: "config" });
    await mountWithStore(<KvTab {...p} />);
    await waitFor(() => byRole("button", "Delete key…") !== null, "the key pane");
    await click(byRole("button", "Delete key…"));
    await waitFor(() => byText("Delete feature.checkout from config on edge-nats?") !== null, "the delete");
    await click(byRole("button", "Delete key"));
    await waitFor(() => c.nats.kv.delete.mock.calls.length === 1, "deleted");
    await click(byRole("button", "Purge key…"));
    await waitFor(() => byText("Purge feature.checkout from config on edge-nats?") !== null, "the purge");
    await click(byRole("button", "Purge key"));
    await waitFor(() => c.nats.kv.purge.mock.calls.length === 1, "purged");
    await click(byRole("button", "More: Delete bucket"));
    await click(byRole("menuitem", /Delete bucket/));
    await waitFor(() => byText("Delete bucket config on edge-nats?") !== null, "the bucket delete");
    const del = () => byRole("button", "Delete bucket") as HTMLButtonElement;
    expect(del().disabled).toBe(true);
    await type(byRole("textbox", "Type config to confirm") as HTMLInputElement, "config");
    await click(del());
    await waitFor(() => c.nats.kv.buckets.delete.mock.calls.length === 1, "the bucket deleted");
    expect(p.openTab).toHaveBeenCalledWith({ kind: "nats.kvs", params: {}, title: "Key-Value" });
  });

  test("Put key: the Composer without headers, with the expected revision", async () => {
    const c = client();
    await mountWithStore(<KvTab {...props(c, "nats.kv", { bucket: "config" })} />);
    await waitFor(() => byRole("button", "Put a new value…") !== null, "the key pane");
    await click(byRole("button", "Put a new value…"));
    await waitFor(() => byText("Put a key in config") !== null, "the sheet");
    expect((byRole("textbox", "Key") as HTMLInputElement).value).toBe("feature.checkout");
    expect((byRole("textbox", "Only if at revision") as HTMLInputElement).value).toBe("42");
    expect(byText("Headers")).toBeNull();
    await click(byRole("button", "Send"));
    await waitFor(() => c.nats.kv.put.mock.calls.length === 1, "the put");
    expect(c.nats.kv.put).toHaveBeenCalledWith(expect.objectContaining({ connId: "conn-1", bucket: "config", key: "feature.checkout", expectRevision: 42 }));
  });
});

describe("the tree's Key-Value group (spec §6.2)", () => {
  test("buckets come from the KV_ streams", async () => {
    const client = { nats: { js: { streams: { list: vi.fn(async () => [{ name: "KV_config", subjects: ["$KV.config.>"], messages: 7, bytes: 1, consumers: 0, createdUs: 0, storage: "file", retention: "limits", sealed: false }]) }, consumers: { list: vi.fn(async () => []) } } } };
    natsTreeData.load({ profile: record(), connId: "c-kv", client: client as never });
    await waitFor(() => (natsTool.sidebarTree({ profile: record(), connId: "c-kv" })[3]!.children ?? []).length === 1, "the bucket");
    const kv = natsTool.sidebarTree({ profile: record(), connId: "c-kv" })[3]!;
    expect(kv.label).toBe("Key-Value");
    expect(kv.open).toEqual({ kind: "nats.kvs", params: {}, title: "Key-Value" });
    expect(kv.children![0]!.open).toEqual({ kind: "nats.kv", params: { bucket: "config" }, title: "config" });
    expect(natsTool.sidebarTree({ profile: record(), connId: "c-kv" })[2]!.children).toEqual([]);
  });
});
