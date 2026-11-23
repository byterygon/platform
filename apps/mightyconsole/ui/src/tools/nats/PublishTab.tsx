// `nats.publish {}` (Mightyconsole spec §6.3 "Publish", mockup frame nats-publish): the messaging
// core's Composer with the subject, and the reply subject (Publish) or the timeout (Request). In
// Request mode the reply shows beside the form with the time it took, its subject and codec; "No
// responders" and a timeout are said plainly and keep the form. The send history (DOC-21 Open
// question 45 (o)) keeps the tab's last 20 sends to send again; it lives in the tab, not on the
// server or in the profile.
import { useCallback, useState } from "react";
import { isRpcError } from "@byterygon/ambidex";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { JsonView } from "@/app/json-view";
import { CodeBlock } from "@/components/ui/code-block";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton, Page, PageHeader } from "@/app/page";
import { DisconnectedState, EmptyLine } from "@/app/states";
import type * as api from "@/gen/api";
import { Composer, type ComposerDraft, type ComposerTemplate, EMPTY_DRAFT, headerInputs } from "@/messaging/Composer";
import { describeError, schemaChoices } from "@/messaging/compose-helpers";
import type { TabProps } from "../types";
import { bookmarksOf, requestTimeoutOf, validateSubject } from "./profile";
import { formatSize } from "./format";

export type PublishMode = "publish" | "request";

/** One send of this tab. */
export interface SendRecord {
  id: number;
  at: Date;
  mode: PublishMode;
  subject: string;
  replyTo: string;
  timeoutMs: number;
  draft: ComposerDraft;
  /** "164 B", "Reply in 12 ms", "No responders on svc.echo". */
  outcome: string;
  ok: boolean;
}

/** Sends kept per tab. */
export const HISTORY_SIZE = 20;

/** The newest first, at most 20. */
export function remember(history: readonly SendRecord[], record: SendRecord): SendRecord[] {
  return [record, ...history].slice(0, HISTORY_SIZE);
}

function base64Text(b64: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return "";
  }
}

/** The reply's text: the decoded value, pretty when it is JSON; else the raw bytes as text. */
export function replyText(reply: api.MessageRecord): { text: string; json: boolean } {
  const text = reply.payloadText ?? base64Text(reply.payloadRaw);
  try {
    return { text: JSON.stringify(JSON.parse(text), null, 2), json: true };
  } catch {
    return { text, json: false };
  }
}

const describeSend = (e: unknown): { title: string; field?: string; line?: number; column?: number } => {
  const d = describeError(e);
  // The Composer marks "value" (the payload); the server names "payload".
  return d.field === "payload" ? { ...d, field: "value" } : d;
};

