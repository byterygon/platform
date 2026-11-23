// `temporal`: the Temporal Web UI's replacement (Mightyconsole spec §9, TSK-83). This batch: the
// profile and its form, namespaces, the workflow list and detail, the actions with their
// confirmations, schedules, task queues, workers and standalone activities (TSK-92).
import { Icon } from "@/components/ui/icon";
import type { ConnectTemporalProfile } from "@/gen/api";
import { CalendarClock, Clock, Flash, Folder, List, Search, Server } from "@/lib/icons";
import type { ResourceNode, ToolModule } from "../types";
import { ActivitiesTab } from "./ActivitiesTab";
import { ActivityTab } from "./ActivityTab";
import { ConnectionForm } from "./ConnectionForm";
import { NamespacesTab } from "./NamespacesTab";
import { PayloadTab } from "./PayloadTab";
import { ScheduleTab } from "./ScheduleTab";
import { SchedulesTab } from "./SchedulesTab";
import { TaskQueueTab } from "./TaskQueueTab";
import { WorkersTab } from "./WorkersTab";
import { WorkflowTab } from "./WorkflowTab";
import { WorkflowsTab } from "./WorkflowsTab";
import { savedQueryActions } from "./list-parts";
import { namespaceOf, profile, savedQueriesOf } from "./profile";
import { temporalHrefs, temporalRoutes } from "./routes";
import { requestSheet } from "./sheet-parts";
import { temporalTreeData, treeDataOf } from "./tree-data";
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
  // The TSK-91 mockup's tree: Namespaces with their count, then a folder per namespace of the
  // cluster (the profile's first, open; the others as the cluster lists them, once loaded), each
  // with Workflows (saved queries under the profile's), Schedules, Task queues and Workers, the
  // profile's namespace with its counts. Ids of the profile's namespace keep their old form.
  sidebarTree({ profile: p, connId }): readonly ResourceNode[] {
    const namespace = namespaceOf(p);
    const tree = treeDataOf(connId);
    const names = tree.namespaces ?? [namespace];
    const count = (n: number | undefined) => (n === undefined ? undefined : <span className="text-caption-1 text-fg-muted">{n}</span>);
    const folder = (ns: string): ResourceNode => {
      const mine = ns === namespace;
      const id = (part: string) => (mine ? `${p.id}/${part}` : `${p.id}/ns/${ns}/${part}`);
      const counts = tree.counts[ns] ?? {};
      const workers = count(counts.workers);
      const schedules = count(counts.schedules);
      // Standalone activities: their count, or "not supported" with the server's reason.
      const activities =
        counts.activitiesUnsupported !== undefined ? (
          <span className="text-caption-1 text-fg-muted" title={counts.activitiesUnsupported}>
            not supported
          </span>
        ) : (
          count(counts.activities)
        );
      return {
        id: `${p.id}/ns/${ns}`,
        label: ns,
        icon: <Icon icon={Folder} />,
        expanded: mine,
        children: [
          {
            id: id("workflows"),
            label: "Workflows",
            icon: <Icon icon={Flash} />,
            open: { kind: "temporal.workflows", params: { namespace: ns, query: "" }, title: `Workflows · ${ns}` },
            ...(mine
              ? {
                  children: savedQueriesOf(p.extras).map((saved) => ({
                    id: `${p.id}/workflows/${saved.name}`,
                    label: saved.name,
                    icon: <Icon icon={Search} />,
                    open: { kind: "temporal.workflows", params: { namespace, query: saved.query }, title: `${saved.name} · ${namespace}` },
                    actions: savedQueryActions(saved.name, savedQueriesOf(p.extras)),
                  })),
                  expanded: true,
                }
              : {}),
          },
          {
            id: id("activities"),
            label: "Activities",
            icon: <Icon icon={Flash} />,
            ...(activities ? { meta: activities } : {}),
            open: { kind: "temporal.activities", params: { namespace: ns, query: "" }, title: `Activities · ${ns}` },
          },
          {
            id: id("schedules"),
            label: "Schedules",
            icon: <Icon icon={CalendarClock} />,
            ...(schedules ? { meta: schedules } : {}),
            open: { kind: "temporal.schedules", params: { namespace: ns }, title: `Schedules · ${ns}` },
          },
          {
            id: id("task-queues"),
            label: "Task queues",
            icon: <Icon icon={List} />,
            open: { kind: "temporal.taskQueue", params: { namespace: ns, name: "" }, title: `Task queues · ${ns}` },
          },
          {
            id: id("workers"),
            label: "Workers",
            icon: <Icon icon={Server} />,
            ...(workers ? { meta: workers } : {}),
            open: { kind: "temporal.workers", params: { namespace: ns }, title: `Workers · ${ns}` },
          },
        ],
      };
    };
    const namespacesCount = count(tree.namespaces?.length);
    return [
      {
        id: `${p.id}/namespaces`,
        label: "Namespaces",
        icon: <Icon icon={List} />,
        ...(namespacesCount ? { meta: namespacesCount } : {}),
        open: { kind: "temporal.namespaces", params: {}, title: "Namespaces" },
      },
      ...names.map(folder),
    ];
  },
  sidebarData: temporalTreeData,
  routes: temporalRoutes,
  // The tree that follows the tab (DOC-21 §3.2.1): a namespace's list nodes; a workflow, an
  // activity or a schedule is under its list (the tree does not draw them), a saved query its node.
  nodeOfTab: ({ kind, params }, p) => {
    const mine = namespaceOf(p);
    const ns = typeof params["namespace"] === "string" && params["namespace"] !== "" ? (params["namespace"] as string) : mine;
    const folder = `${p.id}/ns/${ns}`;
    const child = (part: string) => [folder, ns === mine ? `${p.id}/${part}` : `${p.id}/ns/${ns}/${part}`];
    switch (kind) {
      case "temporal.namespaces":
        return [`${p.id}/namespaces`];
      case "temporal.workflows": {
        const query = typeof params["query"] === "string" ? params["query"] : "";
        const saved = ns === mine && query !== "" ? savedQueriesOf(p.extras).find((s) => s.query === query) : undefined;
        return saved ? [...child("workflows"), `${p.id}/workflows/${saved.name}`] : child("workflows");
      }
      case "temporal.workflow":
        return child("workflows");
      case "temporal.activities":
      case "temporal.activity":
        return child("activities");
      case "temporal.schedules":
      case "temporal.schedule":
        return child("schedules");
      case "temporal.taskQueue":
        return child("task-queues");
      case "temporal.workers":
        return child("workers");
      default:
        // A payload opened from a workflow is under Workflows, as its workflow is.
        return child("workflows");
    }
  },
  tabKinds: {
    "temporal.namespaces": {
      title: () => "Namespaces",
      Component: NamespacesTab,
      href: temporalHrefs["temporal.namespaces"]!,
    },
    "temporal.workers": {
      title: (params) => `Workers · ${typeof params["namespace"] === "string" ? params["namespace"] : "default"}`,
      Component: WorkersTab,
      href: temporalHrefs["temporal.workers"]!,
    },
    "temporal.workflows": {
      title: (params) => `Workflows · ${typeof params["namespace"] === "string" ? params["namespace"] : "default"}`,
      Component: WorkflowsTab,
      href: temporalHrefs["temporal.workflows"]!,
    },
    "temporal.activities": {
      title: (params) => `Activities · ${typeof params["namespace"] === "string" ? params["namespace"] : "default"}`,
      Component: ActivitiesTab,
      href: temporalHrefs["temporal.activities"]!,
    },
    "temporal.activity": {
      title: (params) => (typeof params["activityId"] === "string" ? params["activityId"] : "Activity"),
      Component: ActivityTab,
      href: temporalHrefs["temporal.activity"]!,
    },
    // A large payload kept on the server (TSK-92): no URL, its id lives 10 minutes.
    "temporal.payload": {
      title: (params) => (typeof params["label"] === "string" ? params["label"] : "Payload"),
      Component: PayloadTab,
    },
    "temporal.schedules": {
      title: (params) => `Schedules · ${typeof params["namespace"] === "string" ? params["namespace"] : "default"}`,
      Component: SchedulesTab,
      href: temporalHrefs["temporal.schedules"]!,
    },
    "temporal.schedule": {
      title: (params) => (typeof params["scheduleId"] === "string" ? params["scheduleId"] : "Schedule"),
      Component: ScheduleTab,
      href: temporalHrefs["temporal.schedule"]!,
    },
    "temporal.taskQueue": {
      title: (params) => (typeof params["name"] === "string" && params["name"] !== "" ? `Task queue ${params["name"]}` : "Task queues"),
      Component: TaskQueueTab,
      href: temporalHrefs["temporal.taskQueue"]!,
    },
    "temporal.workflow": {
      title: (params) => (typeof params["workflowId"] === "string" ? params["workflowId"] : "Workflow"),
      Component: WorkflowTab,
      href: temporalHrefs["temporal.workflow"]!,
    },
  },
  // The Write sheets from the palette: each opens the profile namespace's tab and its sheet.
  actions: [
    {
      id: "startWorkflow",
      label: "Start workflow",
      keywords: ["temporal", "run", "execute"],
      run({ profile: p, openTab }) {
        const namespace = namespaceOf(p);
        requestSheet(p.id, "startWorkflow");
        openTab({ kind: "temporal.workflows", params: { namespace, query: "" }, title: `Workflows · ${namespace}` });
      },
    },
    {
      id: "runActivity",
      label: "Run activity",
      keywords: ["temporal", "standalone", "activity", "execute"],
      run({ profile: p, openTab }) {
        const namespace = namespaceOf(p);
        requestSheet(p.id, "runActivity");
        openTab({ kind: "temporal.activities", params: { namespace, query: "" }, title: `Activities · ${namespace}` });
      },
    },
    {
      id: "createSchedule",
      label: "Create schedule",
      keywords: ["temporal", "cron", "calendar", "interval"],
      run({ profile: p, openTab }) {
        const namespace = namespaceOf(p);
        requestSheet(p.id, "createSchedule");
        openTab({ kind: "temporal.schedules", params: { namespace }, title: `Schedules · ${namespace}` });
      },
    },
  ],
  async connect(client, record) {
    const out = await client.temporal.connect({ profile: profile.toConnect(record) as ConnectTemporalProfile });
    return { connId: out.connId };
  },
  async disconnect(client, connId) {
    await client.temporal.disconnect({ connId });
  },
};
