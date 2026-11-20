// Object Store and Services in the NATS tool (Mightyconsole spec §6.3 to §6.5, TSK-85 batch 3b): the
// object store list and New object store, a bucket's objects with the selected one's info,
// download and delete, an upload in parts through the Sheet (progress, cancel, abort on failure),
// delete bucket with its name typed, the Services screen with STATS and PING, and the tree's Object
// Store and Services nodes, against stub clients.
import { RpcError } from "@byterygon/ambidex";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MightyClient } from "@/app/client";
import { describeError } from "@/app/messages";
import type { NatsObjBucketInfo, NatsObjectInfo, NatsServiceInfo, NatsServicePing, NatsServiceStats } from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import { natsTool } from "@/tools/nats";
import { EMPTY_OBJECT_STORE, ObjectBucketsTab, objectStoreConfigOf, objectStoreErrors } from "@/tools/nats/ObjectBuckets";
import { ObjectTab, shortDigest, validateObjectName } from "@/tools/nats/ObjectTab";
import { ServicesTab, formatNanos } from "@/tools/nats/ServicesTab";
import { downloadObject, fileNameOf, toBase64, uploadObject, type UploadProgress } from "@/tools/nats/objects-io";
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

const now = Date.now() * 1000;
const FILES: NatsObjBucketInfo = { bucket: "files", description: "Mightyconsole lab", bytes: 5_243_000, storage: "file", replicas: 1, compression: false, sealed: false, createdUs: now };
const BLOB: NatsObjectInfo = { bucket: "files", name: "blob-5MiB.bin", size: 5 * 1024 * 1024, chunks: 40, modifiedUs: now, digest: "SHA-256=abcdefghijklmnopqrstuvwxyz0123456789", headers: [{ name: "Content-Type", value: "application/octet-stream" }], metadata: {}, nuid: "N1", chunkSize: 131072 };
const README: NatsObjectInfo = { bucket: "files", name: "readme.txt", size: 32, chunks: 1, modifiedUs: now, digest: "SHA-256=xyz", headers: [], metadata: {}, nuid: "N2" };

/** A stub `nats.obj.get` stream yielding these chunks. */
function getStream(chunks: Uint8Array[], size: number) {
  return {
    async *chunks() {
      for (const c of chunks) yield c;
    },
    result: Promise.resolve({ name: "x", size }),
    cancel: vi.fn(),
  };
}

describe("the Object Store models", () => {
  test("bucket form, names, digests, file names and base64", () => {
    expect(objectStoreErrors(EMPTY_OBJECT_STORE)).toHaveProperty("bucket");
    expect(Object.keys(objectStoreErrors({ ...EMPTY_OBJECT_STORE, bucket: "a.b", ttl: "soon", maxBytes: "lots", replicas: "9" })).sort()).toEqual(["bucket", "maxBytes", "replicas", "ttl"]);
    expect(objectStoreConfigOf({ ...EMPTY_OBJECT_STORE, bucket: " files ", ttl: "7d", maxBytes: "10 GiB" })).toEqual({ bucket: "files", description: null, ttlMs: 604_800_000, maxBytes: 10 * 1024 ** 3, storage: "file", replicas: 1, compression: false });
    expect(validateObjectName("reports/2026 Q3.pdf")).toBeNull();
    expect(validateObjectName("")).not.toBeNull();
    expect(validateObjectName(" a")).not.toBeNull();
    expect(validateObjectName("a\nb")).not.toBeNull();
    expect(shortDigest("SHA-256=abcdefghijklmnopqrstuvwxyz")).toBe("SHA-256 abcdef…uvwxyz");
    expect(shortDigest(undefined)).toBe("");
    expect(fileNameOf("reports/2026/q3.pdf")).toBe("q3.pdf");
    expect(fileNameOf("a:b")).toBe("a_b");
    expect(toBase64(new TextEncoder().encode("hello"))).toBe("aGVsbG8=");
    expect(formatNanos(850)).toBe("850 ns");
    expect(formatNanos(850_000)).toBe("850 µs");
    expect(formatNanos(12_400_000)).toBe("12.4 ms");
    expect(formatNanos(1_200_000_000)).toBe("1.2 s");
  });
});

