// NATS's places in the URL (DOC-21 §3.7, TSK-85), under /nats/<profile name>/:
//
//   server                                        the Server screen
//   subscribe?subjects=<a b>&queue=<group>        Subscribe (subjects joined by spaces, which a subject never holds)
//   publish, request                              Publish, in its two modes (the form stays in the tab)
//   streams                                       the streams
//   streams/<stream>/<view>                       a stream at a view: info, messages, consumers
//   streams/<stream>/consumers/<consumer>/overview
//                                                 a consumer
//   kv                                            the KV buckets
//   kv/<bucket>/<view>                            a bucket at a view: keys, watch
//   objects                                       the object stores
//   objects/<bucket>/objects                      an object store's objects
//   services, schemas                             Services and Schemas
//
// Every place ends with a view word, so a subject or a stream like `orders.created` never ends a URL
// and never looks like a file name. No payload, header or form value goes into a URL.
import type { AnyRoute } from "@tanstack/react-router";
import { type SiblingContext, type SiblingList, SEARCH_MAX, levelRoute, path, placeRoute, shortSearch, str, stringSearch } from "@/app/router";
import { viewOf } from "@/app/tab-view";
import type { PlaceHref } from "../types";
import { KV_VIEWS } from "./KvTab";
import { STREAM_VIEWS } from "./StreamTab";
import { isBackingStream } from "./tree-data";

const NOT_CONNECTED = "Connect the profile to list them.";

/** The stream segment's siblings: the profile's streams (KV and object store backing streams left out). */
export async function streamSiblings({ profile, client, connId }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error(NOT_CONNECTED);
  const list = await client.nats.js.streams.list({ connId, subject: null });
  return {
    heading: `Streams of ${profile.name}`,
    items: list.filter((s) => !isBackingStream(s)).map((s) => ({ label: s.name, params: { stream: s.name } })),
    all: { label: "All streams…", place: { kind: "nats.streams", params: {} } },
  };
}

/** The consumer segment's siblings: the stream's consumers. */
export async function consumerSiblings({ params, client, connId }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error(NOT_CONNECTED);
  const stream = params["stream"] ?? "";
  const list = await client.nats.js.consumers.list({ connId, stream });
  return {
    heading: `Consumers of ${stream}`,
    items: list.map((c) => ({ label: c.name, params: { consumer: c.name } })),
    all: { label: "All consumers…", place: { kind: "nats.stream", params: { stream, view: "consumers" } } },
  };
}

/** A KV bucket segment's siblings: the profile's buckets. */
export async function kvSiblings({ profile, client, connId }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error(NOT_CONNECTED);
  const list = await client.nats.kv.buckets.list({ connId });
  return {
    heading: `KV buckets of ${profile.name}`,
    items: list.map((b) => ({ label: b.bucket, params: { bucket: b.bucket } })),
    all: { label: "All buckets…", place: { kind: "nats.kvs", params: {} } },
  };
}

/** An object store segment's siblings: the profile's object stores. */
export async function objectStoreSiblings({ profile, client, connId }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error(NOT_CONNECTED);
  const list = await client.nats.obj.buckets.list({ connId });
  return {
    heading: `Object stores of ${profile.name}`,
    items: list.map((b) => ({ label: b.bucket, params: { bucket: b.bucket } })),
    all: { label: "All object stores…", place: { kind: "nats.objects", params: {} } },
  };
}

/** Subscribe's subjects as one search value, or nothing when they would not fit. */
function subjectsSearch(value: unknown): string | undefined {
  const subjects = Array.isArray(value) ? value.filter((s): s is string => typeof s === "string" && s !== "") : [];
  const joined = subjects.join(" ");
  return joined.length <= SEARCH_MAX ? shortSearch(joined) : undefined;
}

