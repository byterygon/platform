import { act, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, focus, honoursReducedMotion, key } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { flattenTree, Tree, type TreeNode } from "./tree";

afterEach(cleanup);

const nodes: TreeNode[] = [
  {
    id: "public",
    label: "public",
    children: [
      { id: "orders", label: "orders", children: [{ id: "orders.id", label: "id", meta: "bigint" }] },
      { id: "customers", label: "customers" },
    ],
  },
  { id: "audit", label: "audit", hasChildren: true },
];

const tree = () => $<HTMLDivElement>('[role="tree"]')!;
const items = () => $$('[role="treeitem"]');
const labels = () => items().map((item) => item.textContent);
const active = () => document.getElementById(tree().getAttribute("aria-activedescendant")!);

describe("Tree", () => {
  test("a named tree of treeitems with level, position and expanded state", async () => {
    const { container } = render(<Tree nodes={nodes} defaultExpanded={["public"]} aria-label="Schema" />);
    expect(tree().getAttribute("aria-label")).toBe("Schema");
    expect(tree().tabIndex).toBe(0);
    expect(labels()).toEqual(["public", "orders", "customers", "audit"]);
    const [pub, orders, customers, audit] = items();
    expect(pub!.getAttribute("aria-expanded")).toBe("true");
    expect(orders!.getAttribute("aria-level")).toBe("2");
    expect(orders!.getAttribute("aria-posinset")).toBe("1");
    expect(orders!.getAttribute("aria-setsize")).toBe("2");
    expect(orders!.getAttribute("aria-expanded")).toBe("false");
    expect(customers!.hasAttribute("aria-expanded")).toBe(false);
    expect(audit!.getAttribute("aria-expanded")).toBe("false");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("arrow keys move, open and close; Home, End and type-ahead jump", async () => {
    render(<Tree nodes={nodes} aria-label="Schema" />);
    await focus(tree());
    expect(active()!.textContent).toBe("public");
    await key("ArrowRight");
    expect(labels()).toEqual(["public", "orders", "customers", "audit"]);
    await key("ArrowRight");
    expect(active()!.textContent).toBe("orders");
    await key("ArrowRight");
    await key("ArrowRight");
    expect(active()!.textContent).toBe("idbigint");
    await key("ArrowLeft");
    expect(active()!.textContent).toBe("orders");
    await key("ArrowLeft");
    expect(labels()).toEqual(["public", "orders", "customers", "audit"]);
    await key("End");
    expect(active()!.textContent).toBe("audit");
    await key("Home");
    expect(active()!.textContent).toBe("public");
    await key("c");
    expect(active()!.textContent).toBe("customers");
    await key("ArrowLeft");
    expect(active()!.textContent).toBe("public");
  });

  test("Space selects, Enter selects and runs onAction, a click selects, the chevron toggles", async () => {
    const onAction = vi.fn();
    const onSelectedChange = vi.fn();
    render(<Tree nodes={nodes} defaultExpanded={["public"]} onAction={onAction} onSelectedChange={onSelectedChange} aria-label="Schema" />);
    await focus(tree());
    await key("ArrowDown");
    await key(" ");
    expect(onSelectedChange).toHaveBeenLastCalledWith("orders", expect.objectContaining({ id: "orders" }));
    expect(items()[1]!.getAttribute("aria-selected")).toBe("true");
    await key("Enter");
    expect(onAction).toHaveBeenLastCalledWith(expect.objectContaining({ id: "orders" }));
    await click(items()[2]!);
    expect(items()[2]!.getAttribute("aria-selected")).toBe("true");
    await click(items()[1]!.querySelector('[data-slot="tree-chevron"]')!);
    expect(labels()).toEqual(["public", "orders", "idbigint", "customers", "audit"]);
  });

  test("lazy children: the app loads on expand, a loading row shows, then the children; an error row retries", async () => {
    function Lazy({ onRetry }: { onRetry: () => void }) {
      const [audit, setAudit] = useState<Partial<TreeNode>>({ hasChildren: true });
      return (
        <Tree
          nodes={[{ id: "audit", label: "audit", ...audit }]}
          onExpandedChange={(_, node, open) => {
            if (open && node.id === "audit") setAudit({ loading: true });
          }}
          onRetry={onRetry}
          aria-label="Lazy"
        />
      );
    }
    const onRetry = vi.fn();
    const { container } = render(<Lazy onRetry={onRetry} />);
    await focus(tree());
    await key("ArrowRight");
    const loading = $('[data-slot="tree-loading"]')!;
    expect(loading.textContent).toBe("Loading…");
    expect(items()[0]!.getAttribute("aria-busy")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
    cleanup();

    render(<Tree nodes={[{ id: "s", label: "staging", error: "Could not load schemas" }]} defaultExpanded={["s"]} onRetry={onRetry} aria-label="Failed" />);
    expect($('[data-slot="tree-error"]')!.textContent).toBe("Could not load schemasRetry");
    const retry = $<HTMLButtonElement>('[data-slot="tree-retry"]')!;
    expect(retry.tabIndex).toBe(-1);
    await click(retry);
    expect(onRetry).toHaveBeenCalledTimes(1);
    await focus(tree());
    await key("ArrowDown");
    await key("Enter");
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  test("virtualized: 5,000 rows render only a window, and the keyboard scrolls the active row into it", async () => {
    const many: TreeNode[] = Array.from({ length: 5000 }, (_, i) => ({ id: `t${i}`, label: `table_${i}` }));
    render(<Tree nodes={many} aria-label="Tables" />);
    expect(items().length).toBeLessThan(60);
    await focus(tree());
    await key("End");
    expect(active()!.textContent).toBe("table_4999");
    expect(tree().scrollTop).toBeGreaterThan(0);
    await act(async () => {
      tree().scrollTop = 0;
      tree().dispatchEvent(new Event("scroll"));
    });
    expect(active()).not.toBeNull();
  });

  test("filter keeps matches and their ancestors; disabled nodes cannot be selected", async () => {
    render(<Tree nodes={[...nodes, { id: "x", label: "archive", disabled: true }]} filter="id" aria-label="Schema" />);
    expect(labels()).toEqual(["public", "orders", "idbigint"]);
    cleanup();
    const onSelectedChange = vi.fn();
    render(<Tree nodes={[{ id: "x", label: "archive", disabled: true }]} onSelectedChange={onSelectedChange} aria-label="Disabled" />);
    expect(items()[0]!.getAttribute("aria-disabled")).toBe("true");
    await click(items()[0]!);
    expect(onSelectedChange).not.toHaveBeenCalled();
    cleanup();
    render(<Tree nodes={[]} aria-label="Empty" />);
    expect($('[data-slot="tree-empty"]')!.textContent).toBe("Nothing to show");
  });

  test("flattenTree lists only visible rows", () => {
    expect(flattenTree(nodes, new Set(["public"])).map((row) => row.key)).toEqual(["public", "orders", "customers", "audit"]);
    expect(flattenTree(nodes, new Set()).map((row) => row.key)).toEqual(["public", "audit"]);
  });

  test("honours reduced motion", () => {
    render(<Tree nodes={nodes} defaultExpanded={["public"]} aria-label="Schema" />);
    expect(honoursReducedMotion($$("[data-slot^='tree']"))).toEqual([]);
  });
});
