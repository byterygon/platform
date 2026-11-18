// `temporal`: the Temporal Web UI's replacement (Mightyconsole spec §9, TSK-83). This batch: the
// profile and its form, namespaces, and the workflow list. The workflow detail, the actions, the
// schedules and the task queues are added by the next batches.
import { Icon } from "@/components/ui/icon";
import type { ConnectTemporalProfile } from "@/gen/api";
import { Clock, Flash, Search } from "@/lib/icons";
import type { ResourceNode, ToolModule } from "../types";
import { ConnectionForm } from "./ConnectionForm";
import { WorkflowTab } from "./WorkflowTab";
import { WorkflowsTab } from "./WorkflowsTab";
import { namespaceOf, profile, savedQueriesOf } from "./profile";

export const temporalTool: ToolModule = {
  id: "temporal",
  label: "Temporal",
  icon: Clock,
  description: "Workflows, schedules and task queues of a Temporal cluster.",
  profile,
  ConnectionForm,
  sidebarTree({ profile: p }): readonly ResourceNode[] {
    const namespace = namespaceOf(p);
    return [
      {
        id: `${p.id}/ns/${namespace}`,
        label: namespace,
        children: [
          {
            id: `${p.id}/ns/${namespace}/workflows`,
            label: "Workflows",
            icon: <Icon icon={Flash} />,
            open: { kind: "temporal.workflows", params: { namespace, query: "" }, title: `Workflows · ${namespace}` },
            children: savedQueriesOf(p.extras).map((saved) => ({
              id: `${p.id}/ns/${namespace}/workflows/${saved.name}`,
              label: saved.name,
              icon: <Icon icon={Search} />,
              open: { kind: "temporal.workflows", params: { namespace, query: saved.query }, title: `${saved.name} · ${namespace}` },
            })),
          },
        ],
      },
    ];
  },
  tabKinds: {
    "temporal.workflows": {
      title: (params) => `Workflows · ${typeof params["namespace"] === "string" ? params["namespace"] : "default"}`,
      Component: WorkflowsTab,
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
