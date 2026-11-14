import { vi as viLocale } from "date-fns/locale";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Calendar, type DateRange } from "./calendar";

afterEach(cleanup);

const november = new Date(2026, 10, 1);

const click = async (element: Element) => {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const key = async (element: Element, key: string) => {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

/** The day button of `iso` (yyyy-MM-dd) in the month shown, not an outside day of a neighbour. */
const day = (container: HTMLElement, iso: string) => container.querySelector<HTMLButtonElement>(`td[data-day="${iso}"]:not([data-outside]) [data-slot="calendar-day-button"]`)!;

describe("Calendar", () => {
  test("a month grid named by its month, with one day in the tab order", async () => {
    const { container } = render(<Calendar mode="single" defaultMonth={november} today={new Date(2026, 10, 14)} aria-label="Snapshot date" />);
    const grid = container.querySelector('[role="grid"]')!;
    expect(grid.getAttribute("aria-label")).toBe("November 2026");
    expect(container.querySelector('[data-slot="calendar"]')!.getAttribute("aria-label")).toBe("Snapshot date");
    const today = day(container, "2026-11-14");
    expect(today.hasAttribute("data-today")).toBe(true);
    expect(today.getAttribute("aria-label")).toContain("Today");
    expect([...container.querySelectorAll('[data-slot="calendar-day-button"][tabindex="0"]')]).toEqual([today]);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("replaces every react-day-picker class with token classes", () => {
    const { container } = render(<Calendar mode="range" defaultMonth={november} numberOfMonths={2} showWeekNumber selected={{ from: new Date(2026, 10, 3), to: new Date(2026, 10, 9) }} footer="Footer" />);
    const classes = [...container.querySelectorAll("[class]")].flatMap((element) => [...element.classList]);
    expect(classes.filter((name) => name.startsWith("rdp-"))).toEqual([]);
  });

  test("clicking a day selects it", async () => {
    const onSelect = vi.fn();
    function Controlled() {
      const [selected, setSelected] = useState<Date | undefined>();
      return (
        <Calendar
          mode="single"
          defaultMonth={november}
          selected={selected}
          onSelect={(date) => {
            setSelected(date);
            onSelect(date);
          }}
        />
      );
    }
    const { container } = render(<Controlled />);
    await click(day(container, "2026-11-20"));
    expect(onSelect).toHaveBeenLastCalledWith(new Date(2026, 10, 20));
    expect(day(container, "2026-11-20").hasAttribute("data-selected")).toBe(true);
    expect(day(container, "2026-11-20").closest("td")!.getAttribute("aria-selected")).toBe("true");
  });

  test("the arrow keys move between days and PageDown to the next month", async () => {
    const { container } = render(<Calendar mode="single" defaultMonth={november} selected={new Date(2026, 10, 10)} />);
    const start = day(container, "2026-11-10");
    await act(async () => start.focus());
    await key(start, "ArrowRight");
    expect(document.activeElement).toBe(day(container, "2026-11-11"));
    await key(document.activeElement!, "ArrowDown");
    expect(document.activeElement).toBe(day(container, "2026-11-18"));
    await key(document.activeElement!, "PageDown");
    expect(container.querySelector('[role="grid"]')!.getAttribute("aria-label")).toBe("December 2026");
    expect(document.activeElement).toBe(day(container, "2026-12-18"));
  });

  test("a range marks its ends as selected and the days between as the band", () => {
    const range: DateRange = { from: new Date(2026, 10, 3), to: new Date(2026, 10, 6) };
    const { container } = render(<Calendar mode="range" defaultMonth={november} selected={range} />);
    const from = day(container, "2026-11-03");
    const middle = day(container, "2026-11-04");
    const to = day(container, "2026-11-06");
    expect(from.hasAttribute("data-selected") && from.hasAttribute("data-range-start")).toBe(true);
    expect(to.hasAttribute("data-selected") && to.hasAttribute("data-range-end")).toBe(true);
    expect(middle.hasAttribute("data-range-middle")).toBe(true);
    expect(middle.hasAttribute("data-selected")).toBe(false);
    expect(middle.closest("td")!.className).toContain("bg-accent-subtle");
    expect(container.querySelector('[role="grid"]')!.getAttribute("aria-multiselectable")).toBe("true");
  });

  test("a one-day range is a selected day with no band ends", () => {
    const { container } = render(<Calendar mode="range" defaultMonth={november} selected={{ from: new Date(2026, 10, 3), to: new Date(2026, 10, 3) }} />);
    const only = day(container, "2026-11-03");
    expect(only.hasAttribute("data-selected")).toBe(true);
    expect(only.hasAttribute("data-range-start") || only.hasAttribute("data-range-end")).toBe(false);
  });

  test("disabled days cannot be chosen", async () => {
    const onSelect = vi.fn();
    const { container } = render(<Calendar mode="single" defaultMonth={november} disabled={{ after: new Date(2026, 10, 14) }} onSelect={onSelect} />);
    const late = day(container, "2026-11-20");
    expect(late.hasAttribute("data-disabled")).toBe(true);
    expect(late.disabled).toBe(true);
    await click(late);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("the navigation buttons change the month, and stop at startMonth", async () => {
    const { container } = render(<Calendar mode="single" defaultMonth={november} startMonth={november} />);
    const previous = container.querySelector<HTMLButtonElement>('button[aria-label="Go to the Previous Month"]')!;
    const next = container.querySelector<HTMLButtonElement>('button[aria-label="Go to the Next Month"]')!;
    expect(previous.getAttribute("aria-disabled")).toBe("true");
    await click(next);
    expect(container.querySelector('[role="grid"]')!.getAttribute("aria-label")).toBe("December 2026");
    expect(container.querySelector('[role="status"]')!.textContent).toBe("December 2026");
  });

  test("a date-fns locale sets the language and the first day of the week", () => {
    const { container } = render(<Calendar mode="single" defaultMonth={november} locale={viLocale} />);
    const weekdays = [...container.querySelectorAll("th[scope=col]")].map((th) => th.getAttribute("aria-label"));
    expect(weekdays[0]).toBe("Thứ Hai");
    expect(container.querySelector('[role="grid"]')!.getAttribute("aria-label")).toContain("2026");
    expect(container.querySelector('[role="grid"]')!.getAttribute("aria-label")).not.toContain("November");
  });
});
