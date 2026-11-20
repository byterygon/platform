// `nats`: NATS on the messaging core (Mightyconsole spec §6, TSK-85): the profile and its form,
// the Server screen, Subscribe (core NATS live tail), Publish (publish and request, with the send
// history), and JetStream: the streams (list, Info, Messages, Consumers, the stream form, purge and
// delete) and their consumers (state, position bar, create, delete), and Key-Value (buckets, keys,
// a key's entry and history with revisions compared, put through the Composer, watch), Object
// Store (buckets, objects, upload in parts with progress, download, delete), Services
// (discovered with $SRV.INFO, STATS and PING) and Schemas (the messaging core's schemas and
// mappings of the profile, mappings tested on the last messages JetStream keeps).
import { Icon } from "@/components/ui/icon";
import type { ConnectNatsProfile } from "@/gen/api";
import { ArrowDownload, ArrowUp, Braces, Code, Database, Flash, Folder, NumberSymbol, PlugConnected, Server } from "@/lib/icons";
import { mappingsOf, schemasOf } from "@/messaging/schemas/model";
import { NatsMark } from "../marks";
import type { ResourceNode, ToolModule } from "../types";
import { ConnectionForm } from "./ConnectionForm";
import { ConsumerTab, consumerTitle } from "./ConsumerTab";
import { KvBucketsTab } from "./KvBuckets";
import { KvTab, kvTitle } from "./KvTab";
import { ObjectBucketsTab } from "./ObjectBuckets";
import { ObjectTab, objectTitle } from "./ObjectTab";
import { PublishTab } from "./PublishTab";
import { ServerTab } from "./ServerTab";
import { SchemasTab } from "./SchemasTab";
import { ServicesTab } from "./ServicesTab";
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

/** The Key-Value group: each bucket. */
function kvNode(profileId: string, connId: string): ResourceNode {
  const tree = treeDataOf(connId);
  const buckets = tree.buckets ?? [];
  return {
    id: `${profileId}/kv`,
    label: "Key-Value",
    icon: <Icon icon={Braces} />,
    expanded: true,
    ...(tree.buckets ? { meta: count(buckets.length) } : {}),
    open: { kind: "nats.kvs", params: {}, title: "Key-Value" },
    children: tree.error
      ? []
      : buckets.map((b) => ({ id: `${profileId}/kv/${b}`, label: b, icon: <Icon icon={Braces} />, open: { kind: "nats.kv", params: { bucket: b }, title: b } })),
  };
}

/** The Object Store group: each bucket. */
function objectsNode(profileId: string, connId: string): ResourceNode {
  const tree = treeDataOf(connId);
  const stores = tree.objectStores ?? [];
  return {
    id: `${profileId}/objects`,
    label: "Object Store",
    icon: <Icon icon={Folder} />,
    expanded: true,
    ...(tree.objectStores ? { meta: count(stores.length) } : {}),
    open: { kind: "nats.objects", params: {}, title: "Object Store" },
    children: tree.error
      ? []
      : stores.map((b) => ({ id: `${profileId}/objects/${b}`, label: b, icon: <Icon icon={Folder} />, open: { kind: "nats.object", params: { bucket: b }, title: b } })),
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
  // §6.2: Server · Subjects (bookmarks, "Subscribe to…") · Streams (each with its consumers) ·
  // Key-Value (buckets) · Object Store (buckets) · Services · Schemas · Publish.
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
      kvNode(p.id, connId),
      objectsNode(p.id, connId),
      { id: `${p.id}/services`, label: "Services", icon: <Icon icon={PlugConnected} />, open: { kind: "nats.services", params: {}, title: "Services" } },
      {
        id: `${p.id}/schemas`,
        label: "Schemas",
        icon: <Icon icon={Code} />,
        meta: <span className="text-caption-1 text-fg-muted">{schemasOf(p).length + mappingsOf(p).length > 0 ? `${schemasOf(p).length} · ${mappingsOf(p).length}` : ""}</span>,
        open: { kind: "nats.schemas", params: {}, title: "Schemas" },
      },
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
    "nats.kvs": { title: () => "Key-Value", Component: KvBucketsTab },
    "nats.kv": { title: kvTitle, Component: KvTab },
    "nats.objects": { title: () => "Object Store", Component: ObjectBucketsTab },
    "nats.object": { title: objectTitle, Component: ObjectTab },
    "nats.services": { title: () => "Services", Component: ServicesTab },
    "nats.schemas": { title: () => "Schemas", Component: SchemasTab },
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
      id: "kv",
      label: "Show the KV buckets",
      keywords: ["nats", "key-value", "kv", "bucket"],
      run({ openTab }) {
        openTab({ kind: "nats.kvs", params: {}, title: "Key-Value" });
      },
    },
    {
      id: "create-kv",
      label: "Create a KV bucket",
      keywords: ["nats", "key-value", "kv", "new bucket"],
      run({ openTab }) {
        openTab({ kind: "nats.kvs", params: { create: true }, title: "Key-Value" });
      },
    },
    {
      id: "objects",
      label: "Show the object stores",
      keywords: ["nats", "object store", "files", "bucket", "upload"],
      run({ openTab }) {
        openTab({ kind: "nats.objects", params: {}, title: "Object Store" });
      },
    },
    {
      id: "create-object-store",
      label: "Create an object store",
      keywords: ["nats", "object store", "new bucket"],
      run({ openTab }) {
        openTab({ kind: "nats.objects", params: { create: true }, title: "Object Store" });
      },
    },
    {
      id: "services",
      label: "Discover the services",
      keywords: ["nats", "micro", "service", "$SRV", "ping", "stats"],
      run({ openTab }) {
        openTab({ kind: "nats.services", params: {}, title: "Services" });
      },
    },
    {
      id: "schemas",
      label: "Manage schemas and mappings",
      keywords: ["nats", "decode", "codec", "protobuf", "avro", "json schema", "cbor", "mapping"],
      run({ openTab }) {
        openTab({ kind: "nats.schemas", params: {}, title: "Schemas" });
      },
    },
    {
      id: "add-schema",
      label: "Add a schema",
      keywords: ["nats", "protobuf", "proto", "avro", "json schema", "descriptor"],
      run({ openTab }) {
        openTab({ kind: "nats.schemas", params: { create: "schema" }, title: "Schemas" });
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
