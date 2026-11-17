// How errors read in the UI (Mightyconsole spec §2.6, §3.5): the message, the target's own code,
// the correlation id under Details, and the action the error kind calls for.
import { isRpcError } from "@byterygon/ambidex";
import type { ToolError } from "@/gen/api";
import type { DescribedError } from "@/tools/types";

export function describeError(error: unknown): DescribedError {
  if (isRpcError(error)) {
    const details = (error.details ?? undefined) as Partial<ToolError> | undefined;
    const out: DescribedError = { title: error.message || error.code, code: error.code };
    if (error.correlation_id) out.correlationId = error.correlation_id;
    if (details?.kind) out.kind = details.kind;
    if (details?.remote?.code) out.remoteCode = details.remote.code;
    if (error.code === "Unavailable" && !details?.kind) out.description = "The server is not reachable.";
    return out;
  }
  return { title: error instanceof Error ? error.message : String(error) };
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
