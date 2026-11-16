// The one Ambidex client of the app (DBee spec §2): `createClient(api, autoTransport())`, built
// once. `autoTransport` picks Tauri IPC inside the desktop webview and the WebSocket to the page's
// own origin in a browser; nothing in the screens knows which. Arrow chunks are decoded in a Worker
// (`@byterygon/ambidex/arrow-worker`, bundled by Vite), never on the UI thread.
import { type Client, autoTransport, createClient } from "@byterygon/ambidex";
import { type ArrowDecoderPort, type ArrowStream, decodeArrow } from "@byterygon/ambidex/arrow";
import { createContext, useContext } from "react";
import * as api from "@/gen/api";

export type DbeeApi = typeof api.procedures;
/** The typed client: `client.query.execute(...)`, from the generated procedure table. */
export type DbeeClient = Client<DbeeApi>;

export interface Services {
  readonly client: DbeeClient;
  /** Where Arrow IPC is decoded; a Worker in the app, an in-thread decoder in tests. */
  readonly decoder: ArrowDecoderPort;
  /** Closes the connection (web: on unload). */
  readonly close?: () => void;
}

export const ServicesContext = createContext<Services | null>(null);

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (services === null) throw new Error("ServicesContext is missing");
  return services;
}

export function useClient(): DbeeClient {
  return useServices().client;
}

/** `query.execute` decoded as Arrow record batches; the UI sends the maximum deadline (Decision 14). */
export function executeArrow(services: Services, input: api.ExecuteInput, signal?: AbortSignal): ArrowStream<api.ExecuteSummary> {
  const timeoutMs = api.procedures.query.execute.timeoutMaxMs;
  const stream = services.client.query.execute(input, { ...(timeoutMs !== null ? { timeoutMs } : {}), ...(signal ? { signal } : {}) });
  return decodeArrow(stream, services.decoder);
}

/** The real services: one client over the auto-selected transport and one decoder Worker. */
export function createServices(): Services {
  const client = createClient(api, autoTransport());
  const decoder = new Worker(new URL("./arrow-worker.ts", import.meta.url), { type: "module" });
  return { client, decoder, close: () => client.$close() };
}
