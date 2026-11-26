// `langgraph`: a LangGraph Studio-like UI for any LangGraph (Agent) Server (Mightyconsole spec
// §11, TSK-84). The browser talks only to mightyconsole-server, which calls the LangGraph Server
// API. Screens: assistants (graph, schemas, config), threads, a thread (run with live streaming,
// interrupts and resume; state; checkpoint history with fork and time travel), the store.
import { SecretControl } from "@/app/secret-control";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type * as api from "@/gen/api";
import { Braces, DatabaseMultiple, Flash, History } from "@/lib/icons";
import type { ProfileRecord } from "@/profiles/record";
import { type SiblingContext, type SiblingList, levelRoute, path, placeRoute } from "@/app/router";
import { viewOf } from "@/app/tab-view";
import type { ConnectionFormProps, ProfileSchema, ToolModule } from "../types";
import { ASSISTANT_VIEWS, AssistantsTab, AssistantTab } from "./assistants";
import { shortId } from "./shared";
import { StoreTab } from "./store";
import { THREAD_VIEWS, ThreadTab } from "./thread";
import { ThreadsTab } from "./threads";
import { LangGraphMark } from "../marks";

export const DEFAULT_URL = "http://127.0.0.1:2024";

const NOT_CONNECTED = "Connect the profile to list them.";
/** How many recent threads a thread segment lists beside it. */
export const RECENT_THREADS = 20;

/** The assistant segment's siblings: the server's assistants (DOC-21 §3.7). */
export async function assistantSiblings({ client, connId }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error(NOT_CONNECTED);
  const list = await client.langgraph.assistants.search({ connId, graphId: null, metadata: null, limit: 100, offset: null });
  return {
    heading: "Assistants",
    items: list.map((a) => ({ label: a.name || a.assistantId, description: a.graphId, params: { assistantId: a.assistantId } })),
    all: { label: "All assistants…", place: { kind: "langgraph.assistants", params: {} } },
  };
}

/** The thread segment's siblings: the most recently updated threads. */
export async function threadSiblings({ client, connId }: SiblingContext): Promise<SiblingList> {
  if (!connId) throw new Error(NOT_CONNECTED);
  const list = await client.langgraph.threads.search({ connId, metadata: null, status: null, limit: RECENT_THREADS, offset: null });
  return {
    heading: "Recent threads",
    items: list.map((t) => ({ label: shortId(t.threadId), description: t.status, params: { threadId: t.threadId } })),
    all: { label: "All threads…", place: { kind: "langgraph.threads", params: {} } },
  };
}

const text = (v: unknown) => (typeof v === "string" ? v : "");

