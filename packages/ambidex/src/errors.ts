// Error model (Ambidex spec §10), the runtime side of the generated `RpcError<D>` type.
//
// Every call rejects with an `RpcError`: either the server's `Error` frame, typed as it arrived,
// or a local error for things the server never answered (abort, a lost connection). Narrow with
// `isRpcError(e, procedure)` to get the generated discriminated union of that procedure, so
// `e.code === "ApprovalRequired"` narrows `details` as `api.ts` declares.

import type { ErrorOf, ProcedureLike } from "./contract.js";

/** Error codes, spec §10. Mirrors `ambidex::Code`; the generated `Code` type is the same union. */
export type ErrorCode =
  | "Cancelled"
  | "DeadlineExceeded"
  | "Unauthenticated"
  | "PermissionDenied"
  | "ApprovalRequired"
  | "InvalidArgument"
  | "NotFound"
  | "FailedPrecondition"
  | "ResourceExhausted"
  | "Unavailable"
  | "Unimplemented"
  | "VersionMismatch"
  | "Internal";

const CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "Cancelled",
  "DeadlineExceeded",
  "Unauthenticated",
  "PermissionDenied",
  "ApprovalRequired",
  "InvalidArgument",
  "NotFound",
  "FailedPrecondition",
  "ResourceExhausted",
  "Unavailable",
  "Unimplemented",
  "VersionMismatch",
  "Internal",
]);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && CODES.has(value);
}

/** The wire form of an `Error` (and the `Goaway`) payload, `ambidex::ErrorPayload`. */
export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly details?: unknown;
  readonly retryable: boolean;
  readonly correlation_id: string;
}

/**
 * An RPC error. Field names match the wire and the generated `RpcError<D>` (`correlation_id`
 * stays snake_case like the rest of the protocol), so an `RpcError` is assignable to it.
 *
 * `message` is the server's display-safe message or a fixed local one; the runtime never puts
 * call input or backend details into it. `local` is true when this side produced the error
 * (abort, client deadline, lost connection) rather than the server.
 */
export class RpcError<D = unknown> extends Error {
  readonly code: ErrorCode;
  readonly details?: D;
  readonly retryable: boolean;
  readonly correlation_id: string;
  readonly local: boolean;
  /** Full name of the procedure whose call failed; unset for connection-level errors. */
  readonly procedure?: string;

  constructor(
    code: ErrorCode,
    message: string,
    init: {
      details?: D;
      retryable?: boolean;
      correlation_id?: string;
      local?: boolean;
      procedure?: string;
    } = {},
  ) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    if (init.details !== undefined) this.details = init.details;
    this.retryable = init.retryable ?? false;
    this.correlation_id = init.correlation_id ?? "";
    this.local = init.local ?? false;
    if (init.procedure !== undefined) this.procedure = init.procedure;
  }

  /** The same error attributed to the call of `procedure`. */
  forProcedure(procedure: string): RpcError<D> {
    return new RpcError<D>(this.code, this.message, {
      ...(this.details !== undefined ? { details: this.details } : {}),
      retryable: this.retryable,
      correlation_id: this.correlation_id,
      local: this.local,
      procedure,
    });
  }

  /** Types an `Error` frame payload. Malformed payloads become a generic `Internal` error. */
  static fromPayload(payload: unknown, procedure?: string): RpcError {
    const attributed = procedure === undefined ? {} : { procedure };
    if (typeof payload !== "object" || payload === null) {
      return new RpcError("Internal", "malformed error", { local: true, ...attributed });
    }
    const p = payload as Record<string, unknown>;
    const code = isErrorCode(p["code"]) ? p["code"] : "Internal";
    const message = typeof p["message"] === "string" ? p["message"] : "";
    return new RpcError(code, message, {
      // `Internal` never carries details (the server scrubs them; this is belt and braces).
      ...(code !== "Internal" && p["details"] !== undefined && p["details"] !== null
        ? { details: p["details"] }
        : {}),
      retryable: p["retryable"] === true,
      correlation_id: typeof p["correlation_id"] === "string" ? p["correlation_id"] : "",
      ...attributed,
    });
  }

  toJSON(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {}),
      retryable: this.retryable,
      correlation_id: this.correlation_id,
    };
  }
}

/** `e` as the error union a call of `procedure` fails with (generated `RpcError<Details>`). */
export type CallError<P> = ErrorOf<P> & RpcError<unknown>;

/**
 * Whether `e` is an RPC error. With a procedure from the generated table it narrows to that
 * procedure's error union, so `details` is typed per `code`; it is true only for errors of a
 * call of that procedure, so the narrowing never applies one procedure's details to another.
 */
export function isRpcError(e: unknown): e is RpcError;
export function isRpcError<P extends ProcedureLike>(e: unknown, procedure: P): e is CallError<P>;
export function isRpcError(e: unknown, procedure?: ProcedureLike): boolean {
  return e instanceof RpcError && (procedure === undefined || e.procedure === procedure.name);
}

/** A local error: produced by the runtime, no correlation id. */
export function localError(
  code: ErrorCode,
  message: string,
  init: { retryable?: boolean; procedure?: string } = {},
): RpcError<never> {
  return new RpcError<never>(code, message, { ...init, local: true });
}
