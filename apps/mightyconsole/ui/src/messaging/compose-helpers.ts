// Helpers every tool's Composer screen shares (Mightyconsole spec §5.7): the profile's local
// schemas as the Composer offers them, and a failure's field and position (ToolError details) for
// the Composer and the filter bar.
import { isRpcError } from "@byterygon/ambidex";
import type * as api from "@/gen/api";
import type { ProfileRecord } from "@/profiles/record";
import type { SchemaChoice } from "./Composer";

/** The profile's local schemas (`extras.schemas`), as the Composer offers them. */
export function schemaChoices(profile: ProfileRecord): SchemaChoice[] {
  const schemas = profile.extras["schemas"];
  if (!Array.isArray(schemas)) return [];
  return schemas.filter((s): s is api.LocalSchema => typeof s === "object" && s !== null && "id" in s && "type" in s).map((s) => ({ id: s.id, name: s.name, type: s.type }));
}

/** An error's field and position (ToolError details), for the Composer and the filter bar. */
export function describeError(e: unknown): { title: string; field?: string; line?: number; column?: number } {
  if (isRpcError(e)) {
    const d = (e.details ?? {}) as { message?: string; field?: string; position?: { line: number; column: number } };
    return { title: d.message ?? e.message, ...(d.field ? { field: d.field } : {}), ...(d.position ? { line: d.position.line, column: d.position.column } : {}) };
  }
  return { title: e instanceof Error ? e.message : String(e) };
}
