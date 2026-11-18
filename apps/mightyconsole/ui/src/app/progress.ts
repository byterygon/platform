// StreamProgress of the page's streams (Mightyconsole spec §2.5): the server publishes one event a
// second per stream with a `streamId` on `app.events`; App forwards them here and a live view
// listens for its own stream's (rate, scanned, matched, dropped, decode errors).
import type { AppEvent } from "@/gen/api";

export type StreamProgressEvent = Extract<AppEvent, { kind: "StreamProgress" }>;

export class ProgressBus {
  readonly #listeners = new Map<string, Set<(event: StreamProgressEvent) => void>>();

  publish(event: StreamProgressEvent): void {
    for (const listener of this.#listeners.get(event.streamId) ?? []) listener(event);
  }

  /** Calls `listener` with each event of `streamId`; returns the unsubscribe function. */
  subscribe(streamId: string, listener: (event: StreamProgressEvent) => void): () => void {
    let set = this.#listeners.get(streamId);
    if (!set) this.#listeners.set(streamId, (set = new Set()));
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#listeners.delete(streamId);
    };
  }
}
