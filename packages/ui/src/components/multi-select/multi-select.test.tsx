import { useForm } from "@tanstack/react-form";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ComboboxItem } from "@/components/combobox/combobox";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { MultiSelect } from "./multi-select";

afterEach(cleanup);

const columns = ["id", "customer_id", "status", "total"];

const item = (column: string) => (
  <ComboboxItem key={column} value={column}>
    {column}
  </ComboboxItem>
);

/** Typing: Base UI opens the list only for an InputEvent with an inputType (autofill has none). */
const type = async (input: HTMLInputElement, text: string) => {
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  });
};

const key = async (element: Element, key: string) => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

const press = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
};

const input = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[data-slot="multi-select-input"]')!;
const chips = (container: HTMLElement) => [...container.querySelectorAll('[data-slot="multi-select-chip"]')].map((chip) => chip.textContent);

describe("MultiSelect", () => {
  test("a FieldLabel names the input; chips and their remove buttons are named", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Columns</FieldLabel>
        <MultiSelect items={columns} defaultValue={["id", "status"]}>
          {item}
        </MultiSelect>
        <FieldError>Choose at least one column.</FieldError>
      </Field>,
    );
    const control = input(container);
    expect(control.labels?.[0]?.textContent ?? document.getElementById(control.getAttribute("aria-labelledby")!)!.textContent).toBe("Columns");
    expect(chips(container)).toEqual(["id", "status"]);
    const removes = [...container.querySelectorAll('[data-slot="multi-select-chip-remove"]')].map((b) => b.getAttribute("aria-label"));
    expect(removes).toEqual(["Remove id", "Remove status"]);
    expect(container.querySelector('[data-slot="multi-select"]')!.hasAttribute("data-invalid")).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("the placeholder shows only while nothing is chosen", () => {
    const { container } = render(
      <MultiSelect aria-label="Columns" items={columns} placeholder="Search columns">
        {item}
      </MultiSelect>,
    );
    expect(input(container).placeholder).toBe("Search columns");
    cleanup();
    const second = render(
      <MultiSelect aria-label="Columns" items={columns} placeholder="Search columns" defaultValue={["id"]}>
        {item}
      </MultiSelect>,
    );
    expect(input(second.container).placeholder).toBe("");
  });

  test("Enter adds the highlighted match and the list stays open; Enter again removes it", async () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <MultiSelect aria-label="Columns" items={columns} defaultValue={["id"]} onValueChange={onValueChange}>
        {item}
      </MultiSelect>,
    );
    await type(input(container), "tot");
    expect(document.body.querySelector('[role="listbox"]')!.getAttribute("aria-multiselectable")).toBe("true");
    await key(input(container), "Enter");
    expect(onValueChange).toHaveBeenLastCalledWith(["id", "total"], expect.anything());
    expect(chips(container)).toEqual(["id", "total"]);
    expect(input(container).getAttribute("aria-expanded")).toBe("true");
    expect(await axeViolations(document.body.querySelector<HTMLElement>('[data-slot="combobox-popup"]')!)).toEqual([]);
    await type(input(container), "tot");
    await key(input(container), "Enter");
    expect(onValueChange).toHaveBeenLastCalledWith(["id"], expect.anything());
  });

  test("a pointer press on an item adds it and keeps the list open", async () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <MultiSelect aria-label="Columns" items={columns} onValueChange={onValueChange}>
        {item}
      </MultiSelect>,
    );
    await type(input(container), "cust");
    await press(document.body.querySelector('[role="option"]')!);
    expect(onValueChange).toHaveBeenLastCalledWith(["customer_id"], expect.anything());
    expect(input(container).getAttribute("aria-expanded")).toBe("true");
  });

  test("Backspace in the empty input removes the last chip; a chip's button removes it", async () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <MultiSelect aria-label="Columns" items={columns} defaultValue={["id", "status", "total"]} onValueChange={onValueChange}>
        {item}
      </MultiSelect>,
    );
    await act(async () => input(container).focus());
    await key(input(container), "Backspace");
    expect(onValueChange).toHaveBeenLastCalledWith(["id", "status"], expect.anything());
    await press(container.querySelector('[aria-label="Remove id"]')!);
    expect(onValueChange).toHaveBeenLastCalledWith(["status"], expect.anything());
    expect(chips(container)).toEqual(["status"]);
  });

  test("{ value, label } items show their label on the chip; itemToStringLabel names ids", () => {
    const { container } = render(
      <MultiSelect aria-label="Privileges" items={[{ value: "select", label: "SELECT" }]} defaultValue={[{ value: "select", label: "SELECT" }]}>
        {(p: { value: string; label: string }) => (
          <ComboboxItem key={p.value} value={p}>
            {p.label}
          </ComboboxItem>
        )}
      </MultiSelect>,
    );
    expect(chips(container)).toEqual(["SELECT"]);
    cleanup();
    const names: Record<string, string> = { u1: "Ada", u2: "Grace" };
    const second = render(
      <MultiSelect aria-label="Owners" items={["u1", "u2"]} defaultValue={["u2"]} itemToStringLabel={(id: string) => names[id]!}>
        {(id: string) => (
          <ComboboxItem key={id} value={id}>
            {names[id]}
          </ComboboxItem>
        )}
      </MultiSelect>,
    );
    expect(chips(second.container)).toEqual(["Grace"]);
  });

  test("the clear button removes every value", async () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <MultiSelect aria-label="Columns" items={columns} defaultValue={["id", "total"]} onValueChange={onValueChange}>
        {item}
      </MultiSelect>,
    );
    const clear = container.querySelector('[data-slot="multi-select-clear"]')!;
    expect(clear.getAttribute("aria-label")).toBe("Clear all");
    await press(clear);
    expect(onValueChange).toHaveBeenLastCalledWith([], expect.anything());
    expect(chips(container)).toEqual([]);
  });

  test("wires to TanStack Form", async () => {
    let values = () => ({}) as { columns: string[] };
    function Form() {
      const form = useForm({ defaultValues: { columns: ["id"] } });
      values = () => form.state.values;
      return (
        <form.Field name="columns">
          {(field) => (
            <Field field={field}>
              <FieldLabel>Columns</FieldLabel>
              <MultiSelect items={columns} value={field.state.value} onValueChange={(value) => field.handleChange(value)} onOpenChange={(open) => !open && field.handleBlur()}>
                {item}
              </MultiSelect>
            </Field>
          )}
        </form.Field>
      );
    }
    const { container } = render(<Form />);
    await type(input(container), "stat");
    await key(input(container), "Enter");
    expect(values().columns).toEqual(["id", "status"]);
  });

  test("forwards the ref to the input; disabled disables it", () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(
      <MultiSelect ref={ref} aria-label="Columns" items={columns} disabled>
        {item}
      </MultiSelect>,
    );
    expect(ref.current).toBe(input(container));
    expect(ref.current!.disabled).toBe(true);
  });
});
