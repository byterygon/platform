// `nats`: NATS on the messaging core (Mightyconsole spec §6, TSK-85): the profile and its form,
// the Server screen, Subscribe (core NATS live tail), Publish (publish and request, with the send
// history), and JetStream: the streams (list, Info, Messages, Consumers, the stream form, purge and
// delete) and their consumers (state, position bar, create, delete). Key-Value, Object Store and
// Services follow in the next batches of TSK-85.
import { Icon } from "@/components/ui/icon";
import type { ConnectNatsProfile } from "@/gen/api";
import { ArrowDownload, ArrowUp, Database, Flash, NumberSymbol, Server } from "@/lib/icons";
import { NatsMark } from "../marks";
import type { ResourceNode, ToolModule } from "../types";
import { ConnectionForm } from "./ConnectionForm";
import { ConsumerTab, consumerTitle } from "./ConsumerTab";
import { PublishTab } from "./PublishTab";
import { ServerTab } from "./ServerTab";
import { StreamTab, streamTitle } from "./StreamTab";
import { StreamsTab } from "./StreamsTab";
import { SubscribeTab, subscribeTitle } from "./SubscribeTab";
import { bookmarksOf, profile } from "./profile";
import { TREE_CONSUMER_STREAMS, natsTreeData, treeDataOf } from "./tree-data";

const count = (n: number) => <span className="text-caption-1 text-fg-muted">{n}</span>;

/** The Streams group: each stream with its consumers (the first streams), or why there are none. */
function streamsNode(profileId: string, connId: string): ResourceNode {
  const tree = treeDataOf(connId);
  const streams = tree.streams ?? [];
  return {
    id: `${profileId}/streams`,
    label: "Streams",
    icon: <Icon icon={Database} />,
    expanded: true,
    ...(tree.streams ? { meta: count(streams.length) } : {}),
    open: { kind: "nats.streams", params: {}, title: "Streams" },
    children: tree.error
      ? [{ id: `${profileId}/streams/error`, label: tree.error, icon: <Icon icon={Database} /> }]
      : streams.map((s, i) => {
          const consumers = tree.consumers[s.name] ?? [];
          return {
            id: `${profileId}/streams/${s.name}`,
            label: s.name,
            icon: <Icon icon={Database} />,
            ...(s.consumers > 0 ? { meta: count(s.consumers) } : {}),
            open: { kind: "nats.stream", params: { stream: s.name }, title: s.name },
            ...(i < TREE_CONSUMER_STREAMS && consumers.length > 0
              ? {
                  children: consumers.map((c) => ({
                    id: `${profileId}/streams/${s.name}/${c}`,
                    label: c,
                    icon: <Icon icon={ArrowDownload} />,
                    open: { kind: "nats.consumer", params: { stream: s.name, consumer: c }, title: c },
                  })),
                }
              : {}),
          };
        }),
  };
}

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
  // §6.2: Server · Subjects (bookmarks, "Subscribe to…") · Streams (each with its consumers) · Publish.
  sidebarTree({ profile: p, connId }): readonly ResourceNode[] {
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
      streamsNode(p.id, connId),
      { id: `${p.id}/publish`, label: "Publish", icon: <Icon icon={ArrowUp} />, open: { kind: "nats.publish", params: {}, title: "Publish" } },
    ];
  },
  sidebarData: natsTreeData,
  tabKinds: {
    "nats.server": { title: () => "Server", Component: ServerTab },
    "nats.subscribe": { title: subscribeTitle, Component: SubscribeTab },
    "nats.publish": { title: (params) => (params["mode"] === "request" ? "Request" : "Publish"), Component: PublishTab },
    "nats.streams": { title: () => "Streams", Component: StreamsTab },
    "nats.stream": { title: streamTitle, Component: StreamTab },
    "nats.consumer": { title: consumerTitle, Component: ConsumerTab },
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
      id: "streams",
      label: "Show the JetStream streams",
      keywords: ["nats", "jetstream", "stream", "consumer"],
      run({ openTab }) {
        openTab({ kind: "nats.streams", params: {}, title: "Streams" });
      },
    },
    {
      id: "create-stream",
      label: "Create a stream",
      keywords: ["nats", "jetstream", "new stream"],
      run({ openTab }) {
        openTab({ kind: "nats.streams", params: { create: true }, title: "Streams" });
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