/** `Name: value` lines (the extra headers; values are secrets). */
export function parseHeaderLines(lines: string): { headers: { name: string; value: string }[]; error?: string } {
  const headers: { name: string; value: string }[] = [];
  for (const [i, raw] of lines.split("\n").entries()) {
    const line = raw.trim();
    if (line === "") continue;
    const at = line.indexOf(":");
    if (at <= 0) return { headers, error: `Line ${i + 1} is not "Name: value".` };
    headers.push({ name: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  }
  return { headers };
}

/** The LangGraph profile (spec §11.1): `fields.url`, `fields.tls`; `secrets.apiKey`, `secrets.headerLines`, `secrets.clientKeyPem`; `extras.inputs`. */
export const profile: ProfileSchema = {
  version: 1,
  defaults: () => ({ fields: { url: DEFAULT_URL, headers: [], tls: { enabled: false } }, secrets: {}, extras: { inputs: [] } }),
  validate(record) {
    const errors: Record<string, string> = {};
    const url = text(record.fields["url"]).trim();
    if (url === "") errors["url"] = "The server's URL, e.g. http://127.0.0.1:2024.";
    else {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") errors["url"] = "The URL starts with http:// or https://.";
        else if (parsed.username || parsed.password) errors["url"] = "Put credentials in the API key or the headers, not in the URL.";
      } catch {
        errors["url"] = "Not a URL, e.g. http://127.0.0.1:2024.";
      }
    }
    const lines = record.secrets["headerLines"];
    if (typeof lines === "string") {
      const parsed = parseHeaderLines(lines);
      if (parsed.error) errors["headerLines"] = parsed.error;
    }
    return errors;
  },
  migrations: {},
};

function ConnectionForm({ fields, secrets, errors, onFields, onSecrets, disabled }: ConnectionFormProps) {
  const url = text(fields["url"]);
  const tls = (fields["tls"] ?? {}) as Record<string, unknown>;
  const setTls = (patch: Record<string, unknown>) => onFields({ tls: { ...tls, ...patch } });
  const https = url.trim().toLowerCase().startsWith("https://");
  return (
    <>
      <Field invalid={errors["url"] !== undefined}>
        <FieldLabel>Server URL</FieldLabel>
        <Input value={url} onValueChange={(v) => onFields({ url: v })} placeholder={DEFAULT_URL} disabled={disabled} />
        <FieldDescription>The LangGraph (Agent) Server: `langgraph dev` listens on {DEFAULT_URL}. Mightyconsole's server calls it; the browser never does.</FieldDescription>
        {errors["url"] ? <FieldError match>{errors["url"]}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel>API key</FieldLabel>
        <SecretControl secretKey="apiKey" noun="API key" value={text(secrets["apiKey"])} onValueChange={(v) => onSecrets({ apiKey: v })} disabled={disabled} />
        <FieldDescription>Sent as x-api-key when set.</FieldDescription>
      </Field>
      <Field invalid={errors["headerLines"] !== undefined}>
        <FieldLabel>Extra headers</FieldLabel>
        <SecretControl secretKey="headerLines" noun="headers" multiline rows={2} value={text(secrets["headerLines"])} onValueChange={(v) => onSecrets({ headerLines: v })} placeholder="Authorization: Bearer …" disabled={disabled} />
        <FieldDescription>One "Name: value" per line, for custom auth. Kept with the secrets.</FieldDescription>
        {errors["headerLines"] ? <FieldError match>{errors["headerLines"]}</FieldError> : null}
      </Field>
      {https ? (
        <>
          <Field>
            <FieldLabel>CA certificate (PEM)</FieldLabel>
            <Textarea value={text(tls["caPem"])} onValueChange={(v) => setTls({ caPem: v, enabled: true })} rows={3} placeholder="-----BEGIN CERTIFICATE-----" disabled={disabled} />
            <FieldDescription>Trust only this CA instead of the system's. Certificates are always verified.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Expected server name</FieldLabel>
            <Input value={text(tls["serverName"])} onValueChange={(v) => setTls({ serverName: v })} placeholder="When the certificate names another host" disabled={disabled} />
          </Field>
          <Field>
            <FieldLabel>Client certificate (PEM)</FieldLabel>
            <Textarea value={text(tls["clientCertPem"])} onValueChange={(v) => setTls({ clientCertPem: v })} rows={2} disabled={disabled} />
          </Field>
          <Field>
            <FieldLabel>Client key (PEM)</FieldLabel>
            <SecretControl secretKey="clientKeyPem" noun="private key" multiline rows={2} value={text(secrets["clientKeyPem"])} onValueChange={(v) => onSecrets({ clientKeyPem: v })} disabled={disabled} />
          </Field>
        </>
      ) : null}
    </>
  );
}

export const langgraphTool: ToolModule = {
  id: "langgraph",
  label: "LangGraph",
  icon: Flash,
  mark: LangGraphMark,
  category: "Workflows and agents",
  order: 60,
  description: "Assistants and their graphs, threads, runs with live streaming and interrupts, checkpoints and the store of any LangGraph server.",
  profile,
  ConnectionForm,
  sidebarTree: ({ profile: p }) => [
    { id: `${p.id}/assistants`, label: "Assistants", icon: <Icon icon={Braces} />, open: { kind: "langgraph.assistants", params: {}, title: `Assistants · ${p.name}` } },
    { id: `${p.id}/threads`, label: "Threads", icon: <Icon icon={History} />, open: { kind: "langgraph.threads", params: {}, title: `Threads · ${p.name}` } },
    { id: `${p.id}/store`, label: "Store", icon: <Icon icon={DatabaseMultiple} />, open: { kind: "langgraph.store", params: {}, title: `Store · ${p.name}` } },
  ],
  // DOC-21 §3.7: /langgraph/<profile>/assistants, …/assistants/<id>/<graph|schemas|config>,
  // …/threads, …/threads/<id>/<run|state|history>, …/store.
  // The tree that follows the tab (DOC-21 §3.2.1): an assistant or a thread under its list.
  nodeOfTab: ({ kind }, p) =>
    kind === "langgraph.assistants" || kind === "langgraph.assistant" ? [`${p.id}/assistants`] : kind === "langgraph.threads" || kind === "langgraph.thread" ? [`${p.id}/threads`] : kind === "langgraph.store" ? [`${p.id}/store`] : [],
  tabKinds: {
    "langgraph.assistants": { title: () => "Assistants", Component: AssistantsTab, href: () => ({ path: "assistants" }) },
    "langgraph.assistant": {
      title: (params) => `Assistant ${text(params["name"]) || text(params["assistantId"])}`,
      Component: AssistantTab,
      href: (p) => (text(p["assistantId"]) ? { path: path("assistants", text(p["assistantId"]), viewOf(p, ASSISTANT_VIEWS, "graph")) } : null),
    },
    "langgraph.threads": { title: () => "Threads", Component: ThreadsTab, href: () => ({ path: "threads" }) },
    "langgraph.thread": {
      title: (params) => `Thread ${text(params["threadId"]).slice(0, 8)}`,
      Component: ThreadTab,
      href: (p) => (text(p["threadId"]) ? { path: path("threads", text(p["threadId"]), viewOf(p, THREAD_VIEWS, "run")) } : null),
    },
    "langgraph.store": { title: () => "Store", Component: StoreTab, href: () => ({ path: "store" }) },
  },
  routes: (parent) => [
    placeRoute(parent, "assistants", "Assistants", () => ({ kind: "langgraph.assistants", params: {} }), {
      children: (assistants) => [
        levelRoute(
          assistants,
          "$assistantId",
          (p) => p["assistantId"] ?? "",
          (assistant) =>
            ASSISTANT_VIEWS.map((view) =>
              placeRoute(assistant, view, view === "config" ? "Config" : view.charAt(0).toUpperCase() + view.slice(1), (p) => ({ kind: "langgraph.assistant", params: { assistantId: p["assistantId"] ?? "", view } })),
            ),
          assistantSiblings,
        ),
      ],
    }),
    placeRoute(parent, "threads", "Threads", () => ({ kind: "langgraph.threads", params: {} }), {
      children: (threads) => [
        levelRoute(
          threads,
          "$threadId",
          (p) => shortId(p["threadId"] ?? ""),
          (thread) => THREAD_VIEWS.map((view) => placeRoute(thread, view, view.charAt(0).toUpperCase() + view.slice(1), (p) => ({ kind: "langgraph.thread", params: { threadId: p["threadId"] ?? "", view } }))),
          threadSiblings,
        ),
      ],
    }),
    placeRoute(parent, "store", "Store", () => ({ kind: "langgraph.store", params: {} })),
  ],
  actions: [],
  async connect(client, record) {
    const out = await client.langgraph.connect({ profileId: record.id });
    return { connId: out.connId };
  },
  async disconnect(client, connId) {
    await client.langgraph.disconnect({ connId });
  },
};
