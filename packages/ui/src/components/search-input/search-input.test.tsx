import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { SearchInput } from "./search-input";

afterEach(cleanup);

const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const escape = (element: Element) => {
  const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
};

describe("SearchInput", () => {
  test("is a labelled searchbox with no Clear button while empty", async () => {
    const { container } = render(
      <Field>
        <FieldLabel>Filter tables</FieldLabel>
        <SearchInput />
      </Field>,
    );
    const input = container.querySelector("input")!;
    expect(input.type).toBe("search");
    expect(input.labels?.[0]?.textContent).toBe("Filter tables");
    expect(container.querySelector('[data-slot="search-input"]')).not.toBeNull();
    expect(container.querySelector("button")!.hidden).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("typing shows Clear, which empties the box and refocuses it", () => {
    const onValueChange = vi.fn();
    const { container } = render(<SearchInput aria-label="Search" onValueChange={onValueChange} />);
    const input = container.querySelector("input")!;
    type(input, "ord");
    expect(onValueChange).toHaveBeenLastCalledWith("ord");
    const clear = container.querySelector("button")!;
    expect(clear.hidden).toBe(false);
    expect(clear.getAttribute("aria-label")).toBe("Clear search");
    act(() => clear.click());
    expect(input.value).toBe("");
    expect(onValueChange).toHaveBeenLastCalledWith("");
    expect(document.activeElement).toBe(input);
    expect(container.querySelector("button")!.hidden).toBe(true);
  });

  test("Escape clears the text, and passes through when empty", () => {
    const { container } = render(<SearchInput aria-label="Search" defaultValue="orders" />);
    const input = container.querySelector("input")!;
    expect(escape(input).defaultPrevented).toBe(true);
    expect(input.value).toBe("");
    expect(escape(input).defaultPrevented).toBe(false);
  });

  test("controlled value follows the prop", () => {
    const onValueChange = vi.fn();
    const { container } = render(<SearchInput aria-label="Search" value="orders" onValueChange={onValueChange} />);
    act(() => container.querySelector("button")!.click());
    expect(onValueChange).toHaveBeenCalledWith("");
    expect(container.querySelector("input")!.value).toBe("orders");
  });

  test("forwards the ref to the input; disabled hides Clear", () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(<SearchInput ref={ref} aria-label="Search" defaultValue="x" disabled />);
    expect(ref.current).toBe(container.querySelector("input"));
    expect(ref.current!.disabled).toBe(true);
    expect(container.querySelector("button")!.hidden).toBe(true);
  });
});
