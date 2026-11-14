import { useForm } from "@tanstack/react-form";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectSeparator } from "./select";

afterEach(cleanup);

const modes = { disable: "Disable", prefer: "Prefer", require: "Require" };

const options = () =>
  Object.entries(modes).map(([value, label]) => (
    <SelectItem key={value} value={value}>
      {label}
    </SelectItem>
  ));

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

/** A mouse press on an option: Base UI commits a click only when the press started on it. */
const choose = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
  });
};

const key = async (element: Element, key: string) => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

const trigger = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-slot="select"]')!;
const popup = () => document.body.querySelector<HTMLElement>('[data-slot="select-popup"]');

describe("Select", () => {
  test("a FieldLabel names the trigger; the placeholder shows while nothing is chosen", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>SSL mode</FieldLabel>
        <Select items={modes} placeholder="Choose a mode">
          {options()}
        </Select>
        <FieldError>Choose a mode.</FieldError>
      </Field>,
    );
    const button = trigger(container);
    expect(button.getAttribute("role")).toBe("combobox");
    expect(document.getElementById(button.getAttribute("aria-labelledby")!)!.textContent).toBe("SSL mode");
    expect(button.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[data-slot="select-value"]')!.hasAttribute("data-placeholder")).toBe(true);
    expect(button.textContent).toContain("Choose a mode");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("shows the chosen label from items before the popup has opened", () => {
    const { container } = render(
      <Select aria-label="SSL mode" items={modes} defaultValue="require">
        {options()}
      </Select>,
    );
    expect(trigger(container).textContent).toContain("Require");
    expect(popup()).toBeNull();
  });

  test("clicking opens a listbox; choosing an option reports it, shows it and closes", async () => {
    const onValueChange = vi.fn();
    const { container } = render(
      <Select aria-label="SSL mode" items={modes} defaultValue="prefer" onValueChange={onValueChange}>
        {options()}
      </Select>,
    );
    await click(trigger(container));
    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
    const listbox = document.body.querySelector('[role="listbox"]')!;
    const items = [...listbox.querySelectorAll('[role="option"]')];
    expect(items.map((item) => item.textContent)).toEqual(["Disable", "Prefer", "Require"]);
    expect(items[1]!.getAttribute("aria-selected")).toBe("true");
    expect(await axeViolations(popup()!)).toEqual([]);
    await choose(items[2]!);
    expect(onValueChange).toHaveBeenLastCalledWith("require", expect.anything());
    expect(trigger(container).textContent).toContain("Require");
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
  });

  test("Escape closes the popup", async () => {
    const { container } = render(
      <Select aria-label="SSL mode" items={modes} defaultOpen>
        {options()}
      </Select>,
    );
    await act(async () => {});
    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
    await key(document.activeElement ?? popup()!, "Escape");
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
  });

  test("the popup takes the theme and density of the region the trigger is in", async () => {
    render(
      <div data-theme="dark" data-density="compact">
        <Select aria-label="SSL mode" items={modes} defaultOpen>
          {options()}
        </Select>
      </div>,
    );
    await act(async () => {});
    const positioner = document.body.querySelector<HTMLElement>('[data-slot="select-positioner"]')!;
    expect(positioner.closest("main")).toBeNull();
    expect(positioner.dataset.theme).toBe("dark");
    expect(positioner.dataset.density).toBe("compact");
  });

  test("groups are named by their labels; separators and disabled options render", async () => {
    render(
      <Select aria-label="Engine" items={{ pg: "PostgreSQL", ch: "ClickHouse", ora: "Oracle" }} defaultOpen>
        <SelectGroup>
          <SelectGroupLabel>Transactional</SelectGroupLabel>
          <SelectItem value="pg">PostgreSQL</SelectItem>
        </SelectGroup>
        <SelectSeparator />
        <SelectItem value="ora" disabled>
          Oracle
        </SelectItem>
      </Select>,
    );
    await act(async () => {});
    const group = document.body.querySelector('[role="group"]')!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)!.textContent).toBe("Transactional");
    // In a listbox Base UI gives the separator role="presentation": only options and groups belong there.
    expect(document.body.querySelector('[data-slot="select-separator"]')).not.toBeNull();
    const oracle = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Oracle")!;
    expect(oracle.getAttribute("aria-disabled")).toBe("true");
    expect(await axeViolations(popup()!)).toEqual([]);
  });

  test("wires to TanStack Form", async () => {
    let values = () => ({}) as { sslmode: string | null };
    function Form() {
      const form = useForm({ defaultValues: { sslmode: "prefer" as string | null } });
      values = () => form.state.values;
      return (
        <form.Field name="sslmode">
          {(field) => (
            <Field field={field}>
              <FieldLabel>SSL mode</FieldLabel>
              <Select items={modes} value={field.state.value} onValueChange={(value) => field.handleChange(value)} onOpenChange={(open) => !open && field.handleBlur()}>
                {options()}
              </Select>
            </Field>
          )}
        </form.Field>
      );
    }
    const { container } = render(<Form />);
    await click(trigger(container));
    const disable = [...document.body.querySelectorAll('[role="option"]')].find((o) => o.textContent === "Disable")!;
    await choose(disable);
    expect(values().sslmode).toBe("disable");
    expect(trigger(container).textContent).toContain("Disable");
  });

  test("forwards the ref to the trigger; disabled does not open", async () => {
    const ref = createRef<HTMLButtonElement>();
    const { container } = render(
      <Select ref={ref} aria-label="SSL mode" items={modes} disabled>
        {options()}
      </Select>,
    );
    expect(ref.current).toBe(trigger(container));
    expect(ref.current!.hasAttribute("data-disabled")).toBe(true);
    await click(ref.current!);
    expect(popup()).toBeNull();
  });
});
