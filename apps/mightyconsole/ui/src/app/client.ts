// The one Ambidex client of the app (Mightyconsole spec §2.1): `createClient(api, autoTransport())`
// built once, over the WebSocket to the page's own origin. The anti-CSRF token the server put in
// `<meta name="mightyconsole-csrf">` goes into every Hello (`auth: { csrf }`), read on each new
// connection (spec §2.3).
import { type Client, autoTransport, createClient } from "@byterygon/ambidex";
import type { ArrowDecoderPort } from "@byterygon/ambidex/arrow";
import { createContext, useContext } from "react";
import * as api from "@/gen/api";
import type { AppStorage } from "@/profiles/storage";
import { ProgressBus } from "./progress";

export type MightyApi = typeof api.procedures;
/** The typed client: `client.echo.connect(...)`, from the generated procedure table. */
export type MightyClient = Client<MightyApi>;

/** The `<meta>` the server writes the token into (`static_ui::CSRF_META`). */
export const CSRF_META = "mightyconsole-csrf";

export function readCsrf(doc: Document = document): string | null {
  return doc.querySelector<HTMLMetaElement>(`meta[name="${CSRF_META}"]`)?.content || null;
}

export interface Services {
  readonly client: MightyClient;
  readonly storage: AppStorage;
  /** Where Arrow IPC (message batches) is decoded: a Worker in the app, in-thread in tests. */
  readonly decoder: ArrowDecoderPort;
  /** The StreamProgress events of the page's streams, by streamId. */
  readonly progress: ProgressBus;
  /** Closes the connection (on unload). */
  readonly close?: () => void;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error("ServicesContext is missing");
  return services;
}

/** The real services: one client over the WebSocket to this page's origin. */
export function createServices(storage: AppStorage): Services {
  const client = createClient(api, autoTransport({ force: "websocket", webSocket: { auth: () => ({ csrf: readCsrf() ?? "" }) } }));
  const decoder = new Worker(new URL("./arrow-worker.ts", import.meta.url), { type: "module" });
  return {
    client,
    storage,
    decoder,
    progress: new ProgressBus(),
    close: () => client.$close(),
  };
}

/** The deadline a live stream asks for: the procedure's maximum (spec §2.4). */
export function liveTimeout(procedure: { readonly timeoutMaxMs: number | null }): { timeoutMs?: number } {
  return procedure.timeoutMaxMs !== null ? { timeoutMs: procedure.timeoutMaxMs } : {};
}
