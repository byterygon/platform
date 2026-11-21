// The host's events as the Docker screens use them (Mightyconsole spec §10.6, `docker.events`):
// one stream per screen while it is shown and connected, read as fast as it comes (events are
// small and few). A stream that ends with an error starts again after a pause, from the last
// event's time, so nothing is missed; a released connection ends it for good.
import { useEffect, useRef, useState } from "react";
import type { MightyClient } from "@/app/client";
import { liveTimeout } from "@/app/client";
import { describeError } from "@/app/messages";
import { useActiveGate } from "@/app/while-active";
import * as api from "@/gen/api";
import { type DockerEvent, parseLines } from "./format";

/** The pause before a failed events stream starts again. */
export const EVENTS_RETRY_MS = 3000;

export interface EventsState {
  /** The newest event, for the footer. */
  last: DockerEvent | null;
  /** The stream runs (connected and listening). */
  live: boolean;
  /** Why it is not running, when it failed. */
  error: string | null;
}

/**
 * Runs `docker.events` (only `container`'s events when given) while `connId` is set, calling
 * `onEvent` for every event. `onEvent` may change between renders; the latest one is called.
 */
export function useDockerEvents(options: { client: MightyClient; connId: string | null; container?: string; types?: readonly string[]; onEvent(event: DockerEvent): void; /** The screen is shown (default true); hidden, events wait unread and come when it is shown (TSK-107). */ active?: boolean }): EventsState {
  const { client, connId, container } = options;
  const types = options.types?.join(",") ?? "";
  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;
  const [state, setState] = useState<EventsState>({ last: null, live: false, error: null });
  const gate = useActiveGate(options.active ?? true);

  useEffect(() => {
    if (connId === null) {
      setState((s) => ({ ...s, live: false }));
      return undefined;
    }
    let stopped = false;
    let cancel: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Docker's `since` is inclusive at the second: events already seen are skipped by time.
    let sinceMs: number | null = null;
    const seen = new Set<string>();
    const decoder = new TextDecoder();

    const run = async () => {
      if (stopped) return;
      const call = client.docker.events(
        {
          connId,
          streamId: crypto.randomUUID(),
          types: types === "" ? null : types.split(","),
          container: container ?? null,
          since: sinceMs === null ? null : (Math.floor(sinceMs / 1000)).toString(),
        },
        liveTimeout(api.procedures.docker.events),
      );
      cancel = () => call.cancel();
      setState((s) => ({ ...s, live: true, error: null }));
      try {
        for await (const chunk of call.chunks()) {
          await gate.idle();
          if (stopped) return;
          for (const event of parseLines<DockerEvent>(chunk, decoder)) {
            const key = `${event.timeMs}|${event.kind}|${event.action}|${event.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (seen.size > 2000) seen.clear();
            sinceMs = event.timeMs;
            setState((s) => ({ ...s, last: event }));
            onEvent.current(event);
          }
        }
        await call.result;
      } catch (e) {
        if (stopped) return;
        const described = describeError(e);
        // The handle is gone: the shell reconnects the profile and gives this screen a new connId.
        if (described.code === "NotFound" || described.code === "Cancelled") {
          setState((s) => ({ ...s, live: false }));
          return;
        }
        setState((s) => ({ ...s, live: false, error: described.title }));
        timer = setTimeout(() => void run(), EVENTS_RETRY_MS);
        return;
      }
      if (!stopped) setState((s) => ({ ...s, live: false }));
    };
    void run();
    return () => {
      stopped = true;
      cancel?.();
      if (timer !== null) clearTimeout(timer);
    };
  }, [client, connId, container, types]);

  return state;
}
