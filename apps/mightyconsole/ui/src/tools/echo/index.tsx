// `echo`, the sample tool of the foundation (TSK-79): the UI half of the server's echo tool. It
// shows every part of a ToolModule a real tool fills: a versioned profile schema with a secret, a
// connection form, a resource tree under a connected profile, and two tab kinds: a request
// (`echo.ping`, Mod+Enter sends) and a live view (`echo.ticks`: a stream with credits, Live badge,
// Pause, Stop, Clear, Restart).
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "@/components/ui/toolbar";
import { liveTimeout } from "@/app/client";
import { EmptyLine, ErrorState, LiveBadge } from "@/app/states";
import * as api from "@/gen/api";
import { ArrowUp as Send, Braces, Flash, Pause, Play, Stop, Subtract } from "@/lib/icons";
import type { ConnectionFormProps, DescribedError, LiveState, ProfileSchema, TabProps, ToolModule } from "../types";

const profile: ProfileSchema = {
  version: 1,
  defaults: () => ({ fields: { greeting: "" }, secrets: {}, extras: {} }),
  validate(record) {
    const errors: Record<string, string> = {};
    const greeting = record.fields["greeting"];
    if (greeting !== undefined && typeof greeting !== "string") errors["greeting"] = "Must be text.";
    else if (typeof greeting === "string" && greeting.length > 200) errors["greeting"] = "At most 200 characters.";
    return errors;
  },
  migrations: {},
  toConnect(record): api.ConnectEchoProfile {
    const greeting = record.fields["greeting"];
    const token = record.secrets["token"];
    return {
      name: record.name,
      greeting: typeof greeting === "string" && greeting !== "" ? greeting : null,
      token: typeof token === "string" && token !== "" ? token : null,
    };
  },
};

function ConnectionForm({ fields, secrets, storedSecrets, errors, onFields, onSecrets, disabled }: ConnectionFormProps) {
  const token = secrets["token"];
  return (
    <>
      <Field invalid={errors["greeting"] !== undefined}>
        <FieldLabel>Greeting</FieldLabel>
        <Input value={typeof fields["greeting"] === "string" ? fields["greeting"] : ""} onValueChange={(v) => onFields({ greeting: v })} disabled={disabled} />
        <FieldDescription>What the server answers with. Empty means "hello from" and the profile's name.</FieldDescription>
        {errors["greeting"] ? <FieldError match>{errors["greeting"]}</FieldError> : null}
      </Field>
      <Field>
        <FieldLabel>Token</FieldLabel>
        <PasswordInput
          value={typeof token === "string" ? token : ""}
          onValueChange={(v) => onSecrets({ token: v })}
          placeholder={storedSecrets.has("token") ? "Set (type to replace)" : "Not set"}
          autoComplete="off"
          disabled={disabled}
        />
        <FieldDescription>A stand-in secret: the server refuses the token "wrong", as a real system rejects credentials.</FieldDescription>
      </Field>
    </>
  );
}

/** `echo.ping`: a text, Send (Mod+Enter), the answer. */
function PingTab({ connId, client, useTabActions, note }: TabProps) {
  const [text, setText] = useState("hello");
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (connId === null) return;
    setBusy(true);
    setError(null);
    try {
      const out = await client.echo.ping({ connId, text });
      setAnswer(`${out.greeting}: ${out.text}`);
    } catch (e) {
      setError(note(e));
    } finally {
      setBusy(false);
    }
  };
  useTabActions({ primary: () => void send() });
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label="Ping actions">
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="primary" loading={busy} />} onClick={() => void send()}>
            <Icon icon={Send} /> Send
          </ToolbarButton>
        </ToolbarGroup>
      </Toolbar>
      <div className="flex flex-col gap-stack-md p-inset-md">
        <Field>
          <FieldLabel>Text</FieldLabel>
          <Input value={text} onValueChange={setText} />
        </Field>
        {error ? <ErrorState error={error} onRetry={() => void send()} /> : answer === null ? <EmptyLine>Nothing sent yet.</EmptyLine> : <output className="text-body-1 text-fg">{answer}</output>}
      </div>
    </div>
  );
}

/** One line of `echo.ticks` (the server's `EchoTick`; chunk lines are not in the generated API). */
interface EchoTick {
  seq: number;
}

/** Rows a ticks view keeps on screen. */
const MAX_ROWS = 200;