/** Each tab kind's URL. */
export const natsHrefs: Record<string, (params: Record<string, unknown>) => PlaceHref | null> = {
  "nats.server": () => ({ path: "server" }),
  "nats.subscribe": (p) => {
    const subjects = subjectsSearch(p["subjects"]);
    const queue = shortSearch(p["queueGroup"]);
    const search = { ...(subjects ? { subjects } : {}), ...(subjects && queue ? { queue } : {}) };
    return { path: "subscribe", ...(Object.keys(search).length > 0 ? { search } : {}) };
  },
  "nats.publish": (p) => ({ path: p["mode"] === "request" ? "request" : "publish" }),
  "nats.streams": () => ({ path: "streams" }),
  "nats.stream": (p) => {
    const stream = str(p["stream"]);
    if (!stream) return null;
    // Tabs saved before the routes kept the view as `section`.
    const view = viewOf(p, STREAM_VIEWS, viewOf({ view: p["section"] }, STREAM_VIEWS, "info"));
    return { path: path("streams", stream, view) };
  },
  "nats.consumer": (p) => (str(p["stream"]) && str(p["consumer"]) ? { path: path("streams", str(p["stream"]), "consumers", str(p["consumer"]), "overview") } : null),
  "nats.kvs": () => ({ path: "kv" }),
  "nats.kv": (p) => {
    const bucket = str(p["bucket"]);
    if (!bucket) return null;
    return { path: path("kv", bucket, viewOf(p, KV_VIEWS, viewOf({ view: p["section"] }, KV_VIEWS, "keys"))) };
  },
  "nats.objects": () => ({ path: "objects" }),
  "nats.object": (p) => (str(p["bucket"]) ? { path: path("objects", str(p["bucket"]), "objects") } : null),
  "nats.services": () => ({ path: "services" }),
  "nats.schemas": () => ({ path: "schemas" }),
};

const STREAM_VIEW_LABELS: Record<(typeof STREAM_VIEWS)[number], string> = { info: "Info", messages: "Messages", consumers: "Consumers" };
const KV_VIEW_LABELS: Record<(typeof KV_VIEWS)[number], string> = { keys: "Keys", watch: "Watch" };

/** The routes giving those places back. */
export function natsRoutes(parent: AnyRoute): AnyRoute[] {
  const stream = (p: Record<string, string>) => p["stream"] ?? "";
  const bucket = (p: Record<string, string>) => p["bucket"] ?? "";
  return [
    placeRoute(parent, "server", "Server", () => ({ kind: "nats.server", params: {} })),
    placeRoute(
      parent,
      "subscribe",
      "Subscribe",
      (_p, search) => {
        const subjects = str(search["subjects"]).split(" ").filter((s) => s !== "");
        const queue = subjects.length > 0 ? str(search["queue"]) : "";
        return { kind: "nats.subscribe", params: { subjects, ...(queue ? { queueGroup: queue } : {}) } };
      },
      { validateSearch: stringSearch("subjects", "queue") },
    ),
    placeRoute(parent, "publish", "Publish", () => ({ kind: "nats.publish", params: {} })),
    placeRoute(parent, "request", "Request", () => ({ kind: "nats.publish", params: { mode: "request" } })),
    placeRoute(parent, "streams", "Streams", () => ({ kind: "nats.streams", params: {} }), {
      children: (streams) => [
        levelRoute(
          streams,
          "$stream",
          stream,
          (level) =>
            STREAM_VIEWS.map((view) =>
              placeRoute(level, view, STREAM_VIEW_LABELS[view], (p) => ({ kind: "nats.stream", params: { stream: stream(p), view } }), {
                ...(view === "consumers"
                  ? {
                      children: (consumers: AnyRoute) => [
                        levelRoute(
                          consumers,
                          "$consumer",
                          (p) => p["consumer"] ?? "",
                          (consumer) => [placeRoute(consumer, "overview", "Overview", (p) => ({ kind: "nats.consumer", params: { stream: stream(p), consumer: p["consumer"] ?? "" } }))],
                          consumerSiblings,
                        ),
                      ],
                    }
                  : {}),
              }),
            ),
          streamSiblings,
        ),
      ],
    }),
    placeRoute(parent, "kv", "Key-Value", () => ({ kind: "nats.kvs", params: {} }), {
      children: (kv) => [
        levelRoute(kv, "$bucket", bucket, (level) => KV_VIEWS.map((view) => placeRoute(level, view, KV_VIEW_LABELS[view], (p) => ({ kind: "nats.kv", params: { bucket: bucket(p), view } }))), kvSiblings),
      ],
    }),
    placeRoute(parent, "objects", "Object Store", () => ({ kind: "nats.objects", params: {} }), {
      children: (objects) => [levelRoute(objects, "$bucket", bucket, (level) => [placeRoute(level, "objects", "Objects", (p) => ({ kind: "nats.object", params: { bucket: bucket(p) } }))], objectStoreSiblings)],
    }),
    placeRoute(parent, "services", "Services", () => ({ kind: "nats.services", params: {} })),
    placeRoute(parent, "schemas", "Schemas", () => ({ kind: "nats.schemas", params: {} })),
  ];
}
