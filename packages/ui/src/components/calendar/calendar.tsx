import { useEffect, useRef } from "react";
import { DayPicker, type ChevronProps, type ClassNames, type DayButtonProps, type DayPickerProps, type RootProps } from "react-day-picker";
import { buttonBase } from "@/components/button/button";
import { iconButtonVariants } from "@/components/icon-button/icon-button";
import { cn } from "@/lib/cn";

// A month grid to pick a day, several days or a range, on react-day-picker (dates on date-fns),
// as shadcn's Calendar is. Base UI has no calendar. Every class react-day-picker would add is
// replaced by token classes, so its stylesheet is never needed. Days are buttons the size of a
// control (size.control.md, so they follow data-density); the chosen day is the accent solid, the
// days inside a range sit on the accent subtle band, and today has an accent border and the
// strong weight. Language, first day of the week and labels come from a date-fns `locale`.

export type { DateRange, Matcher } from "react-day-picker";

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const calendarVariants = {} as const;

const dayButton = [
  "flex size-control-md select-none items-center justify-center rounded-md border border-transparent bg-transparent font-sans text-body tabular-nums text-fg",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "hover:bg-hover active:bg-pressed",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "data-today:border-accent-solid data-today:text-body-strong",
  "data-outside:text-fg-subtle",
  "data-selected:bg-accent-solid data-selected:text-accent-solid-fg data-selected:hover:bg-accent-solid-hover data-selected:active:bg-accent-solid-active",
  "data-range-start:rounded-e-none data-range-end:rounded-s-none",
  "data-range-middle:rounded-none data-range-middle:text-accent-subtle-fg",
  "data-disabled:pointer-events-none data-disabled:text-fg-disabled data-disabled:line-through",
];

const rootClasses = "w-fit font-sans text-body text-fg";

const cell = "p-0 text-center align-middle";

/**
 * Every class react-day-picker sets, keyed by its element, flag and selection state. Complete on
 * purpose: a key left out would fall back to react-day-picker's `rdp-*` class, which only its own
 * stylesheet styles.
 */
const classNames: ClassNames = {
  // The root takes its classes through `className` (below), so a caller's classes merge with cn.
  root: "",
  months: "flex flex-wrap gap-inline-xl",
  month: "flex flex-wrap items-center gap-y-stack-sm",
  month_caption: "flex h-control-sm flex-1 items-center justify-center",
  caption_label: "select-none text-label text-fg",
  nav: "flex items-center gap-inline-xs",
  button_previous: cn(buttonBase, iconButtonVariants.variant.ghost, iconButtonVariants.size.sm, "aria-disabled:pointer-events-none aria-disabled:opacity-[var(--by-opacity-disabled)]"),
  button_next: cn(buttonBase, iconButtonVariants.variant.ghost, iconButtonVariants.size.sm, "aria-disabled:pointer-events-none aria-disabled:opacity-[var(--by-opacity-disabled)]"),
  chevron: "",
  month_grid: "basis-full border-collapse",
  weekdays: "",
  weekday: cn(cell, "h-control-sm text-caption text-fg-muted"),
  weeks: "",
  week: "",
  week_number_header: cn(cell, "w-control-md text-caption text-fg-subtle"),
  week_number: cn(cell, "w-control-md text-caption tabular-nums text-fg-subtle"),
  day: cell,
  day_button: cn(dayButton),
  footer: "basis-full pt-stack-sm text-caption text-fg-muted",
  // The day cell, by flag. The button inside shows them (data attributes below), not the cell.
  today: "",
  outside: "",
  disabled: "",
  focused: "",
  hidden: "invisible",
  // A range: the band under the days, rounded at its ends; the end days are the accent solid.
  selected: "",
  range_start: "rounded-s-md bg-accent-subtle",
  range_middle: "bg-accent-subtle",
  range_end: "rounded-e-md bg-accent-subtle",
  // Month and year dropdowns and the month animation are not offered (captionLayout is "label").
  dropdowns: "",
  dropdown: "",
  dropdown_root: "",
  months_dropdown: "",
  years_dropdown: "",
  weeks_before_enter: "",
  weeks_before_exit: "",
  weeks_after_enter: "",
  weeks_after_exit: "",
  caption_after_enter: "",
  caption_after_exit: "",
  caption_before_enter: "",
  caption_before_exit: "",
};

function CalendarRoot({ rootRef, ...props }: RootProps) {
  return <div data-slot="calendar" ref={rootRef} {...props} />;
}

function CalendarChevron({ orientation = "down", className }: ChevronProps) {
  const path = { left: "m10 4-4 4 4 4", right: "m6 4 4 4-4 4", up: "m4 10 4-4 4 4", down: "m4 6 4 4 4-4" }[orientation];
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className={className || undefined}>
      <path d={path} />
    </svg>
  );
}

/**
 * A day: react-day-picker's button with its state as data attributes, so the classes style the
 * button itself. `data-selected` marks a chosen day or the end of a range, not the days between.
 * Calendar uses it; pass it on as `components.DayButton` when wrapping it to add content.
 */
export function CalendarDayButton({ day: _day, modifiers, ...props }: DayButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (modifiers.focused) ref.current?.focus();
  }, [modifiers.focused]);
  const start = modifiers.range_start && !modifiers.range_end;
  const end = modifiers.range_end && !modifiers.range_start;
  return (
    <button
      ref={ref}
      data-slot="calendar-day-button"
      data-selected={(modifiers.selected && !modifiers.range_middle) || undefined}
      data-range-start={start || undefined}
      data-range-end={end || undefined}
      data-range-middle={modifiers.range_middle || undefined}
      data-today={modifiers.today || undefined}
      data-outside={modifiers.outside || undefined}
      data-disabled={modifiers.disabled || undefined}
      {...props}
    />
  );
}

// Omit over each member of react-day-picker's props union, so `mode` still narrows `selected`.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type CalendarProps = DistributiveOmit<DayPickerProps, "classNames" | "modifiersClassNames" | "captionLayout" | "animate" | "styles" | "className"> & {
  /** Extra classes for the root, merged after the component's own so they win. */
  className?: string;
};

/**
 * A calendar on react-day-picker: `mode` "single", "multiple" or "range" with `selected` and
 * `onSelect` as react-day-picker's. Days of other months show (and can be chosen) unless
 * `showOutsideDays={false}`; `disabled` takes react-day-picker matchers (`{ before: date }`).
 * Pass a date-fns `locale` for the language and the first day of the week.
 */
export function Calendar({ className, showOutsideDays = true, navLayout = "around", components, ...props }: CalendarProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      navLayout={navLayout}
      className={cn(rootClasses, className)}
      classNames={classNames}
      components={{ Root: CalendarRoot, Chevron: CalendarChevron, DayButton: CalendarDayButton, ...components }}
      {...(props as DayPickerProps)}
    />
  );
}