/** `echo.ticks`: a live view. Pausing stops pulling chunks, so the server stops at its credits. */
function TicksTab({ tab, connId, client, useTabActions, onLive, note }: TabProps) {
  const [rows, setRows] = useState<number[]>([]);
  const [live, setLive] = useState<LiveState | null>(null);
  const [error, setError] = useState<DescribedError | null>(null);
  const run = useRef<{ cancel(): void; pause(on: boolean): void; paused(): boolean } | null>(null);
  const lastSeq = useRef(-1);

  const report = (next: LiveState | null) => {
    setLive(next);
    onLive(next);
  };

  const start = () => {
    if (connId === null || run.current !== null) return;
    setError(null);
    const call = client.echo.ticks({ connId, streamId: crypto.randomUUID(), intervalMs: 200, count: null }, liveTimeout(api.procedures.echo.ticks));
    const iterator = call.chunks()[Symbol.asyncIterator]();
    let paused = false;
    let resume: (() => void) | null = null;
    let received = 0;
    let since = Date.now();
    const decoder = new TextDecoder();
    run.current = {
      cancel: () => {
        call.cancel();
        resume?.();
      },
      pause: (on) => {
        paused = on;
        if (!on) resume?.();
        report(on ? { status: "paused", buffered: rows.length } : { status: "live" });
      },
      paused: () => paused,
    };
    report({ status: "live" });
    void (async () => {
      try {
        for (;;) {
          if (paused) await new Promise<void>((r) => (resume = r));
          resume = null;
          const next = await iterator.next();
          if (next.done) break;
          for (const line of decoder.decode(next.value).split("\n")) {
            if (line === "") continue;
            const tick = JSON.parse(line) as EchoTick;
            lastSeq.current = tick.seq;
            received++;
            setRows((r) => [tick.seq, ...r].slice(0, MAX_ROWS));
          }
          const elapsed = (Date.now() - since) / 1000;
          if (elapsed >= 1 && !paused) {
            report({ status: "live", ratePerSec: received / elapsed });
            received = 0;
            since = Date.now();
          }
        }
        await call.result;
        report({ status: "ended", reason: "done" });
      } catch (e) {
        const d = note(e);
        if (d.code === "Cancelled") report({ status: "ended", reason: "stopped" });
        else {
          setError(d);
          report({ status: "ended", reason: d.title });
        }
      } finally {
        run.current = null;
      }
    })();
  };

  const stop = () => run.current?.cancel();
  const pause = () => run.current?.pause(!run.current.paused());
  const clear = () => setRows([]);
  useTabActions({ primary: start, stop, pause, clear });
  useEffect(() => () => run.current?.cancel(), []);
  // The handle went away (disconnect, server lost): the stream ended with it.
  useEffect(() => {
    if (connId === null) run.current?.cancel();
  }, [connId]);

  const running = live?.status === "live" || live?.status === "paused";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar aria-label={`${tab.title} actions`}>
        <ToolbarGroup>
          <ToolbarButton render={<Button appearance="primary" disabled={running} />} onClick={start}>
            <Icon icon={Play} /> {live?.status === "ended" ? "Restart" : "Start"}
          </ToolbarButton>
          <ToolbarButton render={<Button disabled={!running} />} onClick={pause}>
            <Icon icon={live?.status === "paused" ? Play : Pause} /> {live?.status === "paused" ? "Resume" : "Pause"}
          </ToolbarButton>
          <ToolbarButton render={<Button disabled={!running} />} onClick={stop}>
            <Icon icon={Stop} /> Stop
          </ToolbarButton>
          <ToolbarSeparator />
          <ToolbarButton render={<Button appearance="subtle" />} onClick={clear}>
            <Icon icon={Subtract} /> Clear
          </ToolbarButton>
        </ToolbarGroup>
        {live ? <LiveBadge live={live} unit="ticks/s" /> : null}
      </Toolbar>
      {error ? <ErrorState error={error} onRetry={start} /> : null}
      {rows.length === 0 ? (
        <EmptyLine>{running ? "Waiting for the first tick…" : "No ticks. Press Start (Ctrl+Enter)."}</EmptyLine>
      ) : (
        <ol aria-label="Ticks" className="min-h-0 flex-1 overflow-auto p-inset-sm font-mono text-code text-fg">
          {rows.map((seq) => (
            <li key={seq}>tick {seq}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

export const echoTool: ToolModule = {
  id: "echo",
  label: "Echo",
  icon: Braces,
  description: "The sample tool: it talks to nothing but the server, to show how every tool works.",
  profile,
  ConnectionForm,
  sidebarTree: ({ profile: p }) => [
    { id: `${p.id}/ping`, label: "Ping", icon: <Icon icon={Send} />, open: { kind: "echo.ping", params: {}, title: `Ping · ${p.name}` } },
    { id: `${p.id}/ticks`, label: "Ticks", icon: <Icon icon={Flash} />, open: { kind: "echo.ticks", params: {}, title: `Ticks · ${p.name}` } },
  ],
  tabKinds: {
    "echo.ping": { title: () => "Ping", Component: PingTab },
    "echo.ticks": { title: () => "Ticks", Component: TicksTab },
  },
  actions: [],
  async connect(client, record) {
    const out = await client.echo.connect({ profile: profile.toConnect(record) as api.ConnectEchoProfile });
    return { connId: out.connId };
  },
  async disconnect(client, connId) {
    await client.echo.disconnect({ connId });
  },
};
