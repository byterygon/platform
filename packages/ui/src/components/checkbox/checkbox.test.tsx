import { useForm } from "@tanstack/react-form";
import { createRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldItem, FieldLabel, FieldLegend } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Checkbox, CheckboxGroup } from "./checkbox";

afterEach(cleanup);

const box = (container: HTMLElement, index = 0) => container.querySelectorAll<HTMLElement>('[role="checkbox"]')[index]!;

describe("Checkbox", () => {
  test("a wrapping FieldLabel names it, and clicking the text toggles it", async () => {
    const onCheckedChange = vi.fn();
    const { container } = render(
      <Field>
        <FieldLabel>
          <Checkbox onCheckedChange={onCheckedChange} />
          Include column headers
        </FieldLabel>
      </Field>,
    );
    const checkbox = box(container);
    expect(checkbox.dataset.slot).toBe("checkbox");
    expect(checkbox.dataset.size).toBe("md");
    expect(checkbox.getAttribute("aria-checked")).toBe("false");
    expect(await axeViolations(container)).toEqual([]);
    act(() => container.querySelector("label")!.click());
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
    expect(checkbox.hasAttribute("data-checked")).toBe(true);
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });

  test("Space toggles it from the keyboard", () => {
    const { container } = render(<Checkbox aria-label="Headers" />);
    const checkbox = box(container);
    act(() => checkbox.focus());
    act(() => {
      checkbox.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
      checkbox.dispatchEvent(new KeyboardEvent("keyup", { key: " ", bubbles: true }));
    });
    expect(checkbox.getAttribute("aria-checked")).toBe("true");
  });

  test("indeterminate is announced as mixed and shows a dash", () => {
    const { container } = render(<Checkbox aria-label="All" indeterminate />);
    const checkbox = box(container);
    expect(checkbox.getAttribute("aria-checked")).toBe("mixed");
    expect(checkbox.hasAttribute("data-indeterminate")).toBe(true);
    expect(checkbox.querySelector("svg path")?.getAttribute("d")).toBe("M4 8h8");
  });

  test("an invalid Field marks it invalid", () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>
          <Checkbox />
          Accept the licence
        </FieldLabel>
        <FieldError>Accept the licence to continue.</FieldError>
      </Field>,
    );
    const checkbox = box(container);
    expect(checkbox.hasAttribute("data-invalid")).toBe(true);
    expect(checkbox.getAttribute("aria-invalid")).toBe("true");
  });

  test("forwards the ref and submits through a hidden input", () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(
      <form>
        <Checkbox ref={ref} name="headers" aria-label="Headers" defaultChecked />
      </form>,
    );
    expect(ref.current?.dataset.slot).toBe("checkbox");
    const data = new FormData(container.querySelector("form")!);
    expect(data.get("headers")).toBe("on");
  });

  test("wires to a TanStack Form field", () => {
    let values = (): unknown => undefined;
    function Example() {
      const form = useForm({ defaultValues: { headers: false } });
      values = () => form.state.values;
      return (
        <form.Field name="headers">
          {(field) => (
            <Field field={field}>
              <FieldLabel>
                <Checkbox checked={field.state.value} onCheckedChange={field.handleChange} onBlur={field.handleBlur} />
                Headers
              </FieldLabel>
            </Field>
          )}
        </form.Field>
      );
    }
    const { container } = render(<Example />);
    act(() => box(container).click());
    expect(values()).toEqual({ headers: true });
    expect(box(container).getAttribute("aria-checked")).toBe("true");
  });
});

describe("CheckboxGroup", () => {
  function Tables({ onValueChange }: { onValueChange?: (value: string[]) => void }) {
    const [value, setValue] = useState<string[]>([]);
    return (
      <Field name="tables">
        <CheckboxGroup
          value={value}
          onValueChange={(next) => {
            setValue(next);
            onValueChange?.(next);
          }}
          allValues={["customers", "orders"]}
        >
          <FieldLegend>Tables</FieldLegend>
          <FieldItem>
            <FieldLabel>
              <Checkbox parent />
              All
            </FieldLabel>
          </FieldItem>
          <FieldItem>
            <FieldLabel>
              <Checkbox value="customers" />
              customers
            </FieldLabel>
          </FieldItem>
          <FieldItem>
            <FieldLabel>
              <Checkbox value="orders" />
              orders
            </FieldLabel>
          </FieldItem>
        </CheckboxGroup>
      </Field>
    );
  }

  test("is a group named by its legend", async () => {
    const { container } = render(<Tables />);
    const group = container.querySelector<HTMLElement>('[data-slot="checkbox-group"]')!;
    const legend = container.querySelector('[data-slot="field-legend"]')!;
    expect(group.getAttribute("aria-labelledby")).toBe(legend.id);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("shares one value, and the parent is mixed, then ticks all", () => {
    const onValueChange = vi.fn();
    const { container } = render(<Tables onValueChange={onValueChange} />);
    act(() => box(container, 1).click());
    expect(onValueChange).toHaveBeenLastCalledWith(["customers"]);
    expect(box(container, 0).getAttribute("aria-checked")).toBe("mixed");
    act(() => box(container, 0).click());
    expect(onValueChange).toHaveBeenLastCalledWith(["customers", "orders"]);
    expect(box(container, 2).getAttribute("aria-checked")).toBe("true");
  });

  test("disabled disables every checkbox", () => {
    const { container } = render(
      <CheckboxGroup disabled aria-label="Tables">
        <Checkbox value="a" aria-label="a" />
        <Checkbox value="b" aria-label="b" />
      </CheckboxGroup>,
    );
    for (const checkbox of container.querySelectorAll('[role="checkbox"]')) expect(checkbox.hasAttribute("data-disabled")).toBe(true);
  });
});