describe("uploads and downloads (spec §6.5 nats.obj.upload*, nats.obj.get)", () => {
  const client = (over: Record<string, unknown> = {}) => {
    const obj = {
      uploadStart: vi.fn(async () => ({ uploadId: "u1", partBytes: 4 })),
      uploadPart: vi.fn(async (input: { index: number; data: string }) => ({ received: Math.min(10, (input.index + 1) * 4) })),
      uploadFinish: vi.fn(async () => ({ ...README, name: "notes.txt", size: 10 })),
      uploadAbort: vi.fn(async () => ({})),
      ...over,
    };
    return { nats: { obj } };
  };

  test("parts go in order, each once the previous one is stored; the SHA-256 goes with finish", async () => {
    const c = client();
    const seen: UploadProgress[] = [];
    const file = new Blob([new TextEncoder().encode("0123456789")]);
    const info = await uploadObject(c as never, { connId: "conn-1", bucket: "files", name: "notes.txt", description: " ", file }, (p) => seen.push(p));
    expect(info.size).toBe(10);
    expect(c.nats.obj.uploadStart).toHaveBeenCalledWith({ connId: "conn-1", bucket: "files", name: "notes.txt", description: null, size: 10 }, {});
    expect(c.nats.obj.uploadPart.mock.calls.map(([i]) => [i.index, atob(i.data)])).toEqual([
      [0, "0123"],
      [1, "4567"],
      [2, "89"],
    ]);
    expect(seen.map((p) => [p.part, p.sent])).toEqual([
      [0, 0],
      [1, 4],
      [2, 8],
      [3, 10],
    ]);
    const finish = c.nats.obj.uploadFinish.mock.calls[0] as unknown as [{ uploadId: string; sha256: string }];
    expect(finish[0].sha256).toBe("84d89877f0d4041efb6bf91a16f0248f2fd573e6af05c19f96bedb9f882f7882");
    expect(c.nats.obj.uploadAbort).not.toHaveBeenCalled();
  });

  test("a failed part or a cancel aborts the upload", async () => {
    const failing = client({ uploadPart: vi.fn(async () => Promise.reject(new RpcError("Unavailable", "the server went away"))) });
    const file = new Blob([new TextEncoder().encode("0123456789")]);
    await expect(uploadObject(failing as never, { connId: "c", bucket: "files", name: "n", description: "", file }, () => {})).rejects.toThrow("went away");
    expect(failing.nats.obj.uploadAbort).toHaveBeenCalledWith({ uploadId: "u1" });
    const controller = new AbortController();
    const cancelled = client({
      uploadPart: vi.fn(async () => {
        controller.abort();
        return { received: 4 };
      }),
    });
    await expect(uploadObject(cancelled as never, { connId: "c", bucket: "files", name: "n", description: "", file }, () => {}, controller.signal)).rejects.toThrow();
    expect(cancelled.nats.obj.uploadPart).toHaveBeenCalledTimes(1);
    expect(cancelled.nats.obj.uploadAbort).toHaveBeenCalledWith({ uploadId: "u1" });
    expect(cancelled.nats.obj.uploadFinish).not.toHaveBeenCalled();
  });

  test("a download gathers the stream's chunks", async () => {
    const get = vi.fn(() => getStream([new Uint8Array([1, 2]), new Uint8Array([3])], 3));
    const seen: number[] = [];
    const { blob, summary } = await downloadObject({ nats: { obj: { get } } } as never, { connId: "c", bucket: "files", name: "x" }, (n) => seen.push(n));
    expect(blob.size).toBe(3);
    expect(summary.size).toBe(3);
    expect(seen).toEqual([2, 3]);
    expect(get).toHaveBeenCalledWith({ connId: "c", bucket: "files", name: "x" }, { timeoutMs: 3_600_000 });
  });
});

