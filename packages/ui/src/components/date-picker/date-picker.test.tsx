import { useForm } from "@tanstack/react-form";
import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { DatePicker } from "./date-picker";

afterEach(cleanup);

const nov = (day: number) => new Date(2026, 10, day);

const text = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[data-slot="input-group-input"]')!;
const trigger = (container: HTMLElement) => container.querySelector<HTMLButtonElement>('[data-slot="date-picker-trigger"]')!;
const popup = () => document.body.querySelector<HTMLElement>('[data-slot="date-picker-popup"]');
const day = (iso: string) => popup()!.querySelector<HTMLButtonElement>(`td[data-day="${iso}"]:not([data-outside]) [data-slot="calendar-day-button"]`)!;

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

/** Types `value` into the text field and leaves it, as a user tabbing away would. */
const enter = async (element: HTMLInputElement, value: string) => {
  await act(async () => {
    element.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => element.blur());
};

describe("DatePicker", () => {
  test("a FieldLabel names the text field; the button opens a calendar dialog", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Restore to</FieldLabel>
        <DatePicker />
        <FieldError>Choose a day.</FieldError>
      </Field>,
    );
    const input = text(container);
    expect(container.querySelector("label")!.htmlFor).toBe(input.id);
    expect(input.placeholder).toBe("yyyy-MM-dd");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(trigger(container).getAttribute("aria-label")).toBe("Choose date");
    expect(trigger(container).getAttribute("aria-haspopup")).toBe("dialog");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("typed text is read on blur in the format and written back in full", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<DatePicker aria-label="Restore to" onValueChange={onValueChange} />);
    await enter(text(container), "2026-11-5");
    expect(onValueChange).toHaveBeenLastCalledWith(nov(5));
    expect(text(container).value).toBe("2026-11-05");
    expect(text(container).hasAttribute("aria-invalid")).toBe(false);
    await enter(text(container), "");
    expect(onValueChange).toHaveBeenLastCalledWith(null);
  });

  test("text that is not a date keeps the text, clears the value and marks the field invalid", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<DatePicker aria-label="Restore to" defaultValue={nov(14)} onValueChange={onValueChange} />);
    expect(text(container).value).toBe("2026-11-14");
    await enter(text(container), "14 Nov");
    expect(onValueChange).toHaveBeenLastCalledWith(null);
    expect(text(container).value).toBe("14 Nov");
    expect(text(container).getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[data-slot="date-picker"]')!.className).toContain("has-[[data-slot=input-group-input][aria-invalid=true]]:border-danger-border");
    await enter(text(container), "2026-11-15");
    expect(text(container).hasAttribute("aria-invalid")).toBe(false);
  });

  test("another format and locale", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<DatePicker aria-label="Changed since" format="dd/MM/yyyy" onValueChange={onValueChange} />);
    expect(text(container).placeholder).toBe("dd/MM/yyyy");
    await enter(text(container), "05/11/2026");
    expect(onValueChange).toHaveBeenLastCalledWith(nov(5));
  });

  test("picking a day in the calendar sets it, closes the popup and returns focus to the text field", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<DatePicker aria-label="Restore to" defaultValue={nov(14)} onValueChange={onValueChange} />);
    await click(trigger(container));
    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
    expect(popup()!.getAttribute("role")).toBe("dialog");
    expect(document.activeElement).toBe(day("2026-11-14"));
    expect(day("2026-11-14").hasAttribute("data-selected")).toBe(true);
    expect(await axeViolations(popup()!)).toEqual([]);
    await click(day("2026-11-20"));
    expect(onValueChange).toHaveBeenLastCalledWith(nov(20));
    expect(text(container).value).toBe("2026-11-20");
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(text(container));
  });

  test("Alt+ArrowDown in the text field opens the calendar", async () => {
    const { container } = render(<DatePicker aria-label="Restore to" defaultValue={nov(14)} />);
    await act(async () => {
      text(container).focus();
      text(container).dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true, cancelable: true }));
    });
    expect(popup()).not.toBeNull();
  });

  test("a range is typed as two dates, or picked with two clicks", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<DatePicker mode="range" aria-label="Query history" onValueChange={onValueChange} />);
    expect(text(container).placeholder).toBe("yyyy-MM-dd – yyyy-MM-dd");
    await enter(text(container), "2026-11-01 to 2026-11-07");
    expect(onValueChange).toHaveBeenLastCalledWith({ from: nov(1), to: nov(7) });
    expect(text(container).value).toBe("2026-11-01 – 2026-11-07");
    await enter(text(container), "2026-11-07 – 2026-11-01");
    expect(text(container).getAttribute("aria-invalid")).toBe("true");

    await click(trigger(container));
    expect(popup()!.querySelectorAll('[role="grid"]')).toHaveLength(2);
    await click(day("2026-11-10"));
    expect(trigger(container).getAttribute("aria-expanded")).toBe("true");
    await click(day("2026-11-12"));
    expect(onValueChange).toHaveBeenLastCalledWith({ from: nov(10), to: nov(12) });
    expect(text(container).value).toBe("2026-11-10 – 2026-11-12");
    expect(trigger(container).getAttribute("aria-expanded")).toBe("false");
  });

  test("min and max bound what can be typed and picked", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<DatePicker aria-label="Since" defaultValue={nov(10)} min={nov(3)} max={nov(14)} onValueChange={onValueChange} />);
    await enter(text(container), "2026-11-20");
    expect(text(container).getAttribute("aria-invalid")).toBe("true");
    expect(onValueChange).toHaveBeenLastCalledWith(null);
    await click(trigger(container));
    expect(day("2026-11-20").hasAttribute("data-disabled")).toBe(true);
    expect(day("2026-11-02").hasAttribute("data-disabled")).toBe(true);
    expect(day("2026-11-14").hasAttribute("data-disabled")).toBe(false);
  });

  test("the popup takes the theme and density of the region the field is in", async () => {
    render(
      <div data-theme="dark" data-density="compact">
        <DatePicker aria-label="Restore to" defaultOpen />
      </div>,
    );
    await act(async () => {});
    const positioner = document.body.querySelector<HTMLElement>('[data-slot="date-picker-positioner"]')!;
    expect(positioner.closest("main")).toBeNull();
    expect(positioner.dataset.theme).toBe("dark");
    expect(positioner.dataset.density).toBe("compact");
  });

  test("a disabled Field disables the text field and the button", async () => {
    const { container } = render(
      <Field disabled>
        <FieldLabel>Keep until</FieldLabel>
        <DatePicker defaultValue={nov(14)} />
      </Field>,
    );
    await act(async () => {});
    expect(text(container).disabled).toBe(true);
    expect(trigger(container).disabled).toBe(true);
    await click(trigger(container));
    expect(popup()).toBeNull();
  });

  test("wires to TanStack Form; the ref reaches the text field", async () => {
    const ref = createRef<HTMLInputElement>();
    let values = () => ({}) as { day: Date | null };
    function Form() {
      const form = useForm({ defaultValues: { day: nov(14) as Date | null } });
      values = () => form.state.values;
      return (
        <form.Field name="day">
          {(field) => (
            <Field field={field}>
              <FieldLabel>Restore to</FieldLabel>
              <DatePicker ref={ref} value={field.state.value} onValueChange={(value) => field.handleChange(value)} onBlur={field.handleBlur} />
            </Field>
          )}
        </form.Field>
      );
    }
    const { container } = render(<Form />);
    expect(ref.current).toBe(text(container));
    await enter(text(container), "2026-11-02");
    expect(values().day).toEqual(nov(2));
    await click(trigger(container));
    await click(day("2026-11-09"));
    expect(values().day).toEqual(nov(9));
    expect(text(container).value).toBe("2026-11-09");
  });
});
