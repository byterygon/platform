import { useForm } from "@tanstack/react-form";
import { createRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { parseTime, TimePicker } from "./time-picker";

afterEach(cleanup);

const input = (container: HTMLElement) => container.querySelector<HTMLInputElement>('[data-slot="time-picker"]')!;

const focus = async (element: HTMLInputElement) => {
  await act(async () => element.focus());
};

const press = async (element: HTMLInputElement, ...keys: string[]) => {
  for (const key of keys) {
    await act(async () => {
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }
};

const selection = (element: HTMLInputElement) => element.value.slice(element.selectionStart!, element.selectionEnd!);

describe("TimePicker", () => {
  test("a FieldLabel names it; empty, it shows the segments' shape as the placeholder", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Backup at</FieldLabel>
        <TimePicker />
        <FieldError>Set a time.</FieldError>
      </Field>,
    );
    const element = input(container);
    expect(container.querySelector("label")!.htmlFor).toBe(element.id);
    expect(element.getAttribute("aria-invalid")).toBe("true");
    expect(element.value).toBe("");
    expect(element.placeholder).toBe("--:--");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("focus selects the hour; the arrows move between segments and step them", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<TimePicker aria-label="Backup at" defaultValue="23:59" onValueChange={onValueChange} />);
    const element = input(container);
    await focus(element);
    expect(selection(element)).toBe("23");
    await press(element, "ArrowUp");
    expect(element.value).toBe("00:59");
    expect(onValueChange).toHaveBeenLastCalledWith("00:59");
    await press(element, "ArrowRight");
    expect(selection(element)).toBe("59");
    await press(element, "ArrowUp");
    expect(element.value).toBe("00:00");
    await press(element, "ArrowLeft", "ArrowDown");
    expect(element.value).toBe("23:00");
    await press(element, "End");
    expect(element.value).toBe("23:00");
    await press(element, "Home");
    expect(onValueChange).toHaveBeenLastCalledWith("00:00");
  });

  test("digits fill a segment and move on; the value is null until every segment is set", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<TimePicker aria-label="Backup at" seconds onValueChange={onValueChange} />);
    const element = input(container);
    await focus(element);
    await press(element, "1");
    expect(element.value).toBe("01:--:--");
    expect(selection(element)).toBe("01");
    await press(element, "4");
    expect(selection(element)).toBe("--");
    // 7 cannot start a minute, so it fills the minutes alone.
    await press(element, "7");
    expect(element.value).toBe("14:07:--");
    expect(onValueChange).not.toHaveBeenCalled();
    await press(element, "3", "0");
    expect(element.value).toBe("14:07:30");
    expect(onValueChange).toHaveBeenLastCalledWith("14:07:30");
    await press(element, "Backspace");
    expect(element.value).toBe("14:07:--");
    expect(onValueChange).toHaveBeenLastCalledWith(null);
    await press(element, "Backspace");
    expect(selection(element)).toBe("07");
  });

  test("letters other than A and P do nothing", async () => {
    const { container } = render(<TimePicker aria-label="Backup at" defaultValue="09:30" />);
    const element = input(container);
    await focus(element);
    await press(element, "x", "-");
    expect(element.value).toBe("09:30");
  });

  test("the 12-hour cycle shows AM/PM and keeps the value on the 24-hour clock", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<TimePicker aria-label="Window ends" hourCycle={12} defaultValue="14:05" onValueChange={onValueChange} />);
    const element = input(container);
    expect(element.value).toBe("02:05 PM");
    await focus(element);
    await press(element, "a");
    expect(element.value).toBe("02:05 AM");
    expect(onValueChange).toHaveBeenLastCalledWith("02:05");
    await press(element, "1", "2");
    expect(onValueChange).toHaveBeenLastCalledWith("00:05");
    await press(element, "ArrowRight", "ArrowDown");
    expect(element.value).toBe("12:05 PM");
    expect(onValueChange).toHaveBeenLastCalledWith("12:05");
  });

  test("pasting a time sets every segment", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<TimePicker aria-label="Backup at" onValueChange={onValueChange} />);
    const element = input(container);
    await focus(element);
    await act(async () => {
      const event = new Event("paste", { bubbles: true, cancelable: true }) as Event & { clipboardData: unknown };
      event.clipboardData = { getData: () => "9:30 pm" };
      element.dispatchEvent(event);
    });
    expect(element.value).toBe("21:30");
    expect(onValueChange).toHaveBeenLastCalledWith("21:30");
  });

  test("minuteStep sets how far the arrows move the minutes", async () => {
    const { container } = render(<TimePicker aria-label="Report" defaultValue="08:15" minuteStep={15} />);
    const element = input(container);
    await focus(element);
    await press(element, "ArrowRight", "ArrowUp");
    expect(element.value).toBe("08:30");
  });

  test("a controlled value set elsewhere replaces the segments", async () => {
    let set: (value: string | null) => void = () => {};
    function Controlled() {
      const [value, setValue] = useState<string | null>("10:00");
      set = setValue;
      return <TimePicker aria-label="Backup at" value={value} onValueChange={setValue} />;
    }
    const { container } = render(<Controlled />);
    expect(input(container).value).toBe("10:00");
    await act(async () => set("18:45"));
    expect(input(container).value).toBe("18:45");
    await act(async () => set(null));
    expect(input(container).value).toBe("");
  });

  test("wires to TanStack Form", async () => {
    let values = () => ({}) as { at: string | null };
    function Form() {
      const form = useForm({ defaultValues: { at: "02:30" as string | null } });
      values = () => form.state.values;
      return (
        <form.Field name="at">
          {(field) => (
            <Field field={field}>
              <FieldLabel>Backup at</FieldLabel>
              <TimePicker value={field.state.value} onValueChange={(value) => field.handleChange(value)} onBlur={field.handleBlur} />
            </Field>
          )}
        </form.Field>
      );
    }
    const { container } = render(<Form />);
    const element = input(container);
    await focus(element);
    await press(element, "0", "4");
    expect(values().at).toBe("04:30");
    expect(element.value).toBe("04:30");
  });

  test("disabled and read-only fields do not change; the ref reaches the input", async () => {
    const ref = createRef<HTMLInputElement>();
    const { container } = render(
      <>
        <TimePicker ref={ref} aria-label="Vacuum at" defaultValue="04:00" disabled />
        <TimePicker aria-label="Report" defaultValue="08:00" readOnly />
      </>,
    );
    expect(ref.current).toBe(input(container));
    expect(ref.current!.hasAttribute("data-disabled")).toBe(true);
    await press(ref.current!, "ArrowUp", "5");
    expect(ref.current!.value).toBe("04:00");
    const readOnly = container.querySelectorAll<HTMLInputElement>('[data-slot="time-picker"]')[1]!;
    await focus(readOnly);
    await press(readOnly, "ArrowUp", "Backspace");
    expect(readOnly.value).toBe("08:00");
  });
});

describe("parseTime", () => {
  test("reads 24- and 12-hour text", () => {
    expect(parseTime("14:05")).toEqual({ hour: 14, minute: 5, second: 0, period: null });
    expect(parseTime("2:05 pm", 24)).toEqual({ hour: 14, minute: 5, second: 0, period: null });
    expect(parseTime("00:30", 12)).toEqual({ hour: 12, minute: 30, second: 0, period: "AM" });
    expect(parseTime("12:00 AM")).toEqual({ hour: 0, minute: 0, second: 0, period: null });
    expect(parseTime("24:00")).toBeNull();
    expect(parseTime("13:00 pm")).toBeNull();
    expect(parseTime("noon")).toBeNull();
  });
});
