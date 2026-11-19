import { useState } from "react";
import { Icon } from "@/components/icon/icon";
import { Timeline, type TimelineItem, type TimelineLane } from "@/components/timeline/timeline";
import { Clock, Flash, Link, List, Pin, Play } from "@/lib/icons";

const lanes: TimelineLane[] = [
  { id: "wf", label: "Workflow" },
  { id: "charge", label: "Activity charge" },
];

const items: TimelineItem[] = [
  { id: "wf", laneId: "wf", start: 0, end: 4200, status: "success", label: "FulfilmentWorkflow" },
  { id: "a1", laneId: "charge", start: 300, end: 1500, status: "success", label: "charge #1" },
];

/** The smallest useful Timeline: two lanes, one workflow and one activity, without the toolbar. */
export function TimelineMinimal() {
  return <Timeline aria-label="Example timeline" lanes={lanes} items={items} now={4200} controls={false} />;
}

// A run that started at 10:42:00 local time, read on the clock axis.
const t0 = new Date(2026, 10, 18, 10, 42, 0).getTime();
const s = (seconds: number) => t0 + seconds * 1000;

const historyLanes: TimelineLane[] = [
  { id: "wf", label: "order-48213", detail: "workflow", icon: <Icon icon={Link} /> },
  { id: "tasks", label: "Workflow tasks", detail: "4 tasks", icon: <Icon icon={List} /> },
  { id: "reserve", label: "ReserveInventory", detail: "activity 5", icon: <Icon icon={Flash} /> },
  { id: "charge", label: "ChargePayment", detail: "activity 12", icon: <Icon icon={Flash} /> },
  { id: "window", label: "payment-window", detail: "timer 11", icon: <Icon icon={Clock} /> },
  { id: "confirmed", label: "customerConfirmed", detail: "signal 13", icon: <Icon icon={Play} /> },
  { id: "fraud", label: "fraud-score", detail: "marker 17", icon: <Icon icon={Pin} /> },
  { id: "receipt", label: "SendReceipt", detail: "activity 18", icon: <Icon icon={Flash} /> },
];

const history: TimelineItem[] = [
  { id: "wf", laneId: "wf", start: s(0), end: null, status: "running", label: "order-48213", caption: "Running · 1m 50s" },
  ...[1, 3, 85, 100].map((at, i): TimelineItem => ({ id: `t${i}`, laneId: "tasks", start: s(at), end: s(at), status: "neutral", label: "Workflow task", shape: "tick" })),
  { id: "a5", laneId: "reserve", start: s(1), end: s(2.7), status: "success", label: "ReserveInventory", caption: "1.67 s" },
  { id: "a12", laneId: "charge", start: s(4), end: null, status: "warning", label: "ChargePayment", shape: "hatched", caption: "Retrying · attempt 3 of 5" },
  { id: "t11", laneId: "window", start: s(4), end: null, status: "neutral", label: "payment-window", shape: "dashed", caption: "30m · fires 11:12:00" },
  { id: "s13", laneId: "confirmed", start: s(84), end: s(84), status: "info", label: "customerConfirmed", shape: "diamond", caption: "10:43:24 · 1 payload" },
  { id: "m17", laneId: "fraud", start: s(85), end: s(85), status: "neutral", label: "fraud-score", shape: "pin", caption: "SideEffect" },
  { id: "a18", laneId: "receipt", start: s(85), end: s(97), status: "danger", label: "SendReceipt", caption: "Failed · 11.8 s" },
];

/** A running workflow's history on the clock axis: a lane per thing, shapes by kind, the overview strip; picking a mark selects it. */
export function TimelineRealistic() {
  const [selected, setSelected] = useState<string | null>("a18");
  const [follow, setFollow] = useState(true);
  return (
    <Timeline
      aria-label="History timeline of order-48213"
      lanes={historyLanes}
      items={history}
      now={s(110)}
      selectedId={selected}
      onSelect={setSelected}
      defaultAxis="clock"
      overviewLabel="Whole run"
      follow={follow}
      onFollowChange={setFollow}
      className="h-panel-md"
    />
  );
}
