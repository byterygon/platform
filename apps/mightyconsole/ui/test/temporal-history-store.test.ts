// Long histories in the UI (TSK-109, DOC-21 §9.6.1): the HistoryStore and what it keeps up to date
// one event at a time (History's facts, the Timeline) give the same as computing over the whole
// history, whichever way the pages came; the row models give the rows `historyRows` builds,
// either order, without building them all.
import { describe, expect, test, vi } from "vitest";
import type { EventCategory, HistoryEvent } from "@/gen/api";
import { buildTimeline } from "@/tools/temporal/history";
import { allRows, flatRows, foldedRows, historyRows, summaryContext } from "@/tools/temporal/history-view";
import { HistoryStore } from "@/tools/temporal/history-store";
import { lanesInOrder } from "@/tools/temporal/WorkflowTab";

const T0 = Date.parse("2026-11-22T01:00:00Z");
const ev = (eventId: number, eventType: string, category: EventCategory, attributes: Record<string, unknown> = {}): HistoryEvent => ({ eventId, eventTime: new Date(T0 + eventId * 10).toISOString(), eventType, category, attributes, size: 100 + (eventId % 7) * 50 });

/** A long run as a worker writes it: workflow tasks, activities (one failing, one left open), timers, signals, a child, a marker. */
function history(activities: number): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  const add = (type: string, category: EventCategory, attributes: Record<string, unknown> = {}) => {
    const e = ev(out.length + 1, type, category, attributes);
    out.push(e);
    return e.eventId;
  };
  const task = () => {
    const s = add("WorkflowTaskScheduled", "WorkflowTask", { taskQueue: { name: "lab" } });
    add("WorkflowTaskStarted", "WorkflowTask", { scheduledEventId: s, identity: "w@lab" });
    add("WorkflowTaskCompleted", "WorkflowTask", { scheduledEventId: s });
  };
  add("WorkflowExecutionStarted", "Workflow", { workflowType: { name: "Long" }, taskQueue: { name: "lab" }, input: ["x"] });
  task();
  for (let i = 0; i < activities; i += 1) {
    const s = add("ActivityTaskScheduled", "Activity", { activityType: { name: `act-${i % 5}` }, activityId: String(i), retryPolicy: { maximumAttempts: 3 } });
    if (i === activities - 1) break; // left open
    add("ActivityTaskStarted", "Activity", { scheduledEventId: s, attempt: 1, identity: "w@lab" });
    add(i % 97 === 5 ? "ActivityTaskFailed" : "ActivityTaskCompleted", "Activity", { scheduledEventId: s, result: [i], ...(i % 97 === 5 ? { failure: { message: "boom" } } : {}) });
    if (i % 50 === 0) {
      const t = add("TimerStarted", "Timer", { timerId: `t${i}`, startToFireTimeout: "1s" });
      add("TimerFired", "Timer", { startedEventId: t, timerId: `t${i}` });
    }
    if (i % 70 === 0) add("WorkflowExecutionSignaled", "Signal", { signalName: i % 140 === 0 ? "approve" : "nudge", input: [i] });
    if (i === 30) {
      const c = add("StartChildWorkflowExecutionInitiated", "ChildWorkflow", { workflowId: "child-1", workflowType: { name: "Child" } });
      add("ChildWorkflowExecutionStarted", "ChildWorkflow", { initiatedEventId: c });
      add("ChildWorkflowExecutionCompleted", "ChildWorkflow", { initiatedEventId: c });
    }
    if (i === 40) add("MarkerRecorded", "Marker", { markerName: "version" });
    if (i % 3 === 0) task();
  }
  task();
  return out;
}

/** Splits a list into pieces of irregular sizes. */
function pieces<T>(list: readonly T[], seed = 7): T[][] {
  const out: T[][] = [];
  let i = 0;
  let n = seed;
  while (i < list.length) {
    n = (n * 31 + 11) % 97;
    const size = 1 + (n % 40);
    out.push(list.slice(i, i + size));
    i += size;
  }
  return out;
}

/** The Timeline as plain data, to compare two builds. */
const plain = (data: ReturnType<typeof buildTimeline>) => ({ lanes: data.lanes.map((l) => ({ ...l })), items: data.items.map((i) => ({ ...i })), info: [...data.info.entries()].map(([k, v]) => [k, { ...v, eventIds: [...v.eventIds] }]), counts: { ...data.counts }, itemOfEvent: [...data.itemOfEvent.entries()].sort((a, b) => a[0] - b[0]) });

const pending = [{ activityId: "199", attempt: 3, maximumAttempts: 5, lastFailure: { message: "flaky" } }];