export function PublishTab({ tab, profile, connId, client, useTabActions, updateProfile }: TabProps) {
  const [mode, setMode] = useState<PublishMode>(tab.params["mode"] === "request" ? "request" : "publish");
  const [subject, setSubject] = useState(typeof tab.params["subject"] === "string" ? tab.params["subject"] : "");
  const [replyTo, setReplyTo] = useState("");
  const [timeout, setTimeoutText] = useState(String(requestTimeoutOf(profile)));
  const [draft, setDraft] = useState<ComposerDraft>(EMPTY_DRAFT);
  const [reply, setReply] = useState<api.NatsRequestOutput | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [history, setHistory] = useState<SendRecord[]>([]);
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);
  const templates = (Array.isArray(profile.extras["templates"]) ? profile.extras["templates"] : []) as ComposerTemplate[];
  const targetSubject = subject.trim() || "_";
  const encode = useCallback(
    (payload: api.ComposePayload) => client.messaging.encode({ connId, target: { kind: "subject", subject: targetSubject }, part: "value", payload }),
    [client, connId, targetSubject],
  );
  const inspect = useCallback((schema: api.SchemaRef, messageType: string | null) => client.messaging.schemas.inspect({ connId, schema, messageType }), [client, connId]);
  const suggestions = bookmarksOf(profile.extras).filter((s) => validateSubject(s) === null && s !== subject.trim());
  useTabActions({ primary: () => document.querySelector<HTMLFormElement>(`[data-tab="${tab.id}"] [data-slot=composer]`)?.requestSubmit() });

  if (connId === null) return <DisconnectedState name={profile.name} onConnect={() => undefined} />;

  const timeoutMs = Number(timeout);
  const timeoutProblem = mode === "request" && !(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 300_000) ? "A whole number of milliseconds, 1 to 300000." : null;
  const send = async (d: ComposerDraft) => {
    const s = subject.trim();
    const problem = validateSubject(s) ?? (mode === "publish" && replyTo.trim() !== "" ? validateSubject(replyTo) : null);
    if (problem) {
      setFieldError({ field: validateSubject(s) ? "subject" : "replyTo", message: problem });
      throw new Error(problem);
    }
    if (timeoutProblem) throw new Error(timeoutProblem);
    setFieldError(null);
    const base = { id: Date.now(), at: new Date(), mode, subject: s, replyTo: replyTo.trim(), timeoutMs, draft: structuredClone(d) };
    try {
      if (mode === "publish") {
        const out = await client.nats.core.publish({ connId, subject: s, replyTo: replyTo.trim() || null, headers: headerInputs(d.headers), payload: d.value });
        setHistory((h) => remember(h, { ...base, outcome: `${formatSize(out.bytes)} published`, ok: true }));
        return `Published ${out.bytes.toLocaleString()} bytes on ${s}${out.schemaRef ? ` (${out.schemaRef})` : ""}.`;
      }
      setReply(null);
      setFailure(null);
      const out = await client.nats.core.request({ connId, subject: s, headers: headerInputs(d.headers), payload: d.value, timeoutMs, decode: null }, { timeoutMs: timeoutMs + 5000 });
      setReply(out);
      setHistory((h) => remember(h, { ...base, outcome: `Reply in ${out.elapsedMs.toFixed(0)} ms`, ok: true }));
      return `Reply in ${out.elapsedMs.toFixed(1)} ms, ${formatSize(out.reply.payloadSize)}.`;
    } catch (e) {
      const d2 = describeSend(e);
      if (d2.field === "subject" || d2.field === "replyTo") setFieldError({ field: d2.field, message: d2.title });
      if (mode === "request" && isRpcError(e)) setFailure(d2.title);
      setHistory((h) => remember(h, { ...base, outcome: d2.title, ok: false }));
      throw e;
    }
  };
  const again = (r: SendRecord) => {
    setMode(r.mode);
    setSubject(r.subject);
    setReplyTo(r.replyTo);
    setTimeoutText(String(r.timeoutMs));
    setDraft(structuredClone(r.draft));
  };

  const shown = reply ? replyText(reply.reply) : null;
  return (
    <Page>
      <PageHeader
        title="Publish"
        subtitle={`${profile.name} · core NATS`}
        actions={
          <ToggleGroup aria-label="Mode" value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as PublishMode)}>
            <ToggleGroupItem value="publish">Publish</ToggleGroupItem>
            <ToggleGroupItem value="request">Request</ToggleGroupItem>
          </ToggleGroup>
        }
      />
      <div data-tab={tab.id} className="mt-stack-md flex min-h-0 flex-1 border-t border-border-subtle">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Composer
            target={
              <>
                <Field className="min-w-0 flex-1" invalid={fieldError?.field === "subject"}>
                  <FieldLabel>Subject</FieldLabel>
                  <Input value={subject} onValueChange={setSubject} placeholder="orders.eu.created" className="font-mono" spellCheck={false} autoComplete="off" />
                  {suggestions.length > 0 ? (
                    <FieldDescription>
                      Bookmarks:{" "}
                      {suggestions.map((s) => (
                        <Button key={s} size="small" appearance="subtle" className="font-mono" onClick={() => setSubject(s)}>
                          {s}
                        </Button>
                      ))}
                    </FieldDescription>
                  ) : (
                    <FieldDescription>A whole subject: wildcards only subscribe.</FieldDescription>
                  )}
                  {fieldError?.field === "subject" ? <FieldError match>{fieldError.message}</FieldError> : null}
                </Field>
                {mode === "publish" ? (
                  <Field className="min-w-0 flex-1" invalid={fieldError?.field === "replyTo"}>
                    <FieldLabel>Reply subject</FieldLabel>
                    <Input value={replyTo} onValueChange={setReplyTo} placeholder="Optional" className="font-mono" spellCheck={false} autoComplete="off" />
                    {fieldError?.field === "replyTo" ? <FieldError match>{fieldError.message}</FieldError> : null}
                  </Field>
                ) : (
                  <Field className="w-auto" invalid={timeoutProblem !== null}>
                    <FieldLabel>Timeout (ms)</FieldLabel>
                    <Input inputMode="numeric" value={timeout} onValueChange={setTimeoutText} />
                    <FieldDescription>Waits for the first reply.</FieldDescription>
                    {timeoutProblem ? <FieldError match>{timeoutProblem}</FieldError> : null}
                  </Field>
                )}
              </>
            }
            schemas={schemaChoices(profile)}
            draft={draft}
            onDraftChange={setDraft}
            encode={encode}
            inspect={inspect}
            onSend={send}
            templates={templates}
            describe={describeSend}
            {...(updateProfile
              ? {
                  onSaveTemplate: (name: string, d: ComposerDraft) =>
                    void updateProfile((r) => {
                      const saved = (Array.isArray(r.extras["templates"]) ? r.extras["templates"] : []) as ComposerTemplate[];
                      return { ...r, extras: { ...r.extras, templates: [...saved.filter((t) => t.name !== name), { id: crypto.randomUUID(), name, draft: d }] } };
                    }),
                }
              : {})}
          />
        </div>
        <aside aria-label={mode === "request" ? "Reply and history" : "History"} className="flex w-panel-md shrink-0 flex-col gap-stack-md overflow-auto border-s border-border-subtle p-inset-md">
          {mode === "request" ? (
            <section aria-label="Reply" className="flex flex-col gap-stack-sm">
              <h3 className="flex items-center gap-inline-sm text-subtitle-2 text-fg">
                Reply {reply ? <Badge appearance="tint" variant="success">{`${reply.elapsedMs.toFixed(0)} ms`}</Badge> : null}
              </h3>
              {reply && shown ? (
                <>
                  <p className="flex flex-wrap items-center gap-inline-xs text-caption-1 text-fg-muted">
                    from <span className="font-mono">{reply.reply.subject ?? reply.reply.source}</span>
                    <CopyButton value={reply.reply.subject ?? reply.reply.source} what="reply subject" />· {formatSize(reply.reply.payloadSize)} · {reply.reply.payloadCodec}
                    {reply.reply.schemaRef ? ` · ${reply.reply.schemaRef}` : ""}
                  </p>
                  {shown.json ? <JsonView modeKey="nats.publish.reply" defaultMode="text" text={shown.text} aria-label="Reply payload" className="max-h-panel-sm" /> : <CodeBlock aria-label="Reply payload" code={shown.text} language="text" copyable wrap className="max-h-panel-sm" />}
                  {reply.reply.headers && reply.reply.headers.length > 0 ? (
                    <ul aria-label="Reply headers" className="flex flex-col gap-stack-xs text-caption-1">
                      {reply.reply.headers.map((h, i) => (
                        <li key={`${h.name}-${i}`} className="font-mono">
                          <span className="text-fg">{h.name}</span>: <span className="text-fg-muted">{h.value}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {reply.reply.decodeError ? <p className="text-caption-1 text-danger-fg">{reply.reply.decodeError}</p> : null}
                </>
              ) : failure ? (
                <p role="alert" className="text-body-1 text-danger-fg">
                  {failure}
                </p>
              ) : (
                <EmptyLine>Send a request to see the first reply here.</EmptyLine>
              )}
            </section>
          ) : null}
          <section aria-label="Send history" className="flex flex-col gap-stack-sm">
            <h3 className="text-subtitle-2 text-fg">History{history.length > 0 ? ` (${history.length})` : ""}</h3>
            {history.length === 0 ? (
              <p className="text-caption-1 text-fg-muted">The last {HISTORY_SIZE} sends of this tab, to send again.</p>
            ) : (
              <ol className="flex flex-col gap-stack-xs">
                {history.map((r) => (
                  <li key={r.id} className="flex items-center gap-inline-sm text-caption-1">
                    <Badge appearance="tint" variant={r.ok ? "neutral" : "danger"}>
                      {r.mode === "request" ? "Request" : "Publish"}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-fg">{r.subject}</span> <span className="text-fg-muted">· {r.at.toLocaleTimeString()} · {r.outcome}</span>
                    </span>
                    <Button size="small" appearance="subtle" onClick={() => again(r)} aria-label={`Use again: ${r.subject} at ${r.at.toLocaleTimeString()}`}>
                      Use again
                    </Button>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </Page>
  );
}