describe("Object Store buckets (spec §6.5 nats.obj.buckets)", () => {
  test("the list opens a bucket; New object store creates one", async () => {
    const create = vi.fn(async () => ({ ...FILES, bucket: "backups" }));
    const p = props({ nats: { obj: { buckets: { list: vi.fn(async () => [FILES, { ...FILES, bucket: "old", sealed: true }]), create } }, js: { streams: { list: vi.fn(async () => []) } } } }, "nats.objects");
    const { container } = render(<ObjectBucketsTab {...p} />);
    await waitFor(() => byRole("button", "files") !== null, "the list");
    expect(byText("sealed")).not.toBeNull();
    await click(byRole("button", "files"));
    expect(p.openTab).toHaveBeenCalledWith({ kind: "nats.object", params: { bucket: "files" }, title: "files" });
    expect(await axeViolations(container)).toEqual([]);
    await click(byRole("button", "New object store"));
    await waitFor(() => document.querySelector("form[aria-label='New object store']") !== null, "the sheet");
    await type(byRole("textbox", /^Bucket\*?$/) as HTMLInputElement, "backups");
    await type(byRole("textbox", "TTL") as HTMLInputElement, "30d");
    await click(byRole("button", "Create object store"));
    await waitFor(() => create.mock.calls.length === 1, "the create");
    expect(create).toHaveBeenCalledWith({ connId: "conn-1", config: expect.objectContaining({ bucket: "backups", ttlMs: 2_592_000_000, storage: "file" }) });
  });
});

