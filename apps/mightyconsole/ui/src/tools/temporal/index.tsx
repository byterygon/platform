// `temporal`: the Temporal Web UI's replacement (Mightyconsole spec §9, TSK-83). This batch: the
// profile and its form, namespaces, the workflow list and detail, the actions with their
// confirmations, schedules and task queues.
import { Icon } from "@/components/ui/icon";
import type { ConnectTemporalProfile } from "@/gen/api";
import { CalendarClock, Clock, Flash, Search, Server } from "@/lib/icons";
import type { ResourceNode, ToolModule } from "../types";
import { ConnectionForm } from "./ConnectionForm";
import { ScheduleTab, SchedulesTab } from "./SchedulesTab";
import { TaskQueueTab } from "./TaskQueueTab";
import { WorkflowTab } from "./WorkflowTab";
import { WorkflowsTab } from "./WorkflowsTab";
import { namespaceOf, profile, savedQueriesOf } from "./profile";
import { TemporalMark } from "../marks";

export const temporalTool: ToolModule = {
  id: "temporal",
  label: "Temporal",
  icon: Clock,
  mark: TemporalMark,
  category: "Workflows and agents",
  order: 50,
  description: "Workflows, schedules and task queues of a Temporal cluster.",
  profile,
  ConnectionForm,
  // The profile opens one namespace, so its Workflows, Schedules and Task queues sit directly under
  // it (no extra level to expand); the namespace is in every tab's title. Saved queries are the
  // children of Workflows.
  sidebarTree({ profile: p }): readonly ResourceNode[] {
    const namespace = namespaceOf(p);
    return [
      {
        id: `${p.id}/workflows`,
        label: "Workflows",
        icon: <Icon icon={Flash} />,
        open: { kind: "temporal.workflows", params: { namespace, query: "" }, title: `Workflows · ${namespace}` },
        children: savedQueriesOf(p.extras).map((saved) => ({
          id: `${p.id}/workflows/${saved.name}`,
          label: saved.name,
          icon: <Icon icon={Search} />,
          open: { kind: "temporal.workflows", params: { namespace, query: saved.query }, title: `${saved.name} · ${namespace}` },
        })),
      },
      {
        id: `${p.id}/schedules`,
        label: "Schedules",
        icon: <Icon icon={CalendarClock} />,
        open: { kind: "temporal.schedules", params: { namespace }, title: `Schedules · ${namespace}` },
      },
      {
        id: `${p.id}/task-queues`,
        label: "Task queues",
        icon: <Icon icon={Server} />,
        open: { kind: "temporal.taskQueue", params: { namespace, name: "" }, title: `Task queues · ${namespace}` },
      },
    ];
  },
  tabKinds: {
    "temporal.workflows": {
      title: (params) => `Workflows · ${typeof params["namespace"] === "string" ? params["namespace"] : "default"}`,
      Component: WorkflowsTab,
    },
    "temporal.schedules": {
      title: (params) => `Schedules · ${typeof params["namespace"] === "string" ? params["namespace"] : "default"}`,
      Component: SchedulesTab,
    },
    "temporal.schedule": {
      title: (params) => (typeof params["scheduleId"] === "string" ? params["scheduleId"] : "Schedule"),
      Component: ScheduleTab,
    },
    "temporal.taskQueue": {
      title: (params) => (typeof params["name"] === "string" && params["name"] !== "" ? `Task queue ${params["name"]}` : "Task queues"),
      Component: TaskQueueTab,
    },
    "temporal.workflow": {
      title: (params) => (typeof params["workflowId"] === "string" ? params["workflowId"] : "Workflow"),
      Component: WorkflowTab,
    },
  },
  actions: [],
  async connect(client, record) {
    const out = await client.temporal.connect({ profile: profile.toConnect(record) as ConnectTemporalProfile });
    return { connId: out.connId };
  },
  async disconnect(client, connId) {
    await client.temporal.disconnect({ connId });
  },
};
