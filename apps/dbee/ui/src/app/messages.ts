// The one English message catalogue (DBee spec §8, Decision 28): error text comes from the
// Ambidex code and the typed details, never from a backend string alone, and every error carries
// its correlation id so it can be matched with the audit log.
import { isRpcError } from "@byterygon/ambidex";
import type { ConnectionError, QueryError, SessionError, WorkspaceSaveError } from "@/gen/api";

export type Remedy = "editConnection" | "renewAccess" | "widenAddresses" | "reconnect" | "retry" | "openDiagnostics" | "enterPassword" | "reload" | "continueWithoutPassword";

export interface Described {
  title: string;
  description?: string;
  remedy?: Remedy;
  remedyLabel?: string;
  /** For syntax errors: the 1-based position the editor marks. */
  position?: number;
  sqlstate?: string;
  correlationId?: string;
  code?: string;
}

const REMEDY_LABELS: Record<Remedy, string> = {
  editConnection: "Edit connection",
  renewAccess: "Renew access",
  widenAddresses: "Widen (requires approval)",
  reconnect: "Reconnect",
  retry: "Retry",
  openDiagnostics: "Open diagnostics",
  enterPassword: "Enter password",
  reload: "Reload",
  continueWithoutPassword: "Continue without saving the password",
};

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function withRemedy(d: Described, remedy: Remedy): Described {
  return { ...d, remedy, remedyLabel: REMEDY_LABELS[remedy] };
}

function sessionError(e: SessionError): Described {
  switch (e.kind) {
    case "AuthenticationFailed":
      return withRemedy({ title: `Authentication failed for user ${e.user}` }, "editConnection");
    case "TlsFailed":
      return withRemedy({ title: "TLS failed", description: `The server certificate does not match the policy (${tlsName(e.policy)}).` }, "editConnection");
    case "PermissionDenied":
      switch (e.reason.kind) {
        case "Expired":
          return withRemedy({ title: `Access to this connection expired at ${time(e.reason.expiredAt)}` }, "renewAccess");
        case "Revoked":
          return { title: "Access was revoked" };
        case "AddressNotAllowed":
          return withRemedy({ title: `${e.reason.address} is not an allowed address`, description: "The database resolved to an address outside this connection's allowed addresses." }, "widenAddresses");
        case "Refused":
          return { title: "The grant refused the connection" };
      }
      break;
    case "ConnectionLost":
      return withRemedy({ title: "Connection lost" }, "reconnect");
    case "Timeout":
      return withRemedy({ title: `No answer from ${e.host}:${e.port} in 10 s` }, "retry");
    case "SecretMissing":
      return withRemedy({ title: "Enter the password for this session", description: "No password is stored for this connection." }, "enterPassword");
    case "Database":
      return { title: e.message, ...(e.sqlstate ? { sqlstate: e.sqlstate } : {}) };
    case "Unsupported":
      return { title: "Not supported", description: e.message };
    case "NotFound":
      return { title: "The connection no longer exists" };
  }
  return { title: "Could not connect" };
}

function queryError(e: QueryError): Described {
  switch (e.kind) {
    case "Syntax":
      return { title: e.message, ...(e.position !== null ? { position: e.position } : {}), ...(e.sqlstate ? { sqlstate: e.sqlstate } : {}) };
    case "Database":
      return { title: e.message, ...(e.sqlstate ? { sqlstate: e.sqlstate } : {}) };
    case "Connection":
      return withRemedy({ title: "Connection lost", description: e.message }, "reconnect");
    case "Cancelled":
      return { title: "Cancelled" };
    case "AccessEnded":
      return { title: "The statement was stopped when access expired; its outcome on the database is unknown" };
    case "Unsupported":
      return { title: "Not supported", description: e.message };
    case "NotFound":
      return { title: "The session no longer exists" };
  }
}

