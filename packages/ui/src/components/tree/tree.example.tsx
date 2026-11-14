import { useState } from "react";
import { SearchInput } from "@/components/search-input/search-input";
import { Tree, type TreeNode } from "@/components/tree/tree";

const FolderIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <path d="M2.5 4.5h4l1.5 1.5h5.5v6.5h-11z" />
  </svg>
);

const TableIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="2.5" y="3" width="11" height="10" rx="1" />
    <path d="M2.5 6.5h11M6.5 6.5V13" />
  </svg>
);

const DatabaseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <ellipse cx="8" cy="4" rx="5" ry="1.75" />
    <path d="M3 4v8c0 1 2.2 1.75 5 1.75s5-.75 5-1.75V4M3 8c0 1 2.2 1.75 5 1.75S13 9 13 8" />
  </svg>
);

/** The smallest useful Tree: a schema with its tables and columns. */
export function TreeMinimal() {
  const nodes: TreeNode[] = [
    {
      id: "public",
      label: "public",
      icon: <FolderIcon />,
      children: [
        { id: "orders", label: "orders", icon: <TableIcon />, children: [{ id: "orders.id", label: "id", meta: "bigint" }, { id: "orders.status", label: "status", meta: "text" }] },
        { id: "customers", label: "customers", icon: <TableIcon /> },
      ],
    },
  ];
  return <Tree nodes={nodes} defaultExpanded={["public"]} aria-label="Schema" className="h-panel-xs w-full" />;
}

const manyTables = (schema: string, count: number): TreeNode[] =>
  Array.from({ length: count }, (_, i) => ({ id: `${schema}.t${i}`, label: `event_${String(i).padStart(4, "0")}`, icon: <TableIcon />, meta: `${(i * 37) % 900} kB` }));

/**
 * DBee's schema browser: connections with a status, a lazily loaded schema (loading, then
 * children), one that failed with Retry, a schema of 2,000 tables (only the visible rows are
 * rendered), and the filter box above it.
 */
export function TreeRealistic() {
  const [filter, setFilter] = useState("");
  const [analytics, setAnalytics] = useState<Partial<TreeNode>>({ hasChildren: true });
  const [failed, setFailed] = useState<Partial<TreeNode>>({ error: "Could not load schemas: connection refused" });
  const nodes: TreeNode[] = [
    {
      id: "orders-prod",
      label: "orders-prod",
      icon: <DatabaseIcon />,
      meta: "TLS",
      children: [
        { id: "orders-prod.public", label: "public", icon: <FolderIcon />, children: manyTables("public", 2000) },
        { id: "orders-prod.analytics", label: "analytics", icon: <FolderIcon />, ...analytics },
      ],
    },
    { id: "staging", label: "staging", icon: <DatabaseIcon />, meta: "expires in 14 min", ...failed },
    { id: "archive", label: "archive (disconnected)", icon: <DatabaseIcon />, disabled: true },
  ];
  const load = (_: string[], node: TreeNode, open: boolean) => {
    if (!open || node.id !== "orders-prod.analytics" || analytics.children) return;
    setAnalytics({ loading: true });
    setTimeout(() => setAnalytics({ children: [{ id: "analytics.daily", label: "daily_revenue", icon: <TableIcon /> }] }), 600);
  };
  const retry = (node: TreeNode) => {
    if (node.id !== "staging") return;
    setFailed({ loading: true });
    setTimeout(() => setFailed({ children: [{ id: "staging.public", label: "public", icon: <FolderIcon /> }] }), 600);
  };
  return (
    <div className="flex w-full flex-col gap-stack-sm">
      <SearchInput aria-label="Filter the tree" placeholder="Filter loaded nodes" size="sm" value={filter} onValueChange={setFilter} />
      <Tree
        nodes={nodes}
        defaultExpanded={["orders-prod", "orders-prod.public", "staging"]}
        onExpandedChange={load}
        onRetry={retry}
        filter={filter}
        aria-label="Connections and schemas"
        className="h-panel-sm w-full rounded-md border border-border"
      />
    </div>
  );
}