describe("an object store (spec §6.3)", () => {
  const client = (over: Record<string, unknown> = {}) => {
    const obj = {
      buckets: { info: vi.fn(async () => FILES), delete: vi.fn(async () => ({})) },
      list: vi.fn(async () => ({ objects: [BLOB, README], truncated: false })),
      get: vi.fn(() => getStream([new Uint8Array(16)], 16)),
      delete: vi.fn(async () => ({})),
      uploadStart: vi.fn(async () => ({ uploadId: "u1", partBytes: 4 * 1024 * 1024 })),
      uploadPart: vi.fn(async () => ({ received: 5 })),
      uploadFinish: vi.fn(async () => ({ ...README, name: "hello.txt", size: 5 })),
      uploadAbort: vi.fn(async () => ({})),
      ...over,
    };
    return { nats: { obj, js: { streams: { list: vi.fn(async () => []) } } } };
  };

  test("objects with the selected one's info; a filter on the name; Download saves the bytes", async () => {
    const c = client();
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const { container } = render(<ObjectTab {...props(c, "nats.object", { bucket: "files" })} />);
    await waitFor(() => byRole("button", "blob-5MiB.bin") !== null, "the objects");
    expect(byText(/2 objects \(5 MiB\) · no TTL · file, 1 replica/)).not.toBeNull();
    const pane = document.querySelector<HTMLElement>("aside[aria-label='Object blob-5MiB.bin']")!;
    expect(pane.textContent).toContain("40 of up to 128 KiB");
    expect(pane.textContent).toContain("application/octet-stream");
    expect(byText("SHA-256 abcdef…456789")).not.toBeNull();
    await click(byRole("button", "readme.txt"));
    await waitFor(() => document.querySelector("aside[aria-label='Object readme.txt']") !== null, "another object");
    expect(byText("No headers.")).not.toBeNull();
    await click(byRole("button", "Download"));
    await waitFor(() => (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls.length === 1, "the save");
    expect(c.nats.obj.get).toHaveBeenCalledWith({ connId: "conn-1", bucket: "files", name: "readme.txt" }, expect.objectContaining({ timeoutMs: 3_600_000 }));
    await type(document.querySelector("input[aria-label='Filter objects']") as HTMLInputElement, "blob");
    await waitFor(() => byRole("button", "readme.txt") === null, "filtered");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Upload: the file's name is the object's; a server error keeps the sheet open; then it uploads", async () => {
    let fail = true;
    const uploadStart = vi.fn(async () => {
      if (fail) throw new RpcError("FailedPrecondition", "files is sealed: it takes no new objects", { details: { kind: "Conflict", system: "nats", message: "files is sealed: it takes no new objects", retryable: false } });
      return { uploadId: "u1", partBytes: 4 * 1024 * 1024 };
    });
    const c = client({ uploadStart });
    render(<ObjectTab {...props(c, "nats.object", { bucket: "files" })} />);
    await waitFor(() => byRole("button", "Upload") !== null && !(byRole("button", "Upload") as HTMLButtonElement).disabled, "the bucket");
    await click(byRole("button", "Upload"));
    await waitFor(() => document.querySelector("form[aria-label='Upload an object']") !== null, "the sheet");
    const input = document.querySelector<HTMLInputElement>("form[aria-label='Upload an object'] input[type=file]")!;
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    await act(async () => {
      Object.defineProperty(input, "files", { value: [file], configurable: true });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => (byRole("textbox", "Object name") as HTMLInputElement).value === "hello.txt", "the name");
    const submit = () => document.querySelector<HTMLButtonElement>("button[form='upload-form']")!;
    await click(submit());
    await waitFor(() => byText("files is sealed: it takes no new objects") !== null, "the error");
    fail = false;
    await type(byRole("textbox", "Object name") as HTMLInputElement, "readme.txt");
    await waitFor(() => byText(/replaces it once every part is in/) !== null, "the replace note");
    await click(submit());
    await waitFor(() => c.nats.obj.uploadFinish.mock.calls.length === 1, "the upload");
    expect(uploadStart).toHaveBeenLastCalledWith({ connId: "conn-1", bucket: "files", name: "readme.txt", description: null, size: 5 }, expect.anything());
    expect(c.nats.obj.uploadPart).toHaveBeenCalledWith({ uploadId: "u1", index: 0, data: btoa("hello") }, expect.anything());
    await waitFor(() => document.querySelector("form[aria-label='Upload an object']") === null, "the sheet closes");
  });

  test("Delete an object; Delete the bucket with its name typed", async () => {
    const c = client();
    const p = props(c, "nats.object", { bucket: "files" });
    render(<ObjectTab {...p} />);
    await waitFor(() => byRole("button", "Delete…") !== null, "the pane");
    await click(byRole("button", "Delete…"));
    await waitFor(() => byText("Delete blob-5MiB.bin from files on edge-nats?") !== null, "the confirmation");
    await click(byRole("button", "Delete object"));
    await waitFor(() => c.nats.obj.delete.mock.calls.length === 1, "deleted");
    expect(c.nats.obj.delete).toHaveBeenCalledWith({ connId: "conn-1", bucket: "files", name: "blob-5MiB.bin" });
    await click(byRole("button", "More: Delete bucket"));
    await click(byRole("menuitem", /Delete bucket/));
    await waitFor(() => byText("Delete object store files on edge-nats?") !== null, "the bucket delete");
    const del = () => byRole("button", "Delete bucket") as HTMLButtonElement;
    expect(del().disabled).toBe(true);
    await type(byRole("textbox", "Type files to confirm") as HTMLInputElement, "files");
    await click(del());
    await waitFor(() => c.nats.obj.buckets.delete.mock.calls.length === 1, "the bucket deleted");
    expect(p.openTab).toHaveBeenCalledWith({ kind: "nats.objects", params: {}, title: "Object Store" });
  });
});

describe("Services (spec §6.3)", () => {
  const ECHO: NatsServiceInfo = {
    name: "echo",
    id: "x1",
    version: "1.0.0",
    description: "Echoes the request",
    metadata: {},
    endpoints: [
      { name: "echo", subject: "lab.echo", queueGroup: "q", metadata: {} },
      { name: "upper", subject: "lab.echo.upper", metadata: {} },
    ],
    rttMs: 1.2,
  };
  const STATS: NatsServiceStats = { name: "echo", id: "x1", version: "1.0.0", started: "2026-11-19T10:00:00Z", endpoints: [{ name: "echo", subject: "lab.echo", queueGroup: "q", requests: 12, errors: 1, processingTimeNs: 2_400_000, averageProcessingTimeNs: 200_000, lastError: "500 boom" }] };
  const PING: NatsServicePing = { name: "echo", id: "x1", version: "1.0.0", rttMs: 0.8 };

  test("the services with PING; the selected one's endpoints with STATS", async () => {
    const services = { discover: vi.fn(async () => [ECHO]), stats: vi.fn(async () => [STATS]), ping: vi.fn(async () => [PING]) };
    const { container } = render(<ServicesTab {...props({ nats: { services } }, "nats.services")} />);
    await waitFor(() => byRole("button", "echo") !== null, "the services");
    expect(services.discover).toHaveBeenCalledWith({ connId: "conn-1", timeoutMs: 2000 });
    expect(byText(/1 service, 1 instance answered within 2 s/)).not.toBeNull();
    const endpoints = document.querySelector<HTMLElement>("table[aria-label='Endpoints']")!;
    expect(endpoints.textContent).toContain("lab.echo.upper");
    expect(endpoints.textContent).toContain("500 boom");
    expect(endpoints.textContent).toContain("200 µs");
    expect(document.querySelector("table[aria-label='Services']")!.textContent).toContain("0.8 ms");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("nobody answers; STATS failing leaves the list", async () => {
    const none = { discover: vi.fn(async () => []), stats: vi.fn(async () => []), ping: vi.fn(async () => []) };
    render(<ServicesTab {...props({ nats: { services: none } }, "nats.services")} />);
    await waitFor(() => byText("No services answered within 2 s.") !== null, "the empty state");
    cleanup();
    const partial = { discover: vi.fn(async () => [ECHO]), stats: vi.fn(async () => Promise.reject(new RpcError("PermissionDenied", "not allowed on $SRV.STATS"))), ping: vi.fn(async () => [PING]) };
    render(<ServicesTab {...props({ nats: { services: partial } }, "nats.services")} />);
    await waitFor(() => byText(/Some counters are missing/) !== null, "the partial note");
    expect(byText("This instance did not answer STATS.")).not.toBeNull();
  });
});

describe("the tree's Object Store and Services (spec §6.2)", () => {
  test("object stores come from the OBJ_ streams; Services opens the services", async () => {
    const client = {
      nats: {
        js: {
          streams: {
            list: vi.fn(async () => [
              { name: "KV_config", subjects: ["$KV.config.>"], messages: 7, bytes: 1, consumers: 0, createdUs: 0, storage: "file", retention: "limits", sealed: false },
              { name: "OBJ_files", subjects: ["$O.files.C.>", "$O.files.M.>"], messages: 42, bytes: 1, consumers: 0, createdUs: 0, storage: "file", retention: "limits", sealed: false },
            ]),
          },
          consumers: { list: vi.fn(async () => []) },
        },
      },
    };
    natsTreeData.load({ profile: record(), connId: "c-obj", client: client as never });
    const tree = () => natsTool.sidebarTree({ profile: record(), connId: "c-obj" });
    await waitFor(() => (tree()[4]!.children ?? []).length === 1, "the object store");
    const objects = tree()[4]!;
    expect(objects.label).toBe("Object Store");
    expect(objects.open).toEqual({ kind: "nats.objects", params: {}, title: "Object Store" });
    expect(objects.children![0]!.open).toEqual({ kind: "nats.object", params: { bucket: "files" }, title: "files" });
    expect(tree()[3]!.children!.map((c) => c.label)).toEqual(["config"]);
    expect(tree()[5]!.open).toEqual({ kind: "nats.services", params: {}, title: "Services" });
    expect(tree()[2]!.children).toEqual([]);
  });
});
