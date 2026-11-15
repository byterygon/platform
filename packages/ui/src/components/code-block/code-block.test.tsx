import { createRef } from "react";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { CodeBlock } from "./code-block";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const lines = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-slot="code-block-line"]')];

describe("CodeBlock", () => {
  test("renders a labelled, focusable region with a <pre><code> and one element per line", async () => {
    const { container } = render(<CodeBlock title="q.sql" language="sql" code={"select 1;\nselect 2;"} />);
    const region = container.querySelector('[data-slot="code-block-scroller"]') as HTMLElement;
    expect(region.getAttribute("role")).toBe("region");
    expect(region.getAttribute("aria-label")).toBe("q.sql");
    expect(region.tabIndex).toBe(0);
    expect(region.querySelector("pre > code")).not.toBeNull();
    expect(lines(container)).toHaveLength(2);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("highlights SQL and JSON with the syntax roles", () => {
    const { container } = render(<CodeBlock language="sql" code="select 'a', 42 from t; -- note" />);
    const classes = [...container.querySelectorAll("pre span[class]")].map((s) => s.className);
    expect(classes).toContain("text-syntax-keyword");
    expect(classes).toContain("text-syntax-string");
    expect(classes).toContain("text-syntax-number");
    expect(classes).toContain("text-syntax-comment");
    cleanup();
    const json = render(<CodeBlock language="json" code={'{"a": true, "b": null}'} />);
    const jsonClasses = [...json.container.querySelectorAll("pre span[class]")].map((s) => s.className);
    expect(jsonClasses).toContain("text-syntax-type");
    expect(jsonClasses).toContain("text-syntax-constant");
  });

  test("line numbers start at startLine and highlighted lines are marked", () => {
    const { container } = render(<CodeBlock code={"a\nb\nc"} startLine={40} highlightLines={[41]} />);
    const gutters = [...container.querySelectorAll('[data-slot="code-block-gutter"]')].map((g) => g.textContent);
    expect(gutters).toEqual(["40", "41", "42"]);
    expect(lines(container).map((l) => l.hasAttribute("data-highlighted"))).toEqual([false, true, false]);
    expect(container.querySelector('[data-slot="code-block-gutter"]')!.getAttribute("aria-hidden")).toBe("true");
  });

  test("a single line has no gutter by default; text has no highlighting", () => {
    const { container } = render(<CodeBlock code="plain text" copyable={false} />);
    expect(container.querySelector('[data-slot="code-block-gutter"]')).toBeNull();
    expect(container.querySelector('[data-slot="code-block-header"]')).toBeNull();
    expect(container.querySelector("pre span[class*=syntax]")).toBeNull();
  });

  test("copy writes the whole text and announces it", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onCopy = vi.fn();
    const code = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
    const { container } = render(<CodeBlock code={code} onCopy={onCopy} />);
    await click(container.querySelector('[data-slot="icon-button"]')!);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(code));
    expect(onCopy).toHaveBeenCalledWith(code);
    await waitFor(() => expect(container.querySelector('[role="status"]')!.textContent).toBe("Copied to the clipboard"));
  });

  test("more than virtualizeAfter lines renders only a window, which follows the scroll", async () => {
    const code = Array.from({ length: 50_000 }, (_, i) => `select ${i};`).join("\n");
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<CodeBlock ref={ref} language="sql" code={code} />);
    expect(ref.current!.hasAttribute("data-virtual")).toBe(true);
    const rendered = lines(container);
    expect(rendered.length).toBeLessThan(120);
    expect(rendered[0]!.querySelector('[data-slot="code-block-gutter"]')!.textContent).toBe("1");
    const scroller = container.querySelector('[data-slot="code-block-scroller"]') as HTMLElement;
    Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 400 });
    scroller.scrollTop = 20 * 25_000;
    await act(async () => {
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const first = Number(lines(container)[0]!.querySelector('[data-slot="code-block-gutter"]')!.textContent);
    expect(first).toBeGreaterThan(24_900);
    expect(first).toBeLessThan(25_100);
  });

  test("wrap marks lines to wrap unless virtualized", () => {
    const { container } = render(<CodeBlock code={"a long line"} wrap />);
    expect(lines(container)[0]!.hasAttribute("data-wrap")).toBe(true);
  });
});
