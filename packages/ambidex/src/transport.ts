// Transport interface (Ambidex spec §1, §4): a transport is a dumb duplex byte pipe.
//
// It moves bytes and reports when the pipe ends. Framing, call ids, the handshake, errors,
// cancellation and deadlines live in the runtime (`connection.ts`), the same on every transport.
// A transport may split or coalesce frames; the runtime decodes incrementally.

/** Where a pipe delivers what it receives. */
export interface PipeSink {
  /** Bytes from the server, in order. The runtime does not keep a reference to `bytes`. */
  data(bytes: Uint8Array): void;
  /**
   * The pipe ended. `error` is set when it ended abnormally (transport failure or abnormal
   * close); it must not carry credentials or payload bytes. Called at most once.
   */
  closed(error?: Error): void;
}

/** One open connection's byte pipe. */
export interface Pipe {
  /**
   * Sends bytes to the server. Implementations must preserve order across calls (queue if the
   * underlying channel is asynchronous). A failure closes the pipe through `PipeSink.closed`.
   */
  send(bytes: Uint8Array): void;
  /** Closes the pipe. `PipeSink.closed` is still called once. Idempotent. */
  close(): void;
  /**
   * Authentication material for `Hello.auth` (spec §3), e.g. the anti-CSRF token on web. Its
   * shape is defined by the server's `Authenticate` implementation. Never logged.
   */
  readonly auth?: unknown;
}

/** Opens pipes. Each `open` is a fresh connection (a new handshake follows). */
export interface Transport {
  /** Short name for diagnostics, e.g. `"websocket"` or `"tauri"`. */
  readonly name: string;
  /** Resolves once bytes can flow; rejects if the pipe cannot be opened. */
  open(sink: PipeSink): Promise<Pipe>;
}

/** The transport failed or closed abnormally. The message is safe to display. */
export class TransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportError";
  }
}
