import { useForm } from "@tanstack/react-form";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Combobox, ComboboxItem } from "./combobox";

afterEach(cleanup);

const schemas = ["public", "analytics", "audit", "billing"];

const item = (schema: string) => (
  <ComboboxItem key={schema} value={schema}>
    {schema}
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

const input = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[data-slot="combobox-input"]')!;
const options = () => [...document.body.querySelectorAll('[role="option"]')].map((o) => o.textContent);

describe("Combobox", () => {
  test("a FieldLabel names the input; invalid reaches the frame", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Schema</FieldLabel>
        <Combobox items={schemas} placeholder="Search schemas">
          {item}
        </Combobox>
        <FieldError>Choose a schema.</FieldError>
      </Field>,
    );
    const control = input(container);
    expect(control.getAttribute("role")).toBe("combobox");
    expect(control.labels?.[0]?.textContent ?? document.getElementById(control.getAttribute("aria-labelledby")!)!.textContent).toBe("Schema");
    expect(control.placeholder).toBe("Search schemas");
    expect(container.querySelector('[data-slot="combobox"]')!.hasAttribute("data-invalid")).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("typing filters the list and highlights the first match; Enter takes it", async () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <Combobox aria-label="Schema" items={schemas} onValueChange={onValueChange}>
        {item}
      </Combobox>,
    );
    await type(input(container), "a");
    expect(options()).toEqual(["analytics", "audit"]);
    expect(document.body.querySelector('[role="option"][data-highlighted]')!.textContent).toBe("analytics");
    expect(await axeViolations(document.body.querySelector<HTMLElement>('[data-slot="combobox-popup"]')!)).toEqual([]);
    await key(input(container), "Enter");
    expect(onValueChange).toHaveBeenLastCalledWith("analytics", expect.anything());
    expect(input(container).value).toBe("analytics");
  });

  test("no match shows the empty message", async () => {
    const { container } = render(
      <Combobox aria-label="Schema" items={schemas} emptyMessage="No schema matches.">
        {item}
      </Combobox>,
    );
    await type(input(container), "zzz");
    expect(options()).toEqual([]);
    expect(document.body.querySelector('[data-slot="combobox-empty"]')!.textContent!.replace(/\u2060/g, "")).toBe("No schema matches.");
  });

  test("the status and empty lines are empty (so hidden) while they have nothing to say", async () => {
    render(
      <Combobox aria-label="Schema" items={schemas} defaultOpen>
        {item}
      </Combobox>,
    );
    await act(async () => {});
    expect(document.body.querySelector('[data-slot="combobox-empty"]')!.matches(":empty")).toBe(true);
    expect(document.body.querySelector('[data-slot="combobox-status"]')!.matches(":empty")).toBe(true);
  });

  test("the status line is a polite live region", async () => {
    render(
      <Combobox aria-label="Role" items={["dbee_reader"]} status="Loading roles…" defaultOpen>
        {item}
      </Combobox>,
    );
    await act(async () => {});
    const status = document.body.querySelector('[data-slot="combobox-status"]')!;
    // Base UI appends a word joiner (U+2060) so a repeated message is announced again.
    expect(status.textContent!.replace(/\u2060/g, "")).toBe("Loading roles…");
    expect(status.getAttribute("aria-live")).toBe("polite");
  });

  test("choosing with the pointer reports the value; the clear button shows and clears it", async () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <Combobox aria-label="Schema" items={schemas} onValueChange={onValueChange}>
        {item}
      </Combobox>,
    );
    const clear = container.querySelector('[data-slot="combobox-clear"]')!;
    expect(clear.hasAttribute("data-visible")).toBe(false);
    await type(input(container), "bil");
    await press(document.body.querySelector('[role="option"]')!);
    expect(onValueChange).toHaveBeenLastCalledWith("billing", expect.anything());
    expect(clear.hasAttribute("data-visible")).toBe(true);
    expect(clear.getAttribute("aria-label")).toBe("Clear");
    await press(clear);
    expect(onValueChange).toHaveBeenLastCalledWith(null, expect.anything());
    expect(input(container).value).toBe("");
  });

  test("the popup takes the theme and density of the region the frame is in", async () => {
    render(
      <div data-theme="dark" data-density="compact">
        <Combobox aria-label="Schema" items={schemas} defaultOpen>
          {item}
        </Combobox>
      </div>,
    );
    await act(async () => {});
    const positioner = document.body.querySelector<HTMLElement>('[data-slot="combobox-positioner"]')!;
    expect(positioner.dataset.theme).toBe("dark");
    expect(positioner.dataset.density).toBe("compact");
  });

  test("wires to TanStack Form", async () => {
    let values = () => ({}) as { schema: string | null };
    function Form() {
      const form = useForm({ defaultValues: { schema: "public" as string | null } });
      values = () => form.state.values;
      return (
        <form.Field name="schema">
          {(field) => (
            <Field field={field}>
              <FieldLabel>Schema</FieldLabel>
              <Combobox items={schemas} value={field.state.value} onValueChange={(value) => field.handleChange(value)} onOpenChange={(open) => !open && field.handleBlur()}>
                {item}
              </Combobox>
            </Field>
          )}
        </form.Field>
      );
    }
    const { container } = render(<Form />);
    expect(input(container).value).toBe("public");
    await type(input(container), "aud");
    await key(input(container), "Enter");
    expect(values().schema).toBe("audit");
  });

  test("forwards the ref to the input; disabled disables it", () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(
      <Combobox ref={ref} aria-label="Schema" items={schemas} disabled>
        {item}
      </Combobox>,
    );
    expect(ref.current).toBe(input(container));
    expect(ref.current!.disabled).toBe(true);
    expect(container.querySelector('[data-slot="combobox"]')!.hasAttribute("data-disabled")).toBe(true);
  });
});
