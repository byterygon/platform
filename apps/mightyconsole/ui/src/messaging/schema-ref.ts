// The `schemaRef` column's text (Mightyconsole spec §5.1) as the API's SchemaRef, for the Schema
// tab and "Open in Composer": `registry:<id>`, `registry:<subject>/<version>`,
// `local:<schemaId>[#MessageType]`.
import type { SchemaRef } from "@/gen/api";

export function parseSchemaRef(text: string | null): { schema: SchemaRef; messageType: string | null } | null {
  if (!text) return null;
  const [base, messageType = null] = text.split("#", 2) as [string, string?];
  if (base.startsWith("local:")) return { schema: { local: base.slice(6) }, messageType };
  if (base.startsWith("registry:")) {
    const rest = base.slice(9);
    if (/^\d+$/.test(rest)) return { schema: { registry: { id: Number(rest) } }, messageType };
    const at = rest.lastIndexOf("/");
    if (at > 0) {
      const v = rest.slice(at + 1);
      return { schema: { registry: { subject: rest.slice(0, at), version: v === "latest" ? "latest" : Number(v) } }, messageType };
    }
  }
  return null;
}
