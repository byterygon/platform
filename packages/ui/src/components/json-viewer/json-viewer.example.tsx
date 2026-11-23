import { useMemo, useState } from "react";
import { JsonViewer, type JsonViewerMode } from "@/components/json-viewer/json-viewer";
import { ToolbarButton } from "@/components/toolbar/toolbar";

/** The smallest useful JsonViewer: a small object, with the toolbar's Copy, Expand all, Find and Tree | Text. */
export function JsonViewerMinimal() {
  return <JsonViewer aria-label="Cell value" value={{ id: 1204, status: "open", paid: false, note: null }} className="h-panel-sm max-w-panel-md" />;
}

/**
 * A jsonb cell with nesting and a long string; an array of 100,000 events (virtualized in the tree
 * and in the text); a request read as text, with the mode remembered by the app and a tool's own
 * button in the `actions` slot; and invalid JSON text.
 */
export function JsonViewerRealistic() {
  const events = useMemo(() => ({ total: 100_000, items: Array.from({ length: 100_000 }, (_, i) => ({ id: i + 1, type: i % 3 ? "view" : "click" })) }), []);
  const [mode, setMode] = useState<JsonViewerMode>("text");
  return (
    <div className="flex w-full min-w-0 max-w-panel-xl flex-wrap items-start gap-gap-lg">
      <JsonViewer
        aria-label="payload of order 1204"
        defaultExpandDepth={2}
        value={{
          id: 1204,
          customer: { id: 77, name: "Analyst Two", tags: ["vip", "eu"] },
          total: 129.5,
          paid: true,
          shipped_at: null,
          notes: "Leave the parcel with the neighbour at number 14 if nobody answers; the customer asked twice for a call before delivery, and asked that the courier not ring the bell after 21:00.",
        }}
        className="h-panel-md w-panel-md"
      />
      <JsonViewer aria-label="events" value={events} defaultExpandDepth={2} className="h-panel-md w-panel-md" />
      <JsonViewer
        aria-label="request"
        mode={mode}
        onModeChange={setMode}
        value={{ method: "POST", path: "/orders", headers: { "content-type": "application/json" }, body: { sku: "A-1", quantity: 3 } }}
        actions={<ToolbarButton>Run jq…</ToolbarButton>}
        className="h-panel-md w-panel-md"
      />
      <JsonViewer aria-label="broken value" text={'{"id": 1, "status": open}'} className="w-panel-sm" />
    </div>
  );
}
