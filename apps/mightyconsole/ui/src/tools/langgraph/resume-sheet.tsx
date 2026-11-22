// Resume an interrupted run (DOC-21 §11.2.1, the TSK-91 mockup's langgraph-resume, TSK-96): the
// interrupt's own value first, then Resume with a value (`Command(resume=…)`, the options the
// graph listed suggested), Update state and continue (`Command(update=…)`) or Go to node
// (`Command(goto=…)`), and the run options folded.
import { useId, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Select, SelectItem } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type * as api from "@/gen/api";
import { ChevronDown, ChevronRight, Play } from "@/lib/icons";
import type { RunInterrupt } from "./run-events";
import { JsonField, parseJson, partialSchema, shortId } from "./shared";

export type ResumeMode = "resume" | "update" | "goto";

/** The options an interrupt lists (`options`, `choices`), as strings. */
export function interruptOptions(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  for (const key of ["options", "choices", "allowed"]) {
    const v = (value as Record<string, unknown>)[key];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  }
  return [];
}

/**
 * The schema that suggests an interrupt's options for the resume value: one of them as a string,
 * or an object whose `action` is one of them (as the mockup's `{ "action": "approve", … }`).
 */
export function optionsSchema(options: readonly string[]): object | undefined {
  if (options.length === 0) return undefined;
  return { anyOf: [{ type: "string", enum: options }, { type: "object", properties: { action: { type: "string", enum: options }, note: { type: "string" } } }, {}] };
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

export interface ResumeSheetProps {
  open: boolean;
  onClose: () => void;
  threadId: string;
  interrupts: readonly RunInterrupt[];
  waitingAt: readonly string[];
  nodes: readonly string[];
  stateSchema: unknown;
  /** The run options the resume goes with, in a line (assistant, stream modes, multitask strategy). */
  options: string;
  onResume: (command: api.RunCommand) => void;
}

export function ResumeSheet({ open, onClose, threadId, interrupts, waitingAt, nodes, stateSchema, options, onResume }: ResumeSheetProps) {
  const [mode, setMode] = useState<ResumeMode>("resume");
  const [text, setText] = useState('"approved"');
  const [node, setNode] = useState<string | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const optionsId = useId();
  const listed = interruptOptions(interrupts[0]?.value);
  const command = (): api.RunCommand | null => {
    if (mode === "goto") return node ? { resume: null, update: null, goto: node } : null;
    const parsed = parseJson(text);
    if (!parsed.ok || parsed.value === undefined) return null;
    return mode === "resume" ? { resume: parsed.value as api.JsonValue, update: null, goto: null } : { resume: null, update: parsed.value as api.JsonValue, goto: null };
  };
  const ready = command();
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()} size="lg">
      <SheetContent className="max-w-panel-sheet">
        <SheetHeader>
          <SheetTitle>Resume the run</SheetTitle>
          <SheetDescription>
            Thread {shortId(threadId)} · {waitingAt.length > 0 ? `interrupted at ${waitingAt.join(", ")}` : "interrupted"}
          </SheetDescription>
        </SheetHeader>
        <SheetBody className="flex flex-col gap-stack-lg">
          {interrupts.map((i, n) => (
            <Alert key={i.id ?? n} intent="info">
              <AlertTitle>The graph asked</AlertTitle>
              <AlertDescription>
                <pre aria-label="Interrupt value" className="max-h-panel-xs overflow-auto font-mono text-code whitespace-pre-wrap text-fg">
                  {pretty(i.value)}
                </pre>
              </AlertDescription>
            </Alert>
          ))}
          <ToggleGroup aria-label="How to continue" value={[mode]} onValueChange={(v) => v[0] && setMode(v[0] as ResumeMode)}>
            <ToggleGroupItem value="resume">Resume with a value</ToggleGroupItem>
            <ToggleGroupItem value="update">Update state and continue</ToggleGroupItem>
            <ToggleGroupItem value="goto">Go to node</ToggleGroupItem>
          </ToggleGroup>
          {mode === "goto" ? (
            <Field>
              <FieldLabel>Node</FieldLabel>
              <Select aria-label="Node" value={node} onValueChange={(v) => setNode(v as string)} placeholder="Choose a node">
                {nodes.map((n) => (
                  <SelectItem key={n} value={n}>
                    {n}
                  </SelectItem>
                ))}
              </Select>
            </Field>
          ) : (
            <JsonField
              label={mode === "resume" ? "Value for interrupt()" : "State update"}
              value={text}
              onChange={setText}
              rows={3}
              schema={mode === "update" ? partialSchema(stateSchema) : optionsSchema(listed)}
              description={mode === "resume" ? `Sent as Command(resume=…).${listed.length > 0 ? ` The options the graph listed are suggested: ${listed.join(", ")}.` : ""}` : "Sent as Command(update=…): written as the interrupted node, then the run goes on."}
            />
          )}
          <div className="flex flex-col gap-stack-sm border-t border-border-subtle pt-stack-md">
            <button type="button" aria-expanded={showOptions} aria-controls={optionsId} onClick={() => setShowOptions((s) => !s)} className="flex items-start gap-inline-sm text-start text-body-1 text-fg-muted">
              <Icon icon={showOptions ? ChevronDown : ChevronRight} className="mt-stack-xs shrink-0" />
              <span>
                <span className="text-body-1-strong text-fg">Run options</span> · {options}
              </span>
            </button>
            {showOptions ? (
              <p id={optionsId} className="text-body-1 text-fg-muted">
                The resume runs with the Run form's assistant and options; change them in its Advanced fold.
              </p>
            ) : null}
          </div>
        </SheetBody>
        <SheetFooter>
          <span className="flex-1" />
          <Button onClick={onClose}>Cancel</Button>
          <Button
            appearance="primary"
            disabled={ready === null}
            onClick={() => {
              if (!ready) return;
              onClose();
              onResume(ready);
            }}
          >
            <Icon icon={Play} /> Resume
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
