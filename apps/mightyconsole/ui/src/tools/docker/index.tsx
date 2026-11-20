// `docker`: Docker over SSH (Mightyconsole spec §10, TSK-81), a Portainer-like view of a host the
// server reaches through SSH with nothing installed on it. This batch: the SSH host profile and
// its form, trust on first use of the host key (the shell's HostKeyDialog through
// `trustHostKey`), and the Host page. Containers, images, volumes, networks and Compose projects
// join the tree in the next batches.
import { Icon } from "@/components/ui/icon";
import { placeRoute } from "@/app/router";
import type { ConnectDockerProfile } from "@/gen/api";
import { BoxMultiple, Server } from "@/lib/icons";
import type { ResourceNode, ToolModule } from "../types";
import { ConnectionForm } from "./ConnectionForm";
import { HostTab } from "./HostTab";
import { profile, targetOf, trustHostKey } from "./profile";

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
  sidebarTree({ profile: p }): readonly ResourceNode[] {
    return [
      {
        id: `${p.id}/host`,
        label: "Host",
        icon: <Icon icon={Server} />,
        open: { kind: "docker.host", params: {}, title: `Host · ${p.name}` },
      },
    ];
  },
  // DOC-21 §3.7: /docker/<profile>/host.
  tabKinds: {
    "docker.host": {
      title: () => "Host",
      Component: HostTab,
      href: () => ({ path: "host" }),
    },
  },
  routes: (parent) => [placeRoute(parent, "host", "Host", () => ({ kind: "docker.host", params: {} }))],
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
