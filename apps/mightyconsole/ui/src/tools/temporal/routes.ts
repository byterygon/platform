// Temporal's places in the URL (DOC-21 §3.7), under /temporal/<profile name>/:
//
//   namespaces                                     the cluster's namespaces
//   <namespace>/workflows?q=<query>                a namespace's workflows (a query up to 200 characters)
//   <namespace>/workflows/<workflow id>/<view>?run=<run id>
//                                                  a workflow at a section: timeline, history, relations, input,
//                                                  pending, queries, stack
//   <namespace>/schedules                          schedules
//   <namespace>/schedules/<schedule id>/overview   a schedule
//   <namespace>/task-queues                        task queues
//   <namespace>/task-queues/<name>/overview        a task queue
//   <namespace>/workers                            workers
import type { AnyRoute } from "@tanstack/react-router";
import { type SiblingContext, type SiblingList, levelRoute, path, placeRoute, shortSearch, str, stringSearch } from "@/app/router";
import { viewOf } from "@/app/tab-view";
import type { PlaceHref } from "../types";
import { namespaceOf } from "./profile";
import { orderNamespaces } from "./tree-data";
import { WORKFLOW_VIEWS } from "./WorkflowTab";

const NOT_CONNECTED = "Connect the profile to list them.";
/** How many recent workflows a workflow segment lists beside it. */
export const RECENT_WORKFLOWS = 20;

/** The namespace segment's siblings: the cluster's namespaces (DOC-21 §3.7). */
export async function namespaceSiblings({ profile, client, connId }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error(NOT_CONNECTED);
  const list = await client.temporal.namespaces.list({ connId });
  return {
    heading: `Namespaces of ${profile.name}`,
    items: orderNamespaces(list.map((n) => n.name), namespaceOf(profile)).map((name) => ({ label: name, params: { namespace: name } })),
    all: { label: "All namespaces…", place: { kind: "temporal.namespaces", params: {} } },
  };
}

/** The workflow segment's siblings: the namespace's most recent workflows; the run is dropped. */
export async function workflowSiblings({ params, client, connId }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error(NOT_CONNECTED);
  const namespace = params["namespace"] ?? "default";
  const out = await client.temporal.workflows.list({ connId, namespace, query: null, pageSize: RECENT_WORKFLOWS, nextPageToken: null });
  const seen = new Set<string>();
  const items = out.executions.filter((w) => !seen.has(w.workflowId) && seen.add(w.workflowId));
  return {
    heading: `Recent workflows in ${namespace}`,
    items: items.map((w) => ({ label: w.workflowId, description: w.status, params: { workflowId: w.workflowId }, search: { run: undefined } })),
    all: { label: "All workflows…", place: { kind: "temporal.workflows", params: { namespace, query: "" } } },
  };
}

const nsOf = (params: Record<string, unknown>) => str(params["namespace"]) || "default";

/** Each tab kind's URL. */
export const temporalHrefs: Record<string, (params: Record<string, unknown>) => PlaceHref | null> = {
  "temporal.namespaces": () => ({ path: "namespaces" }),
  "temporal.workers": (p) => ({ path: path(nsOf(p), "workers") }),
  "temporal.workflows": (p) => {
    const q = shortSearch(p["query"]);
    return { path: path(nsOf(p), "workflows"), ...(q ? { search: { q } } : {}) };
  },
  "temporal.workflow": (p) => {
    const workflowId = str(p["workflowId"]);
    if (!workflowId) return null;
    const run = str(p["runId"]);
    return { path: path(nsOf(p), "workflows", workflowId, viewOf(p, WORKFLOW_VIEWS, "timeline")), ...(run ? { search: { run } } : {}) };
  },
  "temporal.schedules": (p) => ({ path: path(nsOf(p), "schedules") }),
  "temporal.schedule": (p) => (str(p["scheduleId"]) ? { path: path(nsOf(p), "schedules", str(p["scheduleId"]), "overview") } : null),
  "temporal.taskQueue": (p) => (str(p["name"]) ? { path: path(nsOf(p), "task-queues", str(p["name"]), "overview") } : { path: path(nsOf(p), "task-queues") }),
};

const VIEW_LABELS: Record<(typeof WORKFLOW_VIEWS)[number], string> = {
  timeline: "Timeline",
  history: "History",
  relations: "Relations",
  input: "Input and result",
  pending: "Pending",
  queries: "Queries",
  stack: "Stack trace",
};

/** The routes giving those places back. */
export function temporalRoutes(parent: AnyRoute): AnyRoute[] {
  const ns = (p: Record<string, string>) => p["namespace"] ?? "default";
  return [
    placeRoute(parent, "namespaces", "Namespaces", () => ({ kind: "temporal.namespaces", params: {} })),
    levelRoute(parent, "$namespace", ns, (namespace) => [
      placeRoute(namespace, "workers", "Workers", (p) => ({ kind: "temporal.workers", params: { namespace: ns(p) } })),
      placeRoute(namespace, "workflows", "Workflows", (p, search) => ({ kind: "temporal.workflows", params: { namespace: ns(p), query: str(search["q"]) } }), {
        validateSearch: stringSearch("q"),
        children: (workflows) => [
          levelRoute(
            workflows,
            "$workflowId",
            (p) => p["workflowId"] ?? "",
            (workflow) =>
              WORKFLOW_VIEWS.map((view) =>
                placeRoute(
                  workflow,
                  view,
                  VIEW_LABELS[view],
                  (p, search) => ({ kind: "temporal.workflow", params: { namespace: ns(p), workflowId: p["workflowId"] ?? "", ...(search["run"] ? { runId: str(search["run"]) } : {}), view } }),
                  { validateSearch: stringSearch("run") },
                ),
              ),
            workflowSiblings,
          ),
        ],
      }),
      placeRoute(namespace, "schedules", "Schedules", (p) => ({ kind: "temporal.schedules", params: { namespace: ns(p) } }), {
        children: (schedules) => [
          levelRoute(schedules, "$scheduleId", (p) => p["scheduleId"] ?? "", (schedule) => [
            placeRoute(schedule, "overview", "Overview", (p) => ({ kind: "temporal.schedule", params: { namespace: ns(p), scheduleId: p["scheduleId"] ?? "" } })),
          ]),
        ],
      }),
      placeRoute(namespace, "task-queues", "Task queues", (p) => ({ kind: "temporal.taskQueue", params: { namespace: ns(p), name: "" } }), {
        children: (queues) => [
          levelRoute(queues, "$name", (p) => p["name"] ?? "", (queue) => [
            placeRoute(queue, "overview", "Overview", (p) => ({ kind: "temporal.taskQueue", params: { namespace: ns(p), name: p["name"] ?? "" } })),
          ]),
        ],
      }),
    ], namespaceSiblings),
  ];
}
