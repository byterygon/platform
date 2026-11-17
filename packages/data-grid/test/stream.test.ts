// ResultSource on a real decodeArrow stream: the pull rate is the backpressure (credits), the
// memory budget pauses on purpose, the viewport near the end resumes, cancel keeps the rows.
import { describe, expect, test } from "vitest";
import { batchByteLength, ResultSource, retain, sourceFor } from "../src/index.ts";
import { countingStream, decoded, idTable, settle } from "./support.ts";

async function until(condition: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await settle(1);
  }
}

describe("ResultSource", () => {
  test("below the budget it pulls the whole stream and ends done", async () => {
    const s = countingStream(idTable(1000, 100));
    const source = ResultSource.fromStream(s.stream);
    const states: string[] = [];
    source.subscribe(() => states.push(source.state));
    await until(() => !source.live);
    expect(source.state).toBe("done");
    expect(source.index.rowCount).toBe(1000);
    expect(source.index.batchCount).toBe(10);
    expect(source.fields?.map((f) => f.name)).toEqual(["id", "name"]);
    expect(s.taken).toBe(s.total);
    expect(states[0]).toBe("streaming");
    expect(states.at(-1)).toBe("done");
  });

  test("it never pulls before a subscriber and pulls batches() exactly once", async () => {
    const s = countingStream(idTable(300, 100));
    const source = ResultSource.fromStream(s.stream);
    await settle(5);
    // Only the schema chunk is read without a consumer (decodeArrow reads it eagerly).
    expect(source.index.rowCount).toBe(0);
    const off1 = source.subscribe(() => {});
    const off2 = source.subscribe(() => {});
    await until(() => !source.live);
    expect(source.index.rowCount).toBe(300);
    off1();
    off2();
  });

  test("at the budget it stops on purpose; the viewport near the end pulls one batch at a time", async () => {
    const t = idTable(2000, 100);
    const { batches } = await decoded(t);
    const perBatch = batchByteLength(batches[0]!);
    const s = countingStream(t);
    const source = ResultSource.fromStream(s.stream);
    source.budget = perBatch * 3;
    source.setViewport(0, 10);
    source.subscribe(() => {});
    await until(() => source.state === "paused");
    await settle(20);
    // Pulls until the budget is reached, then nothing more: no unused credit is granted.
    expect(source.index.rowCount).toBe(300);
    const takenAtPause = s.taken;
    await settle(20);
    expect(s.taken).toBe(takenAtPause);
    expect(source.progress).toMatchObject({ state: "paused", rows: 300 });

    // Scrolled to within two screens of the last loaded row: pull, re-check after each batch.
    source.setViewport(299 - 15, 10);
    await until(() => source.index.rowCount >= 400 && source.state === "paused");
    await settle(20);
    expect(source.index.rowCount).toBe(400);
    expect(s.taken).toBe(takenAtPause + 1);

    // Raising the budget resumes the stream to its end.
    source.budget = Number.POSITIVE_INFINITY;
    await until(() => !source.live);
    expect(source.state).toBe("done");
    expect(source.index.rowCount).toBe(2000);
  });

  test("cancel stops the stream and keeps the rows loaded", async () => {
    const t = idTable(2000, 100);
    const { batches } = await decoded(t);
    const s = countingStream(t);
    const source = ResultSource.fromStream(s.stream);
    source.budget = batchByteLength(batches[0]!) * 5;
    source.subscribe(() => {});
    await until(() => source.state === "paused");
    source.cancel();
    await until(() => !source.live);
    expect(source.state).toBe("cancelled");
    expect(source.index.rowCount).toBe(500);
    expect(s.cancelled).toBe(true);
  });

  test("a stream that is not Arrow ends in error with the rows kept", async () => {
    const s = countingStream(idTable(300, 100), { garbage: true });
    const source = ResultSource.fromStream(s.stream);
    source.subscribe(() => {});
    await until(() => !source.live);
    expect(source.state).toBe("error");
    expect(source.progress.error).toBeDefined();
  });

  test("one source per stream; the last unsubscribe cancels after a task, a quick resubscribe keeps it", async () => {
    const t = idTable(2000, 100);
    const { batches } = await decoded(t);
    const s = countingStream(t);
    const source = sourceFor(s.stream);
    expect(sourceFor(s.stream)).toBe(source);
    source.budget = batchByteLength(batches[0]!) * 2;
    // StrictMode: mount, unmount, mount again in the same task.
    const release1 = retain(source, () => {});
    release1();
    const release2 = retain(source, () => {});
    await until(() => source.state === "paused");
    await settle(5);
    expect(source.state).toBe("paused");
    expect(s.cancelled).toBe(false);
    release2();
    await until(() => !source.live);
    expect(source.state).toBe("cancelled");
    expect(s.cancelled).toBe(true);
  });

  test("a fixed result is complete at once", () => {
    const source = ResultSource.fromBatches([], []);
    expect(source.state).toBe("done");
    expect(source.live).toBe(false);
  });
});
