import { useState } from "react";
import { Timeline, type TimelineItem, type TimelineLane } from "@/components/timeline/timeline";

const lanes: TimelineLane[] = [
  { id: "wf", label: "Workflow" },
  { id: "charge", label: "Activity charge" },
];

const items: TimelineItem[] = [
  { id: "wf", laneId: "wf", start: 0, end: 4200, status: "success", label: "FulfilmentWorkflow" },
  { id: "a1", laneId: "charge", start: 300, end: 1500, status: "success", label: "charge #1" },
];

/** The smallest useful Timeline: two lanes, one workflow and one activity. */
export function TimelineMinimal() {
  return <Timeline aria-label="Example timeline" lanes={lanes} items={items} now={4200} />;
}

const history: TimelineItem[] = [
  { id: "wf", laneId: "wf", start: 0, end: null, status: "running", label: "OrderWorkflow" },
  { id: "a1", laneId: "act", start: 400, end: 2100, status: "success", label: "reserveStock" },
  { id: "a2", laneId: "act", start: 2200, end: 3900, status: "danger", label: "charge (attempt 1)" },
  { id: "a3", laneId: "act", start: 5200, end: null, status: "running", label: "charge (attempt 2)" },
  { id: "t1", laneId: "timer", start: 3900, end: 5200, status: "info", label: "retry timer" },
  { id: "s1", laneId: "signal", start: 1800, end: 1800, status: "neutral", label: "signal approve" },
  { id: "c1", laneId: "child", start: 2500, end: 6100, status: "warning", label: "NotifyWorkflow" },
];

const historyLanes: TimelineLane[] = [
  { id: "wf", label: "Workflow" },
  { id: "act", label: "Activities" },
  { id: "timer", label: "Timers" },
  { id: "signal", label: "Signals" },
  { id: "child", label: "Child workflows" },
];

/** A running workflow's history: the open items grow to `now`; picking a bar selects it. */
export function TimelineRealistic() {
  const [selected, setSelected] = useState<string | null>("a2");
  return <Timeline aria-label="History timeline of order-1" lanes={historyLanes} items={history} now={7000} selectedId={selected} onSelect={setSelected} className="h-panel-md" />;
}
