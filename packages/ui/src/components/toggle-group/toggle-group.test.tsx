import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { ToggleGroup, ToggleGroupItem } from "./toggle-group";

afterEach(cleanup);

function key(element: Element, key: string) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

function Views(props: Partial<Parameters<typeof ToggleGroup>[0]>) {
  return (
    <ToggleGroup aria-label="View" defaultValue={["grid"]} {...props}>
      <ToggleGroupItem value="grid">Grid</ToggleGroupItem>
      <ToggleGroupItem value="json">JSON</ToggleGroupItem>
      <ToggleGroupItem value="chart">Chart</ToggleGroupItem>
    </ToggleGroup>
  );
}

const pressed = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent);

describe("ToggleGroup", () => {
  test("renders a named group of toggle buttons, outline and md by default", async () => {
    const { container } = render(<Views />);
    const group = container.querySelector('[data-slot="toggle-group"]') as HTMLElement;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.dataset.variant).toBe("outline");
    expect(group.dataset.size).toBe("md");
    expect(group.dataset.orientation).toBe("horizontal");
    expect(container.querySelectorAll('[data-slot="toggle-group-item"]')).toHaveLength(3);
    expect(pressed(container)).toEqual(["Grid"]);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("single: pressing an item releases the others and reports the value", () => {
    const onValueChange = vi.fn();
    const { container } = render(<Views onValueChange={onValueChange} />);
    act(() => container.querySelectorAll("button")[1]!.click());
    expect(pressed(container)).toEqual(["JSON"]);
    expect(onValueChange).toHaveBeenLastCalledWith(["json"], expect.anything());
  });

  test("multiple: items press independently", () => {
    const { container } = render(<Views multiple />);
    act(() => container.querySelectorAll("button")[2]!.click());
    expect(pressed(container)).toEqual(["Grid", "Chart"]);
  });

  test("arrow keys move focus between items and wrap", async () => {
    const { container } = render(<Views />);
    const [grid, json, chart] = container.querySelectorAll("button");
    act(() => grid!.focus());
    key(grid!, "ArrowRight");
    // Base UI moves focus in a microtask.
    await act(async () => {});
    expect(document.activeElement).toBe(json);
    key(json!, "ArrowRight");
    await act(async () => {});
    expect(document.activeElement).toBe(chart);
    key(chart!, "ArrowRight");
    await act(async () => {});
    expect(document.activeElement).toBe(grid);
  });

  test("disabled disables every item", () => {
    const { container } = render(<Views disabled />);
    for (const button of container.querySelectorAll("button")) expect(button.hasAttribute("data-disabled")).toBe(true);
  });

  test("forwards the ref to the group", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Views ref={ref} />);
    expect(ref.current?.dataset.slot).toBe("toggle-group");
  });
});
