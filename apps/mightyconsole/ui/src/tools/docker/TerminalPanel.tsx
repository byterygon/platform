// A container's Terminal (Mightyconsole spec §10.4, TSK-81 mockup frame docker-terminal): the
// Terminal (xterm.js) on `docker.containers.exec` with a TTY. Before connecting, the bar sets the
// command (default: bash when the image has it, else sh), the user and the working directory.
// Keys go out through `term.write`, batched every 10 ms (spec §2.7); the size follows the panel
// through `term.resize`, debounced by 100 ms. Disconnect ends the exec; the exit code shows in the
// scrollback and the footer, and New session starts another in the same place.
import { useCallback, useEffect, useRef, useState } from "react";
import { useActiveGate } from "@/app/while-active";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Terminal, type TerminalHandle } from "@/components/ui/terminal";
import { liveTimeout } from "@/app/client";
import { PageBar, PageFooter } from "@/app/page";
import { EmptyLine, ErrorState } from "@/app/states";
import * as api from "@/gen/api";
import { Add, Dismiss, Play, WindowConsole } from "@/lib/icons";
import type { DescribedError, TabProps } from "../types";
import { toBase64 } from "./format";

/** The command the server runs when none is given (spec §10.4). */
export const DEFAULT_COMMAND = "/bin/sh -c 'command -v bash >/dev/null && exec bash || exec sh'";

/** How often typed input goes out, and how long a resize waits for the next (spec §2.7). */
export const INPUT_BATCH_MS = 10;
export const RESIZE_DEBOUNCE_MS = 100;

/** `term.write` takes at most this much per call. */
const MAX_WRITE = 64 * 1024;

/**
 * A command line as arguments: words split on spaces, single and double quotes kept together
 * (`sh -c 'echo hi'` is three). Empty: the server's default.
 */
export function splitCommand(line: string): string[] | null {
  const words: string[] = [];
  let word = "";
  let quote: "'" | '"' | null = null;
  let started = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += ch;
      started = true;
    }
  }
  if (started) words.push(word);
  return words.length > 0 ? words : null;
}

type Session = { state: "idle" } | { state: "connecting" } | { state: "open" } | { state: "ended"; exitCode?: number; reason: string };

export interface TerminalPanelProps extends Pick<TabProps, "client" | "connId" | "note" | "active"> {
  container: string;
  running: boolean;
  /** The container's user and working dir, as placeholders. */
  defaultUser: string;
  defaultWorkdir: string;
}