describe("the history store (TSK-109)", () => {
  const all = history(200);
  const now = T0 + (all.length + 500) * 10;

  test("newer events added a piece at a time give what the whole history gives", () => {
    const store = new HistoryStore("long-1");
    for (const piece of pieces(all)) store.append(piece);
    expect(store.size).toBe(all.length);
    expect(store.generation).toBe(0);
    expect(store.toArray()).toEqual(all);
    const ctx = summaryContext(all);
    expect(store.facts.counts.All).toBe(all.length);
    expect([...store.facts.pairs.entries()].sort((a, b) => a[0] - b[0])).toEqual([...summaryContextPairs(all)]);
    expect([...store.facts.activities.entries()]).toEqual([...ctx.activities.entries()]);
    expect(plain(store.timeline.view(now, pending))).toEqual(plain(buildTimeline(all, { workflowId: "long-1", now, pending })));
    // The open activity reads the pending one: hatched, retrying.
    const open = store.timeline.view(now, pending).items.find((i) => i.end === null && i.label.startsWith("act-"));
    expect(open?.shape).toBe("hatched");
    expect(open?.caption).toContain("Retrying · attempt 3 of 5");
    // Without it, back to the history alone.
    expect(store.timeline.view(now, []).items.find((i) => i.id === open?.id)?.shape).toBeUndefined();
  });

  test("older pages, newest first, give the same once they are all in", () => {
    const store = new HistoryStore("long-1");
    const newestFirst = [...all].reverse();
    let generation = store.generation;
    for (const page of pieces(newestFirst, 3)) {
      store.prepend(page);
      // An older page makes the facts anew, once.
      expect(store.generation).toBe(generation + 1);
      generation = store.generation;
    }
    expect(store.toArray()).toEqual(all);
    expect(store.lo).toBe(1);
    expect(store.hi).toBe(all.length);
    expect(plain(store.timeline.view(now, pending))).toEqual(plain(buildTimeline(all, { workflowId: "long-1", now, pending })));
    expect(allRows(foldedRows(store.facts.units, new Set()))).toEqual(historyRows(all, { category: "All", fold: true, expanded: new Set(), query: "", ctx: summaryContext(all) }));
  });

  test("followed events while older pages arrive: the run stays without gaps or repeats", () => {
    const store = new HistoryStore();
    const middle = Math.floor(all.length / 2);
    store.prepend(all.slice(middle, middle + 50));
    store.append(all.slice(middle + 50, middle + 60));
    store.prepend(all.slice(middle - 30, middle));
    // A repeat and an event past a gap are left out.
    expect(store.append([all[middle + 55]!, all[middle + 70]!])).toBe(0);
    expect(store.prepend([all[middle - 40]!])).toBe(0);
    expect(store.toArray()).toEqual(all.slice(middle - 30, middle + 60));
    expect(store.get(middle - 29)).toBe(all[middle - 30]);
    expect(store.get(1)).toBeUndefined();
    store.setFirst(all[0]!);
    expect(store.get(1)).toBe(all[0]);
    expect(store.first).toBe(all[0]);
  });

  test("changes are published at most once a frame", async () => {
    const store = new HistoryStore();
    const listener = vi.fn();
    store.subscribe(listener);
    for (const e of all.slice(0, 100)) store.append([e]);
    expect(listener).not.toHaveBeenCalled();
    await new Promise<void>((r) => setTimeout(r, 40));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toBeGreaterThan(0);
  });
});

/** The pairs as `pairsOf` gives them, sorted. */
function summaryContextPairs(events: readonly HistoryEvent[]) {
  const store = new HistoryStore();
  store.append(events);
  return [...store.facts.pairs.entries()].sort((a, b) => a[0] - b[0]);
}

describe("the row models (TSK-109)", () => {
  const all = history(60);
  const ctx = summaryContext(all);
  const store = new HistoryStore();
  store.append(all);
  const firsts = historyRows(all, { category: "All", fold: true, expanded: new Set(), query: "", ctx }).flatMap((r) => (r.kind === "group" ? [r.first] : []));
  const open = new Set([firsts[0]!, firsts[3]!, firsts[firsts.length - 1]!]);

  test("folded rows are historyRows' rows, folds closed or open, in either order", () => {
    for (const expanded of [new Set<number>(), open]) {
      const want = historyRows(all, { category: "All", fold: true, expanded, query: "", ctx });
      expect(allRows(foldedRows(store.facts.units, expanded))).toEqual(want);
      // Newest first: the units reversed, an open fold's events too, each under its fold row.
      const reversed = allRows(foldedRows(store.facts.units, expanded, true));
      expect(reversed.length).toBe(want.length);
      expect(reversed.filter((r) => r.kind === "event" && !r.inFold).map((r) => (r.kind === "event" ? r.event.eventId : 0))).toEqual(
        want
          .filter((r) => r.kind === "event" && !r.inFold)
          .map((r) => (r.kind === "event" ? r.event.eventId : 0))
          .reverse(),
      );
    }
  });

  test("find gives an event's row, or the closed fold that holds it", () => {
    for (const newestFirst of [false, true]) {
      const model = foldedRows(store.facts.units, open, newestFirst);
      for (const e of all) {
        const found = model.find(e.eventId);
        expect(found).not.toBeNull();
        const row = model.row(found!.index);
        if (found!.fold === undefined) expect(row.kind === "event" && row.event.eventId).toBe(e.eventId);
        else expect(row.kind === "group" && row.first).toBe(found!.fold);
      }
      const flat = flatRows(all, newestFirst);
      expect(flat.row(flat.find(42)!.index)).toEqual({ kind: "event", event: all[41] });
      expect(flat.find(all.length + 1)).toBeNull();
    }
  });
});

describe("the Timeline's order (TSK-109)", () => {
  test("newest first keeps the workflow and its workflow tasks on top, the other lanes newest first", () => {
    const lanes = [
      { id: "workflow", kind: "workflow" as const },
      { id: "workflowTask", kind: "workflowTask" as const },
      { id: "activity:5", kind: "activity" as const },
      { id: "timer:9", kind: "timer" as const },
      { id: "signal:approve", kind: "signal" as const },
    ];
    expect(lanesInOrder(lanes, "newest").map((l) => l.id)).toEqual(["workflow", "workflowTask", "signal:approve", "timer:9", "activity:5"]);
    expect(lanesInOrder(lanes, "oldest").map((l) => l.id)).toEqual(lanes.map((l) => l.id));
  });
});
