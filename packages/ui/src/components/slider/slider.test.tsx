import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Slider } from "./slider";

afterEach(cleanup);

const key = (element: Element, key: string) => {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

describe("Slider", () => {
  test("a FieldLabel names the range input; the track uses size.track", async () => {
    const { container } = render(
      <Field>
        <FieldLabel>Sample rate</FieldLabel>
        <Slider defaultValue={25} />
      </Field>,
    );
    const input = container.querySelector('input[type="range"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.labels?.[0]?.textContent ?? container.querySelector(`#${input.getAttribute("aria-labelledby")}`)?.textContent).toBe("Sample rate");
    expect(input.getAttribute("aria-valuenow") ?? input.value).toBe("25");
    expect(container.querySelector('[data-slot="slider-track"]')!.className).toContain("h-track");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("arrow keys step and report the value", () => {
    const onValueChange = vi.fn();
    const { container } = render(<Slider aria-label="Rate" defaultValue={25} step={5} onValueChange={onValueChange} />);
    const input = container.querySelector('input[type="range"]')!;
    act(() => (input as HTMLElement).focus());
    key(input, "ArrowRight");
    expect(onValueChange).toHaveBeenLastCalledWith(30, expect.anything());
    key(input, "End");
    expect(onValueChange).toHaveBeenLastCalledWith(100, expect.anything());
  });

  test("a range renders two named thumbs", async () => {
    const { container } = render(<Slider defaultValue={[20, 80]} getAriaLabel={(i) => (i === 0 ? "Minimum" : "Maximum")} />);
    const inputs = [...container.querySelectorAll('input[type="range"]')];
    expect(inputs).toHaveLength(2);
    expect(inputs.map((i) => i.getAttribute("aria-label"))).toEqual(["Minimum", "Maximum"]);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("vertical: arrow up raises the value and the track turns", () => {
    const onValueChange = vi.fn();
    const { container } = render(<Slider aria-label="Zoom" orientation="vertical" defaultValue={50} onValueChange={onValueChange} />);
    expect(container.querySelector<HTMLElement>('[data-slot="slider"]')!.dataset.orientation).toBe("vertical");
    const input = container.querySelector('input[type="range"]')!;
    act(() => (input as HTMLElement).focus());
    key(input, "ArrowUp");
    expect(onValueChange).toHaveBeenLastCalledWith(51, expect.anything());
  });

  test("forwards the ref; disabled disables the input", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<Slider ref={ref} aria-label="Rate" disabled />);
    expect(ref.current?.dataset.slot).toBe("slider");
    expect(ref.current?.hasAttribute("data-disabled")).toBe(true);
    expect((container.querySelector('input[type="range"]') as HTMLInputElement).disabled).toBe(true);
  });
});
