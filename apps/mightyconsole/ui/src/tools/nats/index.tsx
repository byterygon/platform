// `nats`: NATS on the messaging core (Mightyconsole spec §6, TSK-85). This batch: the profile and
// its form, the Server screen, Subscribe (core NATS live tail) and Publish (publish and request,
// with the send history). JetStream, Key-Value, Object Store and Services follow in the next
// batches of TSK-85.
import { Icon } from "@/components/ui/icon";
import type { ConnectNatsProfile } from "@/gen/api";
import { ArrowUp, Flash, NumberSymbol, Server } from "@/lib/icons";
import { NatsMark } from "../marks";
import type { ResourceNode, ToolModule } from "../types";
import { ConnectionForm } from "./ConnectionForm";
import { PublishTab } from "./PublishTab";
import { ServerTab } from "./ServerTab";
import { SubscribeTab, subscribeTitle } from "./SubscribeTab";
import { bookmarksOf, profile } from "./profile";

export const natsTool: ToolModule = {
  id: "nats",
  label: "NATS",
  icon: Flash,
  mark: NatsMark,
  category: "Messaging",
  order: 10,
  description: "Subjects, request-reply and the server of a NATS system.",
  profile,
  ConnectionForm,
  // §6.2: Server · Subjects (bookmarks, "Subscribe to…") · Publish.
  sidebarTree({ profile: p }): readonly ResourceNode[] {
    const bookmarks = bookmarksOf(p.extras);
    return [
      { id: `${p.id}/server`, label: "Server", icon: <Icon icon={Server} />, open: { kind: "nats.server", params: {}, title: "Server" } },
      {
        id: `${p.id}/subjects`,
        label: "Subjects",
        icon: <Icon icon={NumberSymbol} />,
        expanded: true,
        ...(bookmarks.length > 0 ? { meta: <span className="text-caption-1 text-fg-muted">{bookmarks.length}</span> } : {}),
        children: [
          { id: `${p.id}/subjects/new`, label: "Subscribe to…", icon: <Icon icon={Flash} />, open: { kind: "nats.subscribe", params: { subjects: [] }, title: "Subscribe" } },
          ...bookmarks.map((s) => ({
            id: `${p.id}/subjects/${s}`,
            label: s,
            icon: <Icon icon={NumberSymbol} />,
            open: { kind: "nats.subscribe", params: { subjects: [s] }, title: subscribeTitle({ subjects: [s] }) },
          })),
        ],
      },
      { id: `${p.id}/publish`, label: "Publish", icon: <Icon icon={ArrowUp} />, open: { kind: "nats.publish", params: {}, title: "Publish" } },
    ];
  },
  tabKinds: {
    "nats.server": { title: () => "Server", Component: ServerTab },
    "nats.subscribe": { title: subscribeTitle, Component: SubscribeTab },
    "nats.publish": { title: (params) => (params["mode"] === "request" ? "Request" : "Publish"), Component: PublishTab },
  },
  actions: [
    {
      id: "subscribe",
      label: "Subscribe to subjects",
      keywords: ["nats", "tail", "live", "wildcard"],
      run({ openTab }) {
        openTab({ kind: "nats.subscribe", params: { subjects: [] }, title: "Subscribe" });
      },
    },
    {
      id: "publish",
      label: "Publish a message",
      keywords: ["nats", "send", "request", "reply"],
      run({ openTab }) {
        openTab({ kind: "nats.publish", params: {}, title: "Publish" });
      },
    },
  ],
  async connect(client, record) {
    const out = await client.nats.connect({ profile: profile.toConnect(record) as ConnectNatsProfile });
    return { connId: out.connId };
  },
  async disconnect(client, connId) {
    await client.nats.disconnect({ connId });
  },
};