export function TerminalPanel({ client, connId, note, container, running, defaultUser, defaultWorkdir, active }: TerminalPanelProps) {
  const gate = useActiveGate(active);
  const terminal = useRef<TerminalHandle>(null);
  const [command, setCommand] = useState("");
  const [user, setUser] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [session, setSession] = useState<Session>({ state: "idle" });
  const [error, setError] = useState<DescribedError | null>(null);
  const [size, setSize] = useState<{ cols: number; rows: number }>({ cols: 80, rows: 24 });
  const live = useRef<{ terminalId: string; cancel(): void } | null>(null);
  const outbox = useRef<Uint8Array[]>([]);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resizeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const flush = useCallback(() => {
    flushTimer.current = null;
    const open = live.current;
    if (!open || outbox.current.length === 0) return;
    const total = outbox.current.reduce((n, b) => n + b.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const b of outbox.current) {
      all.set(b, at);
      at += b.length;
    }
    outbox.current = [];
    for (let i = 0; i < all.length; i += MAX_WRITE) {
      // The terminal may have ended between the key and the call: NotFound is expected then.
      client.term.write({ terminalId: open.terminalId, data: toBase64(all.subarray(i, i + MAX_WRITE)) }).catch(() => undefined);
    }
  }, [client]);

  const connect = useCallback(() => {
    if (connId === null || live.current) return;
    setError(null);
    terminal.current?.reset();
    setSession({ state: "connecting" });
    const terminalId = crypto.randomUUID();
    const { cols, rows } = sizeRef.current;
    const call = client.docker.containers.exec(
      { connId, id: container, cmd: splitCommand(command), user: user.trim() || null, workdir: workdir.trim() || null, cols, rows, terminalId },
      liveTimeout(api.procedures.docker.containers.exec),
    );
    let cancelled = false;
    live.current = {
      terminalId,
      cancel: () => {
        cancelled = true;
        call.cancel();
      },
    };
    void (async () => {
      try {
        let first = true;
        for await (const chunk of call.chunks()) {
          // Hidden (TSK-107): the session lives on, its output waits in the stream's credits.
          await gate.idle();
          if (first) {
            first = false;
            setSession({ state: "open" });
            terminal.current?.focus();
          }
          terminal.current?.write(chunk.subarray(1));
        }
        const summary = await call.result;
        const reason = summary.exitCode === undefined ? "ended" : `exited with code ${summary.exitCode}`;
        terminal.current?.write(`\r\n\x1b[2m[${reason}]\x1b[0m\r\n`);
        setSession({ state: "ended", ...(summary.exitCode !== undefined ? { exitCode: summary.exitCode } : {}), reason });
      } catch (e) {
        if (cancelled) {
          terminal.current?.write("\r\n\x1b[2m[disconnected]\x1b[0m\r\n");
          setSession({ state: "ended", reason: "disconnected" });
          return;
        }
        const d = note(e);
        setError(d);
        setSession({ state: "ended", reason: d.title });
      } finally {
        live.current = null;
        outbox.current = [];
      }
    })();
  }, [client, command, connId, container, note, user, workdir]);

  const disconnect = () => live.current?.cancel();

  // Leaving the tab, or the connection going away, ends the exec.
  useEffect(
    () => () => {
      live.current?.cancel();
      if (flushTimer.current) clearTimeout(flushTimer.current);
      if (resizeTimer.current) clearTimeout(resizeTimer.current);
    },
    [],
  );
  useEffect(() => {
    if (connId === null) live.current?.cancel();
  }, [connId]);

  const onData = (bytes: Uint8Array) => {
    if (!live.current) return;
    outbox.current.push(bytes);
    flushTimer.current ??= setTimeout(flush, INPUT_BATCH_MS);
  };
  const onResize = (cols: number, rows: number) => {
    setSize({ cols, rows });
    const open = live.current;
    if (!open) return;
    if (resizeTimer.current) clearTimeout(resizeTimer.current);
    resizeTimer.current = setTimeout(() => {
      resizeTimer.current = null;
      client.term.resize({ terminalId: open.terminalId, cols, rows }).catch(() => undefined);
    }, RESIZE_DEBOUNCE_MS);
  };

  if (!running) return <EmptyLine>Not running: start {container} to open a terminal in it.</EmptyLine>;
  const busy = session.state === "connecting" || session.state === "open";
  const program = (splitCommand(command) ?? ["shell"])[0]!.split("/").pop();
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageBar aria-label="Exec options" className="flex-nowrap pb-stack-sm">
        <Input aria-label="Command" size="small" value={command} onValueChange={setCommand} placeholder={DEFAULT_COMMAND} disabled={busy} className="min-w-0 flex-1 font-mono" />
        <Input aria-label="User" size="small" value={user} onValueChange={setUser} placeholder={defaultUser || "image user"} disabled={busy} className="w-1/6 shrink-0" />
        <Input aria-label="Working directory" size="small" value={workdir} onValueChange={setWorkdir} placeholder={defaultWorkdir || "/"} disabled={busy} className="w-1/6 shrink-0 font-mono" />
        {busy ? (
          <Button size="small" appearance="secondary" onClick={disconnect}>
            <Icon icon={Dismiss} /> Disconnect
          </Button>
        ) : session.state === "ended" ? (
          <Button size="small" appearance="primary" onClick={connect}>
            <Icon icon={Add} /> New session
          </Button>
        ) : (
          <Button size="small" appearance="primary" onClick={connect} disabled={connId === null}>
            <Icon icon={Play} /> Connect
          </Button>
        )}
      </PageBar>
      {error ? (
        <div className="px-inset-lg pb-stack-sm">
          <ErrorState error={error} onRetry={connect} />
        </div>
      ) : null}
      <Terminal ref={terminal} aria-label={`Terminal, ${program} in ${container}`} readOnly={!busy} onData={onData} onResize={onResize} className="min-h-0 flex-1 border-t border-border-subtle" />
      <PageFooter>
        <Icon icon={WindowConsole} />
        <span>
          {session.state === "idle"
            ? `Not connected · Connect runs ${command.trim() ? program : "bash, or sh"} in ${container}`
            : session.state === "connecting"
              ? "Connecting…"
              : session.state === "open"
                ? `${program} · TTY ${size.cols}×${size.rows} · resized with the panel`
                : `${session.reason[0]!.toUpperCase()}${session.reason.slice(1)}`}
        </span>
        <span className="flex-1" />
        <span>Ctrl+Shift+C / V copy and paste</span>
      </PageFooter>
    </div>
  );
}
