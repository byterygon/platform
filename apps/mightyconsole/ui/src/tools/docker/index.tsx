// `docker`: Docker over SSH (Mightyconsole spec §10, TSK-81), a Portainer-like view of a host the
// server reaches through SSH with nothing installed on it. Batch 1: the SSH host profile and its
// form, trust on first use of the host key (the shell's HostKeyDialog through `trustHostKey`), and
// the Host page. Batch 2b: the Containers list, live through `docker.events`, and a container's
// Overview, Logs and Inspect; the tree groups the containers by Compose project (spec §10.4).
// Batch 2c: the container's Stats and Terminal (exec). Batch 3: Images, Volumes and Networks, each
// a list with Inspect (a sheet) and Remove. Batch 4: the tree's counts, the Host page's disk usage
// and events, a container's Processes.
import type { AnyRoute } from "@tanstack/react-router";
import { Icon } from "@/components/ui/icon";
import { type SiblingContext, type SiblingList, levelRoute, path, placeRoute, str } from "@/app/router";
import { viewOf } from "@/app/tab-view";
import type { ConnectDockerProfile, ContainerRow } from "@/gen/api";
import { BoxMultiple, Cube, Globe, HardDrive, Image, Server, Stack } from "@/lib/icons";
import type { ResourceNode, ToolModule } from "../types";
import { CONTAINER_VIEWS, ContainerTab } from "./ContainerTab";
import { ContainersTab } from "./ContainersTab";
import { ConnectionForm } from "./ConnectionForm";
import { byStateThenName, groupByProject, stateLabel } from "./format";
import { HostTab } from "./HostTab";
import { ImagesTab } from "./ImagesTab";
import { NetworksTab } from "./NetworksTab";
import { profile, targetOf, trustHostKey } from "./profile";
import { PROJECT_VIEWS, ProjectTab } from "./ProjectTab";
import { dockerTreeData, treeContainersOf, treeCountsOf } from "./tree-data";
import { VolumesTab } from "./VolumesTab";

const VIEW_LABELS: Record<(typeof CONTAINER_VIEWS)[number], string> = { overview: "Overview", logs: "Logs", stats: "Stats", terminal: "Terminal", files: "Files", inspect: "Inspect" };
const PROJECT_VIEW_LABELS: Record<(typeof PROJECT_VIEWS)[number], string> = { logs: "Logs", containers: "Containers" };

/** A container's tree node: it opens the container's Overview. */
function containerNode(profileId: string, row: ContainerRow, label = row.name): ResourceNode {
  const stopped = row.state !== "running";
  return {
    id: `${profileId}/containers/${row.name}`,
    label,
    icon: <Icon icon={Cube} />,
    ...(stopped ? { meta: <span className="text-caption-1 text-fg-muted">{stateLabel(row.state)}</span> } : {}),
    open: { kind: "docker.container", params: { id: row.name, view: "overview" }, title: row.name },
  };
}

/** The containers under the tree's Containers: a folder per Compose project, then the others. */
export function containersTree(profileId: string, rows: readonly ContainerRow[]): ResourceNode[] {
  return groupByProject(rows).flatMap((group): ResourceNode[] => {
    if (group.project === null) return group.rows.map((r) => containerNode(profileId, r));
    const up = group.rows.filter((r) => r.state === "running").length;
    return [
      {
        id: `${profileId}/projects/${group.project}`,
        label: group.project,
        icon: <Icon icon={Stack} />,
        meta: <span className="text-caption-1 text-fg-muted">{up === group.rows.length ? up : `${up}/${group.rows.length}`}</span>,
        // Double-click opens the project's merged logs (batch 4b).
        open: { kind: "docker.project", params: { project: group.project, view: "logs" }, title: group.project },
        children: group.rows.map((r) => containerNode(profileId, r, r.service && group.rows.filter((o) => o.service === r.service).length === 1 ? r.service : r.name)),
      },
    ];
  });
}

/** The container segment's siblings: the host's containers, running first. */
async function containerSiblings({ client, connId, profile: p }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error("Connect the profile to list them.");
  const rows = [...(await client.docker.containers.list({ connId, all: true }))].sort(byStateThenName);
  return {
    heading: `Containers on ${p.name}`,
    items: rows.map((r) => ({ label: r.name, description: stateLabel(r.state), params: { container: r.name } })),
    all: { label: "All containers…", place: { kind: "docker.containers", params: {} } },
  };
}

/** The project segment's siblings: the host's Compose projects. */
async function projectSiblings({ client, connId, profile: p }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error("Connect the profile to list them.");
  const projects = await client.docker.compose.projects({ connId });
  return {
    heading: `Compose projects on ${p.name}`,
    items: projects.map((pr) => ({ label: pr.project, description: `${pr.services.length} ${pr.services.length === 1 ? "service" : "services"}`, params: { project: pr.project } })),
    all: { label: "All containers…", place: { kind: "docker.containers", params: {} } },
  };
}

