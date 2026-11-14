import { Field } from "@base-ui/react/field";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Input } from "./input";

afterEach(cleanup);

const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Input", () => {
  test("renders a native input with its slot and size", () => {
    const { container } = render(<Input aria-label="Name" />);
    const input = container.querySelector("input")!;
    expect(input.dataset.slot).toBe("input");
    expect(input.dataset.size).toBe("md");
  });

  test("forwards the ref to the input element", () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="Name" />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
  });

  test("reports changes through onValueChange", () => {
    const onValueChange = vi.fn();
    const { container } = render(<Input aria-label="Name" onValueChange={onValueChange} />);
    type(container.querySelector("input")!, "orders");
    expect(onValueChange).toHaveBeenCalledWith("orders", expect.anything());
  });

  test("disabled sets the native attribute and data-disabled", () => {
    const { container } = render(<Input aria-label="Name" disabled />);
    const input = container.querySelector("input")!;
    expect(input.disabled).toBe(true);
    expect(input.hasAttribute("data-disabled")).toBe(true);
  });

  test("inside a Base UI Field it takes the label and the field's validity", async () => {
    const { container } = render(
      <Field.Root invalid>
        <Field.Label>Port</Field.Label>
        <Input />
        <Field.Error match>The port must be between 1 and 65535.</Field.Error>
      </Field.Root>,
    );
    const input = container.querySelector("input")!;
    expect(input.hasAttribute("data-invalid")).toBe(true);
    expect(input.labels?.[0]?.textContent).toBe("Port");
    expect(await axeViolations(container)).toEqual([]);
  });
});
