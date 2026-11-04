// Transport selection (Ambidex spec §4): Tauri IPC inside the desktop app, WebSocket elsewhere.

import { TauriTransport, type TauriTransportOptions, tauriIpc } from "./tauri.js";
import type { Transport } from "./transport.js";
import { WebSocketTransport, type WebSocketTransportOptions } from "./websocket.js";

/**
 * Whether this page runs in a Tauri webview: Tauri injects `__TAURI_INTERNALS__` with `invoke`
 * and `transformCallback` before any page script. An ordinary browser has neither, so a web page
 * is never mistaken for the desktop app (and a page that fakes them only talks to itself).
 */
export function isTauri(): boolean {
  return tauriIpc() !== undefined;
}

export interface AutoTransportOptions {
  readonly tauri?: TauriTransportOptions;
  readonly webSocket?: WebSocketTransportOptions;
  /** Skip detection. For tests and deployments where detection is not wanted. */
  readonly force?: "tauri" | "websocket";
}

/** `TauriTransport` inside a Tauri webview, otherwise `WebSocketTransport`. */
export function autoTransport(options: AutoTransportOptions = {}): Transport {
  const useTauri = options.force !== undefined ? options.force === "tauri" : isTauri();
  return useTauri ? new TauriTransport(options.tauri) : new WebSocketTransport(options.webSocket);
}