export const dockerTool: ToolModule = {
  id: "docker",
  label: "Docker",
  // Docker's trademark guidelines need written approval for the whale in software, so Docker
  // keeps Fluent's box-multiple (DOC-21 Open question 45 (e)).
  icon: BoxMultiple,
  category: "Infrastructure",
  order: 40,
  description: "Containers, images, volumes and networks of a Docker host, over SSH.",
  profile,
  ConnectionForm,
  sidebarTree({ profile: p, connId }): readonly ResourceNode[] {
    const rows = treeContainersOf(connId);
    const counts = treeCountsOf(connId);
    const countMeta = (n: number | undefined) => (n === undefined ? {} : { meta: <span className="text-caption-1 text-fg-muted">{n}</span> });
    const up = rows?.filter((r) => r.state === "running").length ?? 0;
    return [
      {
        id: `${p.id}/containers`,
        label: "Containers",
        icon: <Icon icon={BoxMultiple} />,
        ...(rows ? { meta: <span className="text-caption-1 text-fg-muted">{`${rows.length} · ${up} up`}</span> } : {}),
        open: { kind: "docker.containers", params: {}, title: `Containers · ${p.name}` },
        ...(rows && rows.length > 0 ? { children: containersTree(p.id, rows), expanded: true } : {}),
      },
      {
        id: `${p.id}/images`,
        label: "Images",
        ...countMeta(counts.images),
        icon: <Icon icon={Image} />,
        open: { kind: "docker.images", params: {}, title: `Images · ${p.name}` },
      },
      {
        id: `${p.id}/volumes`,
        label: "Volumes",
        ...countMeta(counts.volumes),
        icon: <Icon icon={HardDrive} />,
        open: { kind: "docker.volumes", params: {}, title: `Volumes · ${p.name}` },
      },
      {
        id: `${p.id}/networks`,
        label: "Networks",
        ...countMeta(counts.networks),
        icon: <Icon icon={Globe} />,
        open: { kind: "docker.networks", params: {}, title: `Networks · ${p.name}` },
      },
      {
        id: `${p.id}/host`,
        label: "Host",
        icon: <Icon icon={Server} />,
        open: { kind: "docker.host", params: {}, title: `Host · ${p.name}` },
      },
    ];
  },
  sidebarData: dockerTreeData,
  // DOC-21 §3.7: /docker/<profile>/containers, …/containers/<name>/<view>,
  // …/projects/<project>/<view>, …/images, …/volumes, …/networks, …/host.
  // The tree that follows the tab (DOC-21 §3.2.1): a container wherever the tree draws it (under
  // its Compose project or not; the shell finds it), a project under Containers.
  nodeOfTab: ({ kind, params }, p) => {
    const name = (key: string) => (typeof params[key] === "string" ? (params[key] as string) : "");
    switch (kind) {
      case "docker.container":
        return [`${p.id}/containers`, `${p.id}/containers/${name("id")}`];
      case "docker.project":
        return [`${p.id}/containers`, `${p.id}/projects/${name("project")}`];
      case "docker.containers":
        return [`${p.id}/containers`];
      case "docker.images":
        return [`${p.id}/images`];
      case "docker.volumes":
        return [`${p.id}/volumes`];
      case "docker.networks":
        return [`${p.id}/networks`];
      case "docker.host":
        return [`${p.id}/host`];
      default:
        return [];
    }
  },
  tabKinds: {
    "docker.containers": {
      title: () => "Containers",
      Component: ContainersTab,
      href: () => ({ path: "containers" }),
    },
    "docker.container": {
      title: (params) => str(params["id"]) || "Container",
      Component: ContainerTab,
      href: (params) => (str(params["id"]) ? { path: path("containers", str(params["id"]), viewOf(params, CONTAINER_VIEWS, "overview")) } : null),
    },
    "docker.project": {
      title: (params) => str(params["project"]) || "Project",
      Component: ProjectTab,
      href: (params) => (str(params["project"]) ? { path: path("projects", str(params["project"]), viewOf(params, PROJECT_VIEWS, "logs")) } : null),
    },
    "docker.images": {
      title: () => "Images",
      Component: ImagesTab,
      href: () => ({ path: "images" }),
    },
    "docker.volumes": {
      title: () => "Volumes",
      Component: VolumesTab,
      href: () => ({ path: "volumes" }),
    },
    "docker.networks": {
      title: () => "Networks",
      Component: NetworksTab,
      href: () => ({ path: "networks" }),
    },
    "docker.host": {
      title: () => "Host",
      Component: HostTab,
      href: () => ({ path: "host" }),
    },
  },
  routes: (parent: AnyRoute) => [
    placeRoute(parent, "containers", "Containers", () => ({ kind: "docker.containers", params: {} }), {
      children: (containers) => [
        levelRoute(
          containers,
          "$container",
          (p) => p["container"] ?? "",
          (container) => CONTAINER_VIEWS.map((view) => placeRoute(container, view, VIEW_LABELS[view], (p) => ({ kind: "docker.container", params: { id: p["container"] ?? "", view } }))),
          containerSiblings,
        ),
      ],
    }),
    // The Projects crumb opens the containers, grouped by project.
    placeRoute(parent, "projects", "Projects", () => ({ kind: "docker.containers", params: {} }), {
      children: (projects) => [
        levelRoute(
          projects,
          "$project",
          (p) => p["project"] ?? "",
          (project) => PROJECT_VIEWS.map((view) => placeRoute(project, view, PROJECT_VIEW_LABELS[view], (p) => ({ kind: "docker.project", params: { project: p["project"] ?? "", view } }))),
          projectSiblings,
        ),
      ],
    }),
    placeRoute(parent, "images", "Images", () => ({ kind: "docker.images", params: {} })),
    placeRoute(parent, "volumes", "Volumes", () => ({ kind: "docker.volumes", params: {} })),
    placeRoute(parent, "networks", "Networks", () => ({ kind: "docker.networks", params: {} })),
    placeRoute(parent, "host", "Host", () => ({ kind: "docker.host", params: {} })),
  ],
  actions: [],
  async connect(client, record) {
    const out = await client.docker.connect({ profile: profile.toConnect(record) as ConnectDockerProfile });
    return { connId: out.connId };
  },
  async disconnect(client, connId) {
    await client.docker.disconnect({ connId });
  },
  trustHostKey,
  targetOf,
};
