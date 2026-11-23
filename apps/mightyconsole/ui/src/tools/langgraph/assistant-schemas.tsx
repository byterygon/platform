// An assistant's Schemas (DOC-21 §11.2.1, the TSK-91 mockup's langgraph-assistant-schemas,
// TSK-96): the five schemas in a list with their properties in a line; the selected one as a
// table of properties (type, required, description) or as JSON, with Copy; for the input schema
// an example input made from it, read only, and "Start a thread with it".
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CodeEditor } from "@/components/ui/code-editor";
import { Icon } from "@/components/ui/icon";
import { JsonView } from "@/app/json-view";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { CopyButton, gutterTable } from "@/app/page";
import { EmptyLine, ErrorState, LoadingRows } from "@/app/states";
import type * as api from "@/gen/api";
import { cn } from "@/lib/cn";
import { focusRing } from "@/lib/control";
import { Add } from "@/lib/icons";
import { example, schemaFacts, schemaProperties, schemaSummary } from "./schema-view";
import type { useLoad } from "./shared";

const KINDS = ["input", "output", "state", "config", "context"] as const;
type Kind = (typeof KINDS)[number];
const LABEL: Record<Kind, string> = { input: "Input", output: "Output", state: "State", config: "Config", context: "Context" };

const schemaOf = (s: api.AssistantSchemas, kind: Kind): unknown => ({ input: s.inputSchema, output: s.outputSchema, state: s.stateSchema, config: s.configSchema, context: s.contextSchema })[kind];
const present = (v: unknown) => v !== undefined && v !== null && !(typeof v === "object" && Object.keys(v as object).length === 0);

export function SchemasPanel({ schemas, onStart, starting }: { schemas: ReturnType<typeof useLoad<api.AssistantSchemas>>; onStart: (input: string) => void; starting: boolean }) {
  const [kind, setKind] = useState<Kind>("input");
  const [as, setAs] = useState<"tree" | "json">("tree");
  const data = schemas.data;
  const schema = data ? schemaOf(data, kind) : undefined;
  const props = useMemo(() => schemaProperties(schema), [schema]);
  const sampleText = useMemo(() => (kind === "input" && present(schema) ? JSON.stringify(example(schema), null, 2) : ""), [kind, schema]);
  if (schemas.error) return <ErrorState error={schemas.error} onRetry={() => void schemas.reload()} />;
  if (!data) return schemas.loading ? <LoadingRows label="Loading the schemas" /> : null;
  return (
    <div className="flex min-h-0 flex-1 border-t border-border-subtle">
      <nav aria-label="Schemas" className="flex w-panel-xs shrink-0 flex-col gap-stack-xs overflow-auto border-e border-border-subtle p-inset-xs">
        {KINDS.map((k) => {
          const s = schemaOf(data, k);
          return (
            <button key={k} type="button" aria-current={k === kind ? "true" : undefined} onClick={() => setKind(k)} className={cn("flex flex-col rounded-md px-inset-sm py-stack-xs text-start", k === kind ? "bg-accent-subtle" : "hover:bg-layer-alt", focusRing)}>
              <span className="text-body-1-strong text-fg">{LABEL[k]}</span>
              <span className="truncate text-caption-1 text-fg-muted">{present(s) ? schemaSummary(s) : "none"}</span>
            </button>
          );
        })}
      </nav>
      <section aria-label={`${LABEL[kind]} schema`} className="flex min-w-0 flex-1 flex-col overflow-auto">
        {!present(schema) ? (
          <EmptyLine>This graph has no {LABEL[kind].toLowerCase()} schema.</EmptyLine>
        ) : (
          <>
            <div className="flex items-center gap-inline-md px-inset-lg py-stack-sm">
              <h3 className="flex-1 text-body-1 text-fg-muted">
                <span className="text-body-1-strong text-fg">{LABEL[kind]} schema</span> {schemaFacts(schema)}
              </h3>
              <ToggleGroup aria-label="Show the schema as" size="small" value={[as]} onValueChange={(v) => v[0] && setAs(v[0] as typeof as)}>
                <ToggleGroupItem value="tree">Tree</ToggleGroupItem>
                <ToggleGroupItem value="json">JSON</ToggleGroupItem>
              </ToggleGroup>
              <CopyButton value={JSON.stringify(schema, null, 2)} what={`the ${LABEL[kind].toLowerCase()} schema`} />
            </div>
            {as === "json" ? (
              <div className="px-inset-lg pb-stack-md">
                <JsonView modeKey="langgraph.assistant.schema" value={schema as api.JsonValue} aria-label={`${LABEL[kind]} schema as JSON`} defaultExpandDepth={2} className="h-panel-sm" />
              </div>
            ) : props.length === 0 ? (
              <EmptyLine>No properties at the top level: see it as JSON.</EmptyLine>
            ) : (
              <Table aria-label={`${LABEL[kind]} schema's properties`} className={gutterTable}>
                <TableHeader>
                  <TableRow>
                    <TableHead>Property</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Required</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {props.map((p) => (
                    <TableRow key={p.name}>
                      <TableCell className="font-mono text-code">{p.name}</TableCell>
                      <TableCell className="font-mono text-code">{p.type}</TableCell>
                      <TableCell>
                        {p.required ? (
                          <Badge appearance="tint" variant="info">
                            required
                          </Badge>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{p.description}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            {kind === "input" ? (
              <div className="flex flex-col gap-stack-sm border-t border-border-subtle px-inset-lg py-stack-md">
                <div className="flex items-center gap-inline-md">
                  <h4 className="flex-1 text-body-1 text-fg-muted">
                    <span className="text-body-1-strong text-fg">Example input</span> made from the schema
                  </h4>
                  <Button size="small" loading={starting} onClick={() => onStart(sampleText)}>
                    <Icon icon={Add} /> Start a thread with it
                  </Button>
                </div>
                <CodeEditor language="json" aria-label="Example input" value={sampleText} readOnly rows={Math.min(12, sampleText.split("\n").length)} lineNumbers />
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}
