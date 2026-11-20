// Moving an object's bytes between the browser and an object store (§6.5): an upload is parts of
// `partBytes` (4 MiB) sent in order through `nats.obj.uploadPart`, each answered once JetStream
// stored it, so the next part leaves only then (DOC-21 Open question 4: Ambidex has no client
// stream). A failed or cancelled upload is aborted, which purges what was written. A download
// reads the `nats.obj.get` bytes stream into a Blob. Files never leave for anywhere but the server.
import type { MightyClient } from "@/app/client";
import type { NatsObjGetSummary, NatsObjectInfo } from "@/gen/api";

/** The largest object uploaded or downloaded (DOC-21 Open question 12). */
export const MAX_OBJECT_BYTES = 1024 ** 3;
/** Files up to this size are hashed in the browser, so the server checks the bytes it stored. */
export const HASHED_BYTES = 64 * 1024 * 1024;

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The file's SHA-256 in hex, or null when it is large or the page cannot hash. */
export async function sha256Hex(file: Blob): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || file.size > HASHED_BYTES) return null;
  const digest = new Uint8Array(await subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface UploadProgress {
  /** Parts stored. */
  part: number;
  parts: number;
  /** Bytes stored. */
  sent: number;
  total: number;
}

export interface UploadInput {
  connId: string;
  bucket: string;
  name: string;
  description: string;
  file: Blob;
}

/** Uploads a file in parts; aborts the upload (its chunks purged) when a part fails or `signal` fires. */
export async function uploadObject(client: MightyClient, input: UploadInput, onProgress: (p: UploadProgress) => void, signal?: AbortSignal): Promise<NatsObjectInfo> {
  const { connId, bucket, name, file } = input;
  if (file.size > MAX_OBJECT_BYTES) throw new Error("The file is over 1 GiB, the largest upload.");
  const sha256 = await sha256Hex(file);
  signal?.throwIfAborted();
  const opts = signal ? { signal } : {};
  const started = await client.nats.obj.uploadStart({ connId, bucket, name, description: input.description.trim() || null, size: file.size }, opts);
  const { uploadId, partBytes } = started;
  const parts = Math.ceil(file.size / partBytes);
  onProgress({ part: 0, parts, sent: 0, total: file.size });
  try {
    for (let index = 0; index < parts; index += 1) {
      signal?.throwIfAborted();
      const slice = file.slice(index * partBytes, Math.min(file.size, (index + 1) * partBytes));
      const data = toBase64(new Uint8Array(await slice.arrayBuffer()));
      const out = await client.nats.obj.uploadPart({ uploadId, index, data }, opts);
      onProgress({ part: index + 1, parts, sent: out.received, total: file.size });
    }
    signal?.throwIfAborted();
    return await client.nats.obj.uploadFinish({ uploadId, sha256 }, opts);
  } catch (e) {
    void client.nats.obj.uploadAbort({ uploadId }).catch(() => undefined);
    throw e;
  }
}

/** Reads an object's bytes; `onProgress` gets the bytes read so far. */
export async function downloadObject(client: MightyClient, input: { connId: string; bucket: string; name: string }, onProgress: (received: number) => void, signal?: AbortSignal): Promise<{ blob: Blob; summary: NatsObjGetSummary }> {
  const stream = client.nats.obj.get(input, { timeoutMs: 3_600_000, ...(signal ? { signal } : {}) });
  const parts: Uint8Array[] = [];
  let received = 0;
  for await (const chunk of stream.chunks()) {
    parts.push(chunk);
    received += chunk.byteLength;
    onProgress(received);
  }
  const summary = await stream.result;
  return { blob: new Blob(parts as BlobPart[], { type: "application/octet-stream" }), summary };
}

/** The file name an object saves as: its last path segment. */
export function fileNameOf(objectName: string): string {
  const last = objectName.split("/").filter(Boolean).pop() ?? objectName;
  return last.replace(/[\\:*?"<>|]/g, "_") || "object";
}

/** Hands a Blob to the browser as a download. */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
