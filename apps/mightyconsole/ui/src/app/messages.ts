// How errors read in the UI (Mightyconsole spec §2.6, §3.5): the message, the target's own code,
// the correlation id under Details, and the action the error kind calls for.
import { isRpcError } from "@byterygon/ambidex";
import type { ToolError } from "@/gen/api";
import type { DescribedError } from "@/tools/types";
import { denialOf } from "./access";

export function describeError(error: unknown): DescribedError {
  if (isRpcError(error)) {
    const details = (error.details ?? undefined) as Partial<ToolError> | undefined;
    const out: DescribedError = { title: error.message || error.code, code: error.code };
    if (error.correlation_id) out.correlationId = error.correlation_id;
    if (details?.kind) out.kind = details.kind;
    if (details?.remote?.code) out.remoteCode = details.remote.code;
    if (details?.hostKey) out.hostKey = details.hostKey;
    if (details?.hop) out.hop = details.hop;
    if (details?.remote?.name) out.remoteName = details.remote.name;
    if (error.code === "Unavailable" && !details?.kind) out.description = "The server is not reachable.";
    const denied = denialOf(error);
    if (denied) out.denied = denied;
    return out;
  }
  return { title: error instanceof Error ? error.message : String(error) };
}

/**
 * One line of About's diagnostics (DOC-21 §3.5): the time, the code, the correlation id and the
 * server's message, nothing else. The details (the target's answer, a host key) stay out, and the
 * server's messages hold no secret (TSK-141's redaction test), so neither does this list. `null`
 * for an error without a correlation id (a local one, which the server log cannot match).
 */
export function diagnosticLine(d: DescribedError, at: Date): string | null {
  if (!d.correlationId) return null;
  return `${at.toISOString()} ${d.code ?? ""} ${d.correlationId} ${d.title}`;
}

/** The remedy a ToolError kind asks for (spec §2.6, "UI action"). */
export function remedyOf(error: DescribedError): "retry" | "editProfile" | "trust" | "refresh" | null {
  switch (error.kind) {
    case "Connect":
      return "retry";
    case "Auth":
    case "Tls":
      return "editProfile";
    case "HostKey":
      return "trust";
    case "NotFound":
      return "refresh";
    default:
      return error.code === "Unavailable" ? "retry" : null;
  }
}

/** "1,240" in the user's locale. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n));
}

/** A ToolError as it arrives inside another answer (a route Test's line): as `describeError` reads one. */
export function describeToolError(e: ToolError): DescribedError {
  const out: DescribedError = { title: e.message, kind: e.kind };
  if (e.remote?.code) out.remoteCode = e.remote.code;
  if (e.hostKey) out.hostKey = e.hostKey;
  if (e.hop) out.hop = e.hop;
  return out;
}
