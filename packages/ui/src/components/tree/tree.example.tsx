import { Icon } from "@/components/icon/icon";
import { useState } from "react";
import { SearchInput } from "@/components/search-input/search-input";
import { Tree, type TreeNode } from "@/components/tree/tree";
import { Database, Folder, Table } from "@/lib/icons";

const FolderIcon = () => <Icon icon={Folder} />;

const TableIcon = () => <Icon icon={Table} />;

const DatabaseIcon = () => <Icon icon={Database} />;

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
      <SearchInput aria-label="Filter the tree" placeholder="Filter loaded nodes" size="small" value={filter} onValueChange={setFilter} />
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
