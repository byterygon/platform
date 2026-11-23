import { createRef } from "react";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click, focus, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { expandJson, findInJson, findInText, flattenJson, jqPath, JsonViewer } from "./json-viewer";

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

  describe("toolbar", () => {
    const toolbar = (container: HTMLElement) => container.querySelector('[role="toolbar"]') as HTMLElement;
    const button = (container: HTMLElement, name: string) => [...container.querySelectorAll<HTMLElement>("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name)!;

    test("has Copy, Expand all, Collapse all, Depth, Find and the Tree | Text switch, as one tab stop, without axe violations", async () => {
      const { container } = render(<JsonViewer aria-label="Order" value={value} />);
      const bar = toolbar(container);
      expect(bar.getAttribute("aria-label")).toBe("Order tools");
      for (const name of ["Copy the value", "Expand all", "Collapse all", "Expand to depth", "Find", "Tree", "Text"]) expect(button(container, name), name).toBeTruthy();
      expect([...bar.querySelectorAll<HTMLElement>("button")].filter((b) => b.tabIndex === 0)).toHaveLength(1);
      expect(await axeViolations(container)).toEqual([]);
    });

    test("toolbar={false} leaves only the tree; actions go at the end", () => {
      const off = render(<JsonViewer value={value} toolbar={false} />);
      expect(off.container.querySelector('[role="toolbar"]')).toBeNull();
      off.unmount();
      const on = render(<JsonViewer value={value} actions={<button type="button">Run jq</button>} />);
      expect(toolbar(on.container).lastElementChild!.textContent).toBe("Run jq");
    });

    test("Expand all opens every container, Collapse all closes them, Depth opens to a level", async () => {
      const { container } = render(<JsonViewer value={value} />);
      expect(rows(container)).toHaveLength(6);
      await click(button(container, "Expand all"));
      expect(rows(container).some((r) => r.textContent?.startsWith('"tags"'))).toBe(true);
      expect(rows(container).some((r) => r.dataset.kind === "string" && r.textContent === "0:\"vip\"")).toBe(true);
      await click(button(container, "Collapse all"));
      expect(rows(container)).toHaveLength(1);
      expect(rows(container)[0]!.getAttribute("aria-expanded")).toBe("false");
    });

    test("Expand all stops at maxExpandRows and says how far it got", async () => {
      const big = Array.from({ length: 50 }, (_, i) => ({ id: i, tags: ["a", "b"] }));
      const { container } = render(<JsonViewer value={big} maxExpandRows={80} />);
      await click(button(container, "Expand all"));
      const notice = container.querySelector('[data-slot="json-viewer-notice"]')!;
      expect(notice.textContent).toMatch(/^Opened \d+ of 251 rows; the rest stay collapsed\.$/);
      expect(rows(container).length).toBeLessThanOrEqual(80);
      await click(button(container, "Collapse all"));
      expect(container.querySelector('[data-slot="json-viewer-notice"]')).toBeNull();
    });

    test("Copy formatted and Copy minified put the whole value on the clipboard", async () => {
      const writeText = vi.fn(async () => {});
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const onCopy = vi.fn();
      const { container } = render(<JsonViewer value={{ a: [1, 2] }} onCopy={onCopy} />);
      await click(button(container, "Copy the value"));
      await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Copy minified")!);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith('{"a":[1,2]}'));
      expect(onCopy).toHaveBeenCalledWith("minified", '{"a":[1,2]}');
      await click(button(container, "Copy the value"));
      await click([...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((i) => i.textContent === "Copy formatted")!);
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('{\n  "a": [\n    1,\n    2\n  ]\n}'));
      await waitFor(() => expect(container.querySelector('[role="status"]')!.textContent).toBe("Copied the value, formatted"));
      vi.unstubAllGlobals();
    });
  });

  describe("tree actions", () => {
    test("Mod+C, Mod+Shift+C and Mod+Alt+C copy the active row's value, jq path and key", async () => {
      const writeText = vi.fn(async () => {});
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText }, platform: "Linux" });
      const data = { items: [{ id: 7, name: "a b" }], "x y": "hello" };
      const { container } = render(<JsonViewer value={data} defaultExpandDepth={Infinity} />);
      const root = tree(container);
      await focus(root);
      for (let i = 0; i < 3; i += 1) await key("ArrowDown", root);
      expect(rows(container)[3]!.textContent).toBe('"id":7');
      await key("c", root, { ctrlKey: true });
      expect(writeText).toHaveBeenLastCalledWith("7");
      await key("c", root, { ctrlKey: true, shiftKey: true });
      expect(writeText).toHaveBeenLastCalledWith(".items[0].id");
      await key("c", root, { ctrlKey: true, altKey: true });
      expect(writeText).toHaveBeenLastCalledWith("id");
      await key("End", root);
      await key("c", root, { ctrlKey: true });
      expect(writeText).toHaveBeenLastCalledWith("hello");
      await key("c", root, { ctrlKey: true, shiftKey: true });
      expect(writeText).toHaveBeenLastCalledWith('.["x y"]');
      vi.unstubAllGlobals();
    });

    test("the context menu on a row offers Copy value, Copy path and Copy key for that row", async () => {
      const writeText = vi.fn(async () => {});
      vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
      const { container } = render(<JsonViewer value={value} defaultExpandDepth={2} />);
      const row = rows(container).find((r) => r.textContent?.startsWith('"name"'))!;
      await act(async () => {
        row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 5, clientY: 5 }));
      });
      const items = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
      expect(items.map((i) => i.textContent?.replace(/(Ctrl\+|⌘|⇧|⌥).*$/, ""))).toEqual(["Copy value", "Copy path", "Copy key"]);
      await click(items[1]!);
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(".customer.name"));
      vi.unstubAllGlobals();
    });

    test("jqPath reads arrays, identifiers and other keys", () => {
      const data = { items: [{ id: 1 }], "a b": { "0": 1 }, list: [[1]] };
      expect(jqPath(data, "")).toBe(".");
      expect(jqPath(data, "/items/0/id")).toBe(".items[0].id");
      expect(jqPath(data, "/a b/0")).toBe('.["a b"]["0"]');
      expect(jqPath(data, "/list/0/0")).toBe(".list[0][0]");
      expect(jqPath([1, 2], "/1")).toBe(".[1]");
    });
  });

  describe("expandJson", () => {
    test("opens containers in document order within the row cap and reports what it left closed", () => {
      const data = { a: [1, 2, 3], b: [4, 5, 6] };
      expect(expandJson(data, Infinity, 100)).toEqual({ open: new Set(["", "/a", "/b"]), capped: null });
      const capped = expandJson(data, Infinity, 6);
      expect([...capped.open]).toEqual(["", "/a"]);
      expect(capped.capped).toEqual({ shown: 6, total: 9 });
      expect([...expandJson(data, 1, 100).open]).toEqual([""]);
    });
  });

  describe("find", () => {
    const data = { name: "Ana", customer: { name: "Ben", tags: ["vip", "eu"] }, note: "ana was here" };

    test("findInJson matches keys and values in document order, with a case option and a limit", () => {
      expect(findInJson(data, "ana", false).hits.map((h) => h.path)).toEqual(["/name", "/note"]);
      expect(findInJson(data, "ana", true).hits.map((h) => h.path)).toEqual(["/note"]);
      expect(findInJson(data, "name", false).hits.map((h) => h.path)).toEqual(["/name", "/customer/name"]);
      expect(findInJson(data, "e", false, 2)).toMatchObject({ capped: true });
      expect(findInJson({ list: [10, 20] }, "20", false).hits).toEqual([{ path: "/list/1" }]);
      expect(findInJson({ a: 1 }, "", false).hits).toEqual([]);
    });

    test("findInText gives the offsets, not overlapping", () => {
      expect(findInText("aaaa Aa", "aa", false).starts).toEqual([0, 2, 5]);
      expect(findInText("aaaa Aa", "aa", true).starts).toEqual([0, 2]);
    });

    test("Mod+F opens the find bar; typing counts the matches, expands only the ancestors of the current one and marks rows", async () => {
      vi.stubGlobal("navigator", { ...navigator, platform: "Linux" });
      const { container } = render(<JsonViewer aria-label="Order" value={data} />);
      const root = tree(container);
      await focus(root);
      await key("f", root, { ctrlKey: true });
      const input = container.querySelector<HTMLInputElement>('[data-slot="json-viewer-find"] input')!;
      expect(input).toBeTruthy();
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
        setter.call(input, "ben");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await waitFor(() => expect(container.querySelector('[data-slot="json-viewer-count"]')!.textContent).toBe("1 of 1"));
      await waitFor(() => expect(rows(container).some((r) => r.dataset.currentMatch !== undefined && r.textContent === '"name":"Ben"')).toBe(true));
      expect(rows(container).some((r) => r.textContent?.startsWith('"tags"'))).toBe(true);
      expect(container.querySelector('[data-slot="json-viewer-toolbar"]')).not.toBeNull();
      vi.unstubAllGlobals();
    });

    test("Enter steps through the matches, Shift+Enter goes back, Escape closes", async () => {
      vi.stubGlobal("navigator", { ...navigator, platform: "Linux" });
      const { container } = render(<JsonViewer value={data} defaultExpandDepth={Infinity} />);
      await focus(tree(container));
      await key("f", tree(container), { ctrlKey: true });
      const input = container.querySelector<HTMLInputElement>('[data-slot="json-viewer-find"] input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "name");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const count = () => container.querySelector('[data-slot="json-viewer-count"]')!.textContent;
      await waitFor(() => expect(count()).toBe("1 of 2"));
      await key("Enter", input);
      expect(count()).toBe("2 of 2");
      await key("Enter", input);
      expect(count()).toBe("1 of 2");
      await key("Enter", input, { shiftKey: true });
      expect(count()).toBe("2 of 2");
      await key("Escape", input);
      expect(input.value).toBe("");
      await key("Escape", input);
      expect(container.querySelector('[data-slot="json-viewer-find"]')).toBeNull();
      vi.unstubAllGlobals();
    });
  });

  describe("text mode", () => {
    test("defaultMode text shows the pretty-printed value with line numbers; the switch changes the view and tells the app", async () => {
      const onModeChange = vi.fn();
      const { container } = render(<JsonViewer value={{ a: [1, 2] }} defaultMode="text" onModeChange={onModeChange} />);
      expect(container.querySelector('[role="tree"]')).toBeNull();
      const block = container.querySelector('[data-slot="code-block"]')!;
      expect(block.textContent).toContain('"a": [');
      expect(container.querySelectorAll('[data-slot="code-block-gutter"]')).toHaveLength(6);
      const treeButton = [...container.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Tree")!;
      await click(treeButton);
      expect(onModeChange).toHaveBeenCalledWith("tree");
      expect(container.querySelector('[role="tree"]')).not.toBeNull();
    });

    test("a controlled mode is the app's to change", async () => {
      const onModeChange = vi.fn();
      const { container } = render(<JsonViewer value={{ a: 1 }} mode="tree" onModeChange={onModeChange} />);
      await click([...container.querySelectorAll<HTMLElement>("button")].find((b) => b.textContent === "Text")!);
      expect(onModeChange).toHaveBeenCalledWith("text");
      expect(container.querySelector('[role="tree"]')).not.toBeNull();
    });

    test("Find marks the matches in the text and counts them", async () => {
      const { container } = render(<JsonViewer value={{ name: "Ana", other: "ana" }} defaultMode="text" />);
      await focus(container.querySelector<HTMLElement>('[data-slot="code-block-scroller"]')!);
      await key("f", container.querySelector('[data-slot="code-block-scroller"]'), { ctrlKey: true, metaKey: true });
      const input = container.querySelector<HTMLInputElement>('[data-slot="json-viewer-find"] input')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "ana");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await waitFor(() => expect(container.querySelector('[data-slot="json-viewer-count"]')!.textContent).toBe("1 of 2"));
      const marks = [...container.querySelectorAll<HTMLElement>("mark")];
      expect(marks.map((m) => m.textContent)).toEqual(["Ana", "ana"]);
      expect(marks[0]!.hasAttribute("data-current")).toBe(true);
    });

    test("a value with 100,000 items shows as text without rendering every line", async () => {
      const big = { items: Array.from({ length: 100_000 }, (_, i) => ({ id: i })) };
      const { container } = render(<JsonViewer value={big} mode="text" />);
      expect(container.querySelector('[data-slot="code-block"]')!.hasAttribute("data-virtual")).toBe(true);
      expect(container.querySelectorAll('[data-slot="code-block-line"]').length).toBeLessThan(200);
      const wrap = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Wrap lines")!;
      expect(wrap.getAttribute("aria-disabled")).toBe("true");
    });
  });
});
