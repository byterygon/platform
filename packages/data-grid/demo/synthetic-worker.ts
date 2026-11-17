// Builds the synthetic batches off the UI thread and transfers them, as DBee's Arrow Worker does
// with decoded batches: the UI thread only receives buffers. One batch per request (the pull).
import { arrowTransferables } from "@byterygon/ambidex/arrow";
import { syntheticBatch } from "./synthetic.ts";

const scope = self as unknown as { postMessage(m: unknown, t: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
scope.onmessage = (e: MessageEvent<{ start: number; rows: number }>) => {
  const batch = syntheticBatch(e.data.start, e.data.rows);
  scope.postMessage(batch, arrowTransferables(batch));
};
