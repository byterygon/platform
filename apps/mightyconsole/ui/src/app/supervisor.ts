// The connection to mightyconsole-server (Mightyconsole spec §2.2 "Recovery", §3.5 "Server lost").
//
// One loop per page: `app.info`, then the page's one `app.events` subscription. When the
// subscription fails (the WebSocket closed, the server stopped), the shell shows "Lost the
// connection to mightyconsole-server, retrying…" and the loop tries `app.info` again with backoff;
// the Ambidex client opens a new connection for it. Once it answers, the shell calls `connect`
// again for every profile that was connected (the server released their handles when the old
// WebSocket closed) and the tabs restart their streams from where they stopped. `VersionMismatch`
// (the server was upgraded) stops the loop and asks for a reload.
import { isRpcError } from "@byterygon/ambidex";
import type { AppEvent, AppInfo } from "@/gen/api";
import type { MightyClient } from "./client";

export type ServerStatus = "connecting" | "online" | "lost" | "versionMismatch";

export interface SupervisorHandlers {
  status(status: ServerStatus): void;
  info(info: AppInfo): void;
  event(event: AppEvent): void;
  /** Online again after a loss: connect the profiles again. */
  reconnected(): void;
}

export interface SupervisorOptions {
  /** Delay before attempt `n` (0-based) after a loss. Default 500 ms doubling up to 10 s. */
  backoffMs?: (attempt: number) => number;
}

export const defaultBackoff = (attempt: number): number => Math.min(10_000, 500 * 2 ** attempt);

export class Supervisor {
  readonly #client: Pick<MightyClient, "app">;
  readonly #handlers: SupervisorHandlers;
  readonly #backoff: (attempt: number) => number;
  #stopped = false;
  #subscription: { unsubscribe(): void } | null = null;
  #wake: (() => void) | null = null;

  constructor(client: Pick<MightyClient, "app">, handlers: SupervisorHandlers, options: SupervisorOptions = {}) {
    this.#client = client;
    this.#handlers = handlers;
    this.#backoff = options.backoffMs ?? defaultBackoff;
  }

  /** Runs until `stop()`; resolves when it stops. */
  async run(): Promise<void> {
    let attempt = 0;
    let lost = false;
    this.#handlers.status("connecting");
    while (!this.#stopped) {
      let info: AppInfo;
      try {
        info = await this.#client.app.info({});
      } catch (e) {
        if (this.#stopped) return;
        if (isRpcError(e) && e.code === "VersionMismatch") return this.#handlers.status("versionMismatch");
        lost = true;
        this.#handlers.status("lost");
        await this.#sleep(this.#backoff(attempt++));
        continue;
      }
      if (this.#stopped) return;
      attempt = 0;
      this.#handlers.info(info);
      this.#handlers.status("online");
      const events = this.#client.app.events({});
      this.#subscription = events;
      if (lost) {
        lost = false;
        this.#handlers.reconnected();
      }
      try {
        for await (const event of events) this.#handlers.event(event);
      } catch (e) {
        if (isRpcError(e) && e.code === "VersionMismatch") return this.#handlers.status("versionMismatch");
      }
      this.#subscription = null;
      if (this.#stopped) return;
      lost = true;
      this.#handlers.status("lost");
      await this.#sleep(this.#backoff(attempt++));
    }
  }

  /** Retries now instead of waiting for the backoff. */
  retryNow(): void {
    this.#wake?.();
  }

  stop(): void {
    this.#stopped = true;
    this.#subscription?.unsubscribe();
    this.#wake?.();
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      const self = this;
      function done() {
        clearTimeout(timer);
        self.#wake = null;
        resolve();
      }
      this.#wake = done;
    });
  }
}
