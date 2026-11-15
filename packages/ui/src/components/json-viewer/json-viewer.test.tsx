import { createRef } from "react";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click, focus, key } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { flattenJson, JsonViewer } from "./json-viewer";

afterEach(cleanup);

const value = { id: 1, customer: { name: "Ana", tags: ["vip"] }, paid: true, note: null, total: 12.5 };
const rows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')];
const tree = (container: HTMLElement) => container.querySelector('[role="tree"]') as HTMLElement;

describe("JsonViewer", () => {
  test("flattenJson lists only expanded containers' children, with JSON Pointer paths", () => {
    expect(flattenJson(value, new Set([""])).map((r) => r.path)).toEqual(["", "/id", "/customer", "/paid", "/note", "/total"]);
    expect(flattenJson(value, new Set(["", "/customer"])).map((r) => r.path)).toContain("/customer/tags");
    expect(flattenJson({ "a/b": 1 }, new Set([""]))[1]!.path).toBe("/a~1b");
  });

  test("is a tree with one tab stop; rows have level, set size and position, values their syntax colour", async () => {
    const { container } = render(<JsonViewer aria-label="Value" value={value} />);
    const root = tree(container);
    expect(root.tabIndex).toBe(0);
    expect(root.getAttribute("aria-label")).toBe("Value");
    const [top, id] = rows(container);
    expect(top!.getAttribute("aria-expanded")).toBe("true");
    expect(id!.getAttribute("aria-level")).toBe("2");
    expect(id!.getAttribute("aria-setsize")).toBe("5");
    expect(id!.textContent).toBe('"id":1');
    expect(id!.querySelector(".text-syntax-number")).not.toBeNull();
    expect(rows(container).find((r) => r.dataset.kind === "null")!.querySelector(".text-syntax-constant")).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("keyboard: Down moves, Right opens then enters, Left closes then goes to the parent", async () => {
    const onActiveChange = vi.fn();
    const { container } = render(<JsonViewer value={value} onActiveChange={onActiveChange} />);
    const root = tree(container);
    await focus(root);
    await key("ArrowDown", root);
    await key("ArrowDown", root);
    expect(onActiveChange).toHaveBeenLastCalledWith("/customer", value.customer);
    expect(root.getAttribute("aria-activedescendant")).toBe(rows(container)[2]!.id);
    await key("ArrowRight", root);
    expect(rows(container)[2]!.getAttribute("aria-expanded")).toBe("true");
    await key("ArrowRight", root);
    expect(onActiveChange).toHaveBeenLastCalledWith("/customer/name", "Ana");
    await key("ArrowLeft", root);
    expect(onActiveChange).toHaveBeenLastCalledWith("/customer", value.customer);
    await key("ArrowLeft", root);
    expect(rows(container)[2]!.getAttribute("aria-expanded")).toBe("false");
    await key("End", root);
    expect(onActiveChange).toHaveBeenLastCalledWith("/total", 12.5);
  });

  test("a click toggles a container", async () => {
    const { container } = render(<JsonViewer value={value} />);
    const customer = rows(container)[2]!;
    await click(customer);
    expect(rows(container).some((r) => r.textContent?.startsWith('"name"'))).toBe(true);
  });

  test("an expanded array of 100,000 items renders only a window", async () => {
    const big = Array.from({ length: 100_000 }, (_, i) => i);
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<JsonViewer ref={ref} value={big} />);
    await act(async () => {});
    expect(rows(container).length).toBeLessThan(60);
    const inner = ref.current!.firstElementChild as HTMLElement;
    expect(Number.parseFloat(inner.style.height)).toBeGreaterThan(100_000);
  });

  test("text is parsed; invalid JSON shows an alert with the parser's message", () => {
    const ok = render(<JsonViewer text={'{"a": [1, 2]}'} />);
    expect(rows(ok.container)).toHaveLength(2);
    ok.unmount();
    const bad = render(<JsonViewer text="{oops" />);
    const alert = bad.container.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("Not valid JSON:");
  });

  test("long strings are cut in the row and kept whole in its title", () => {
    const long = "x".repeat(50);
    const { container } = render(<JsonViewer value={{ s: long }} maxStringLength={10} />);
    const row = rows(container).find((r) => r.dataset.kind === "string")!;
    expect(row.textContent).toContain("…");
    expect(row.getAttribute("title")).toBe(long);
  });
});
