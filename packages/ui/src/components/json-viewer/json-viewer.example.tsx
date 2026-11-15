import { useMemo } from "react";
import { JsonViewer } from "@/components/json-viewer/json-viewer";

/** The smallest useful JsonViewer: a small object. */
export function JsonViewerMinimal() {
  return <JsonViewer aria-label="Cell value" value={{ id: 1204, status: "open", paid: false, note: null }} className="h-panel-xs max-w-panel-sm" />;
}

/** A jsonb cell with nesting and a long string, an array of 100,000 events (virtualized), and invalid JSON text. */
export function JsonViewerRealistic() {
  const events = useMemo(() => ({ total: 100_000, items: Array.from({ length: 100_000 }, (_, i) => ({ id: i + 1, type: i % 3 ? "view" : "click" })) }), []);
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
        className="h-panel-sm w-panel-md"
      />
      <JsonViewer aria-label="events" value={events} defaultExpandDepth={2} className="h-panel-sm w-panel-sm" />
      <JsonViewer aria-label="broken value" text={'{"id": 1, "status": open}'} className="w-panel-sm" />
    </div>
  );
}