function connectionError(e: ConnectionError): Described {
  switch (e.kind) {
    case "InvalidTarget":
      return { title: `${e.field}: ${e.message}` };
    case "ResolveFailed":
      return { title: "The host could not be resolved", description: e.message };
    case "PreviewStale":
      return { title: "The preview changed", description: "The host resolves to other addresses now; the approval shows the fresh preview." };
    case "SecretStoreUnavailable":
      return withRemedy({ title: "No keychain is available", description: `${e.reason} The password can be kept for this session only.` }, "continueWithoutPassword");
    case "GrantRefused":
      return { title: "The grant was refused", description: e.reason };
    case "NotFound":
      return { title: "The connection no longer exists" };
  }
}

function workspaceError(e: WorkspaceSaveError): Described {
  switch (e.kind) {
    case "Conflict":
      return withRemedy({ title: "The workspace changed in another window" }, "reload");
    case "InvalidDocument":
      return { title: `The ${e.document} could not be saved`, description: e.message };
    case "WriteFailed":
      return { title: "Could not save tabs and settings", description: e.message };
  }
}

export function tlsName(kind: string): string {
  switch (kind) {
    case "deployment-ca":
      return "TLS required, verified against the deployment CA bundle";
    case "pinned-ca":
      return "TLS required, pinned CA";
    case "pinned-cert":
      return "TLS required, pinned server certificate";
    case "plaintext":
      return "PLAINTEXT: the password and data travel unencrypted";
    default:
      return kind;
  }
}

const isKind = (d: unknown): d is { kind: string } => typeof d === "object" && d !== null && "kind" in d;

/** The text, remedy and correlation id of any error a call failed with (spec §8). */
export function describeError(error: unknown, context: "connect" | "run" | "export" | "approve" | "workspace" | "general" = "general"): Described {
  if (!isRpcError(error)) {
    const message = error instanceof Error ? error.message : String(error);
    return { title: "Something went wrong", description: message };
  }
  const base: Pick<Described, "correlationId" | "code"> = { correlationId: error.correlation_id, code: error.code };
  const details = error.details;
  const typed = (): Described | undefined => {
    if (!isKind(details)) return undefined;
    if (context === "connect") return sessionError(details as SessionError);
    if (context === "run" || context === "export") return queryError(details as QueryError);
    if (context === "approve") return connectionError(details as ConnectionError);
    if (context === "workspace") return workspaceError(details as WorkspaceSaveError);
    return undefined;
  };
  switch (error.code) {
    case "InvalidArgument":
      return { ...base, ...(typed() ?? { title: error.message }) };
    case "FailedPrecondition":
    case "PermissionDenied":
    case "NotFound":
      return { ...base, ...(typed() ?? { title: error.message }) };
    case "Cancelled":
      return { ...base, title: "Cancelled" };
    case "DeadlineExceeded":
      return { ...base, title: context === "run" ? "Stopped after 1 h (maximum)" : "The call timed out" };
    case "ResourceExhausted":
      return { ...base, title: "Too many calls in flight" };
    case "Unavailable":
      return error.local
        ? { ...base, ...withRemedy({ title: "Lost the connection to the core" }, "reconnect") }
        : { ...base, ...withRemedy({ title: "The audit log is unavailable; nothing ran" }, "openDiagnostics") };
    case "Unauthenticated":
      return { ...base, title: "Your session ended", description: "Login is not available before Ambidex M3." };
    case "VersionMismatch":
      return { ...base, ...withRemedy({ title: "This page is out of date", description: "The server was upgraded; reload to get the matching version." }, "reload") };
    case "Unimplemented":
      return { ...base, title: "Not available in this shell", description: error.message };
    case "ApprovalRequired":
      return { ...base, title: "Approval required" };
    case "Internal":
      return { ...base, title: "Internal error", description: "The detail stayed on the server; quote the correlation id." };
  }
  return { ...base, title: error.message };
}

export const formatCount = (n: number): string => n.toLocaleString("en-US");

export function formatElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
