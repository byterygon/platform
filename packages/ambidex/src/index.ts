// @byterygon/ambidex: the TypeScript runtime of Ambidex, the dual-transport RPC protocol
// (Ambidex spec §1, §5). Pair it with a generated `api.ts` (rpc-gen, spec §2):
//
//   import * as api from "./api.js";
//   import { createClient, autoTransport } from "@byterygon/ambidex";
//   const client = createClient(api, autoTransport());
export const PROTOCOL_NAME = "ambidex";

export type {
  CallOptions,
  Client,
  ErrorOf,
  InputOf,
  OutputOf,
  ProcedureCall,
  ProcedureKind,
  ProcedureLike,
  StreamCall,
  Subscription,
} from "./contract.js";

export {
  type AmbidexClient,
  type ApiIdentity,
  CLIENT_VERSION,
  type ClientControl,
  type ClientOptions,
  createClient,
  type GeneratedApi,
  StreamHandle,
  SubscriptionHandle,
} from "./client.js";
export type { HelloAck, Limits } from "./connection.js";
export {
  type CallError,
  type ErrorCode,
  type ErrorPayload,
  isErrorCode,
  isRpcError,
  RpcError,
} from "./errors.js";
export {
  DEFAULT_MAX_FRAME_BYTES,
  encodeFrame,
  FLAG_BINARY,
  type Frame,
  FrameDecoder,
  FrameError,
  HEADER_LEN,
  Kind,
  PROTOCOL_VERSION,
} from "./frame.js";
export { type Pipe, type PipeSink, type Transport, TransportError } from "./transport.js";
export {
  RPC_WS_PATH,
  type WebSocketLike,
  WebSocketTransport,
  type WebSocketTransportOptions,
} from "./websocket.js";
export {
  CONNECTION_HEADER,
  TAURI_COMMANDS,
  type TauriIpc,
  TauriTransport,
  type TauriTransportOptions,
} from "./tauri.js";
export { type AutoTransportOptions, autoTransport, isTauri } from "./auto.js";
