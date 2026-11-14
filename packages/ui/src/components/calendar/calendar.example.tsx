import { addDays, startOfMonth, subMonths } from "date-fns";
import { useState } from "react";
import { Calendar, type DateRange } from "@/components/calendar/calendar";

/** The smallest useful Calendar: one day, today marked. */
export function CalendarMinimal() {
  const [day, setDay] = useState<Date | undefined>(() => new Date());
  return <Calendar mode="single" selected={day} onSelect={setDay} aria-label="Snapshot date" />;
}

/**
 * The window of a query-history search: the last seven days as a range over two months, with
 * week numbers, weeks starting on Monday, and the days after today disabled.
 */
export function CalendarRealistic() {
  const today = new Date();
  const [range, setRange] = useState<DateRange | undefined>(() => ({ from: addDays(today, -6), to: today }));
  return (
    <Calendar
      mode="range"
      selected={range}
      onSelect={setRange}
      numberOfMonths={2}
      defaultMonth={startOfMonth(subMonths(today, 1))}
      weekStartsOn={1}
      showWeekNumber
      disabled={{ after: today }}
      aria-label="History window"
      footer={range?.from && range.to ? "Showing queries in the chosen window." : "Choose the last day."}
    />
  );
}
