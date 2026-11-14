import { useForm } from "@tanstack/react-form";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { NumberInput } from "./number-input";

afterEach(cleanup);

const key = (element: Element, key: string, init: KeyboardEventInit = {}) => {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
};

const press = (button: Element) => {
  act(() => {
    button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    button.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }));
    (button as HTMLElement).click();
  });
};

describe("NumberInput", () => {
  test("a FieldLabel names the input; the step buttons are named", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Port</FieldLabel>
        <NumberInput defaultValue={5432} />
        <FieldError>Out of range.</FieldError>
      </Field>,
    );
    const input = container.querySelector("input:not([type=hidden])") as HTMLInputElement;
    expect(input.labels?.[0]?.textContent).toBe("Port");
    expect(input.value).toBe("5,432");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[data-slot="number-input-decrement"]')!.getAttribute("aria-label")).toBe("Decrease");
    expect(container.querySelector('[data-slot="number-input-increment"]')!.getAttribute("aria-label")).toBe("Increase");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("arrow keys step, Shift+arrow takes the large step", () => {
    const onValueChange = vi.fn();
    const { container } = render(<NumberInput aria-label="Pool" defaultValue={10} onValueChange={onValueChange} />);
    const input = container.querySelector('[data-slot="number-input-input"]')!;
    act(() => (input as HTMLElement).focus());
    key(input, "ArrowUp");
    expect(onValueChange).toHaveBeenLastCalledWith(11, expect.anything());
    key(input, "ArrowDown", { shiftKey: true });
    expect(onValueChange).toHaveBeenLastCalledWith(1, expect.anything());
  });

  test("the increment button steps and stops at max", () => {
    const onValueChange = vi.fn();
    const { container } = render(<NumberInput aria-label="Pool" defaultValue={9} max={10} onValueChange={onValueChange} />);
    const increment = container.querySelector('[data-slot="number-input-increment"]')!;
    press(increment);
    expect(onValueChange).toHaveBeenLastCalledWith(10, expect.anything());
    expect(increment.hasAttribute("data-disabled")).toBe(true);
  });

  test("wires to a TanStack Form field", () => {
    let values = (): unknown => undefined;
    function Example() {
      const form = useForm({ defaultValues: { pool: 10 as number | null } });
      values = () => form.state.values;
      return (
        <form.Field name="pool">
          {(field) => (
            <Field field={field}>
              <FieldLabel>Pool</FieldLabel>
              <NumberInput value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} />
            </Field>
          )}
        </form.Field>
      );
    }
    const { container } = render(<Example />);
    const input = container.querySelector('[data-slot="number-input-input"]')!;
    act(() => (input as HTMLElement).focus());
    key(input, "ArrowUp");
    expect(values()).toEqual({ pool: 11 });
  });

  test("forwards the ref to the root and inputRef to the input; disabled disables both", () => {
    const ref = createRef<HTMLDivElement>();
    const inputRef = createRef<HTMLInputElement>();
    render(<NumberInput ref={ref} inputRef={inputRef} aria-label="Pool" disabled />);
    expect(ref.current?.dataset.slot).toBe("number-input");
    expect(inputRef.current?.disabled).toBe(true);
    expect(ref.current?.hasAttribute("data-disabled")).toBe(true);
  });
});
