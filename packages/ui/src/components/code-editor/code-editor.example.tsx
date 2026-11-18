import { useState } from "react";
import { CodeEditor, type CodeCompletion, type CodeDiagnostic } from "@/components/code-editor/code-editor";

/** The smallest useful CodeEditor: a JSON value. */
export function CodeEditorMinimal() {
  return <CodeEditor aria-label="Value" defaultValue={'{\n  "id": "o-17",\n  "total": 12.5\n}'} className="h-panel-xs" />;
}

const orderSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    status: { enum: ["PLACED", "PAID", "SHIPPED"] },
    total: { type: "number", minimum: 0 },
  },
  required: ["id", "status"],
  additionalProperties: false,
};

const FIELDS = ["status", "total", "customer"];

/** Suggestions for the filter: the payload's fields after a dot, jq's comparison operators after a space. */
const filterCompletion: CodeCompletion = {
  triggerCharacters: ["."],
  provide: ({ text, word }) => {
    const before = text.slice(0, word.start);
    if (before.endsWith(".value.")) return FIELDS.map((f) => ({ label: f, kind: "field", detail: "payload field" }));
    if (before.endsWith(".")) return [{ label: "value", kind: "field" }, { label: "key", kind: "field" }, { label: "headers", kind: "field" }];
    return ["==", "!=", ">", "<", "and", "or"].map((op) => ({ label: op, kind: "operator" }));
  },
};

/** A Composer payload: JSON checked against the message's schema, Mod+Enter sends; a one-line jq filter; a YAML diff. */
export function CodeEditorRealistic() {
  const [text, setText] = useState('{\n  "id": "o-17",\n  "status": "PAID",\n  "total": 12.5\n}');
  const [problems, setProblems] = useState<CodeDiagnostic[]>([]);
  const [sent, setSent] = useState<string | null>(null);
  const [filter, setFilter] = useState('.value.status == "PAID"');
  const [applied, setApplied] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-stack-sm">
      <CodeEditor
        aria-label="jq filter"
        language="jq"
        singleLine
        size="small"
        value={filter}
        onValueChange={setFilter}
        onSubmit={setApplied}
        completion={filterCompletion}
        invalid={filter.trim().endsWith("|")}
        placeholder=".value.total > 100"
      />
      <p className="text-caption-1 text-fg-muted" aria-live="polite">
        {applied === null ? "Enter applies the filter; Ctrl+Space suggests." : `Filtering by ${applied}`}
      </p>
      <CodeEditor aria-label="Payload" value={text} onValueChange={setText} jsonSchema={orderSchema} onDiagnosticsChange={setProblems} onSubmit={setSent} className="h-panel-xs" />
      <p className="text-caption-1 text-fg-muted" aria-live="polite">
        {problems.length ? `${problems.length} problem(s): ${problems[0]!.message}` : sent ? "Sent" : "Ctrl+Enter sends"}
      </p>
      <CodeEditor
        aria-label="Changes to apply"
        language="yaml"
        diff={{ original: "replicas: 2\nimage: shop:1.4\n" }}
        defaultValue={"replicas: 3\nimage: shop:1.5\n"}
        markers={[{ line: 2, column: 8, endColumn: 16, message: "Image not found in the registry", severity: "warning" }]}
        readOnly
        className="h-panel-xs"
      />
    </div>
  );
}
