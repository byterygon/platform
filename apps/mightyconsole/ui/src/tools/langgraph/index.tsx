// `langgraph`: a LangGraph Studio-like UI for any LangGraph (Agent) Server (Mightyconsole spec
// §11, TSK-84). The browser talks only to mightyconsole-server, which calls the LangGraph Server
// API. Screens: assistants (graph, schemas, config), threads, a thread (run with live streaming,
// interrupts and resume; state; checkpoint history with fork and time travel), the store.
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Textarea } from "@/components/ui/textarea";
import type * as api from "@/gen/api";
import { Braces, DatabaseMultiple, Flash, History } from "@/lib/icons";
import type { ProfileRecord } from "@/profiles/record";
import type { ConnectionFormProps, ProfileSchema, ToolModule } from "../types";
import { AssistantsTab, AssistantTab } from "./assistants";
import { StoreTab } from "./store";
import { ThreadTab } from "./thread";
import { ThreadsTab } from "./threads";
import { LangGraphMark } from "../marks";

export const DEFAULT_URL = "http://127.0.0.1:2024";

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
  toConnect(record: ProfileRecord): api.ConnectLanggraphProfile {
    const tls = (record.fields["tls"] ?? {}) as Record<string, unknown>;
    const lines = record.secrets["headerLines"];
    const headers = typeof lines === "string" ? parseHeaderLines(lines).headers : [];
    const opt = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v : null);
    return {
      name: record.name,
      url: text(record.fields["url"]).trim(),
      apiKey: opt(record.secrets["apiKey"]),
      headers: headers.length > 0 ? headers : null,
      tls: {
        enabled: tls["enabled"] === true,
        caPem: opt(tls["caPem"]),
        clientCertPem: opt(tls["clientCertPem"]),
        clientKeyPem: opt(record.secrets["clientKeyPem"]),
        serverName: opt(tls["serverName"]),
      },
    };
  },
};

function ConnectionForm({ fields, secrets, storedSecrets, errors, onFields, onSecrets, disabled }: ConnectionFormProps) {
  const url = text(fields["url"]);
  const tls = (fields["tls"] ?? {}) as Record<string, unknown>;
  const setTls = (patch: Record<string, unknown>) => onFields({ tls: { ...tls, ...patch } });
  const https = url.trim().toLowerCase().startsWith("https://");
  const secretPlaceholder = (key: string) => (storedSecrets.has(key) ? "Set (type to replace)" : "Not set");
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
        <PasswordInput value={text(secrets["apiKey"])} onValueChange={(v) => onSecrets({ apiKey: v })} placeholder={secretPlaceholder("apiKey")} autoComplete="off" disabled={disabled} />
        <FieldDescription>Sent as x-api-key when set.</FieldDescription>
      </Field>
      <Field invalid={errors["headerLines"] !== undefined}>
        <FieldLabel>Extra headers</FieldLabel>
        <Textarea value={text(secrets["headerLines"])} onValueChange={(v) => onSecrets({ headerLines: v })} placeholder={storedSecrets.has("headerLines") ? "Set (type to replace)" : "Authorization: Bearer …"} rows={2} disabled={disabled} />
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
            <Textarea value={text(secrets["clientKeyPem"])} onValueChange={(v) => onSecrets({ clientKeyPem: v })} rows={2} placeholder={secretPlaceholder("clientKeyPem")} disabled={disabled} />
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
  tabKinds: {
    "langgraph.assistants": { title: () => "Assistants", Component: AssistantsTab },
    "langgraph.assistant": { title: (params) => `Assistant ${text(params["name"]) || text(params["assistantId"])}`, Component: AssistantTab },
    "langgraph.threads": { title: () => "Threads", Component: ThreadsTab },
    "langgraph.thread": { title: (params) => `Thread ${text(params["threadId"]).slice(0, 8)}`, Component: ThreadTab },
    "langgraph.store": { title: () => "Store", Component: StoreTab },
  },
  actions: [],
  async connect(client, record) {
    const out = await client.langgraph.connect({ profile: profile.toConnect(record) as api.ConnectLanggraphProfile });
    return { connId: out.connId };
  },
  async disconnect(client, connId) {
    await client.langgraph.disconnect({ connId });
  },
};
