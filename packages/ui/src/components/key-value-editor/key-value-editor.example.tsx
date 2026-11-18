import { useState } from "react";
import { KeyValueEditor, type KeyValueEntry } from "@/components/key-value-editor/key-value-editor";

/** The smallest useful KeyValueEditor: labels of a resource. */
export function KeyValueEditorMinimal() {
  const [labels, setLabels] = useState<KeyValueEntry[]>([{ key: "app", value: "orders" }]);
  return <KeyValueEditor aria-label="Labels" value={labels} onChange={setLabels} allowDuplicates={false} addLabel="Add label" />;
}

/** Message headers in the Composer: repeated names allowed, a binary value in base64, suggestions. */
export function KeyValueEditorRealistic() {
  const [headers, setHeaders] = useState<KeyValueEntry[]>([
    { key: "trace-id", value: "4bf92f3577b34da6", encoding: "text" },
    { key: "tag", value: "eu", encoding: "text" },
    { key: "tag", value: "priority", encoding: "text" },
    { key: "signature", value: "3q2+7w==", encoding: "base64" },
  ]);
  return (
    <KeyValueEditor
      aria-label="Headers"
      keyLabel="Name"
      value={headers}
      onChange={setHeaders}
      valueEncodings={["text", "base64"]}
      keySuggestions={["content-type", "trace-id", "tag", "correlation-id"]}
      addLabel="Add header"
    />
  );
}
