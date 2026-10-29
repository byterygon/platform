// WebSocket transport (Ambidex spec §4, §9): one binary WebSocket per connection at `/rpc/ws`.
//
// The pipe only moves bytes: each client frame goes out as one binary message, and every binary
// message received is handed to the runtime as is (the server may coalesce frames). A text
// message is a protocol violation; the pipe closes, as the server does for text from a client.
//
// Security is the browser's and the server's: the session cookie and `Origin` are sent by the
// browser on the upgrade, the server checks `Host`, `Origin` and the cookie (TSK-10), and the
// anti-CSRF token travels in `Hello.auth` (`{ csrf }`, spec Open question 20a). Only `wss:` is
// accepted unless `allowInsecure` is set for a loopback development server.

import { type Pipe, type PipeSink, type Transport, TransportError } from "./transport.js";

/** The server's WebSocket path (`ambidex_axum::RPC_WS_PATH`). */
export const RPC_WS_PATH = "/rpc/ws";

/** The subset of the WHATWG `WebSocket` the transport uses. */
export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: any) => void,
  ): void;
  removeEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: any) => void,
  ): void;
}

export interface WebSocketTransportOptions {
  /**
   * `wss://host[:port]/rpc/ws`. Default: the page's own host (`location.host`) at
   * `RPC_WS_PATH`, which is what the server's Host and Origin checks expect for a same-origin app.
   */
  readonly url?: string;
  /**
   * `Hello.auth`, e.g. `{ csrf: token }`, read on every new connection. The value is never logged.
   */
  readonly auth?: () => unknown;
  /** Creates the socket. Default: the global `WebSocket`. For tests and non-browser hosts. */
  readonly createSocket?: (url: string) => WebSocketLike;
  /** Accept `ws:` URLs. Only for a loopback development server; the real server is TLS-only. */
  readonly allowInsecure?: boolean;
}

const OPEN = 1;
/** Normal closure. */
const CLOSE_NORMAL = 1000;

export class WebSocketTransport implements Transport {
  readonly name = "websocket";
  readonly #options: WebSocketTransportOptions;

  constructor(options: WebSocketTransportOptions = {}) {
    this.#options = options;
  }

  open(sink: PipeSink): Promise<Pipe> {
    let url: string;
    try {
      url = this.#url();
    } catch (error) {
      return Promise.reject(error);
    }
    const create =
      this.#options.createSocket ??
      ((u: string): WebSocketLike => {
        const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
        if (Ctor === undefined) throw new TransportError("WebSocket is not available");
        return new Ctor(u);
      });
    let auth: unknown;
    try {
      auth = this.#options.auth?.();
    } catch {
      return Promise.reject(new TransportError("auth provider failed"));
    }

    return new Promise<Pipe>((resolve, reject) => {
      let socket: WebSocketLike;
      try {
        socket = create(url);
      } catch (error) {
        reject(
          error instanceof TransportError ? error : new TransportError("cannot open WebSocket"),
        );
        return;
      }
      socket.binaryType = "arraybuffer";
      let opened = false;
      let ended = false;

      const end = (error?: Error): void => {
        if (ended) return;
        ended = true;
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
        if (socket.readyState <= OPEN) {
          try {
            socket.close(CLOSE_NORMAL);
          } catch {
            // Already closing.
          }
        }
        if (opened) sink.closed(error);
        else reject(error ?? new TransportError("WebSocket closed before opening"));
      };

      const onOpen = (): void => {
        opened = true;
        const pipe: Pipe = {
          send: (bytes) => {
            if (ended) return;
            try {
              socket.send(bytes);
            } catch {
              end(new TransportError("WebSocket send failed"));
            }
          },
          close: () => end(),
          ...(auth !== undefined ? { auth } : {}),
        };
        resolve(pipe);
      };
      const onMessage = (event: { data: unknown }): void => {
        if (ended) return;
        const { data } = event;
        if (data instanceof ArrayBuffer) sink.data(new Uint8Array(data));
        else if (ArrayBuffer.isView(data)) {
          sink.data(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        } else end(new TransportError("non-binary WebSocket message"));
      };
      const onClose = (event: { code?: number; wasClean?: boolean }): void => {
        const abnormal = event.code !== CLOSE_NORMAL || event.wasClean === false;
        end(abnormal ? new TransportError(`WebSocket closed (${event.code ?? "?"})`) : undefined);
      };
      const onError = (): void => end(new TransportError("WebSocket error"));

      socket.addEventListener("open", onOpen);
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
    });
  }

  #url(): string {
    let url = this.#options.url;
    if (url === undefined) {
      const location = (globalThis as { location?: { host?: string } }).location;
      if (location?.host === undefined || location.host === "") {
        throw new TransportError("no url given and no page location to derive it from");
      }
      url = `wss://${location.host}${RPC_WS_PATH}`;
    }
    const scheme = url.slice(0, url.indexOf(":") + 1).toLowerCase();
    if (scheme !== "wss:" && !(scheme === "ws:" && this.#options.allowInsecure === true)) {
      throw new TransportError("WebSocket url must use wss:");
    }
    return url;
  }
}
