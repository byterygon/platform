import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { format as formatDate, isAfter, isBefore, isValid, parse, startOfDay, type Locale } from "date-fns";
import { useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type Ref } from "react";
import { Calendar, type DateRange, type Matcher } from "@/components/calendar/calendar";
import { InputGroup, InputGroupButton, InputGroupInput, inputGroupVariants } from "@/components/input-group/input-group";
import { popupClasses, popupOffset } from "@/components/select/select";
import { cn } from "@/lib/cn";
import { useThemeScope } from "@/lib/theme-scope";

// A date (or a range of dates) typed into a text field or picked from a Calendar in a popup, on
// InputGroup (so a Field labels, describes and validates the text field) and Base UI's Popover.
// The text is read with date-fns in `format` (yyyy-MM-dd by default, the order a database
// prints) when the field loses focus or on Enter; text that is not a date in that format, or is
// outside min and max, leaves the value null and marks the field aria-invalid until corrected.
// Dates are local days at midnight (date-fns), with no time zone of their own.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const datePickerVariants = {
  size: inputGroupVariants.size,
} as const;

const triggerClasses = ["data-popup-open:bg-pressed"];

const popupStyle = { maxHeight: "var(--available-height)", transformOrigin: "var(--transform-origin)" } as const;

/** A range with both ends, as DatePicker reports it. */
export interface DatePickerRange {
  from: Date;
  to: Date;
}

const CalendarIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
    <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
  </svg>
);

// Range text: "2026-11-01 – 2026-11-14"; an en or em dash, "to", ".." or a spaced hyphen between.
const RANGE_SEPARATOR = /\s*[–—]\s*|\s+-\s+|\s+to\s+|\s*\.\.\s*/i;
const RANGE_JOIN = " – ";

interface CommonProps {
  /** The date-fns pattern of the text, for reading and writing it. */
  format?: string;
  /** date-fns locale: the calendar's language and first weekday, and month names in `format`. */
  locale?: Locale;
  /** The earliest day that can be chosen or typed. */
  min?: Date;
  /** The latest day that can be chosen or typed. */
  max?: Date;
  /** More days the calendar does not offer (react-day-picker matchers: weekends, holidays). */
  disabledDays?: Matcher | Matcher[];
  /** First day of the week in the calendar, over the locale's (1 is Monday). */
  weekStartsOn?: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Months side by side in the popup; two by default for a range. */
  numberOfMonths?: number;
  /** Control height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof datePickerVariants.size;
  /** Shown while the text is empty; the format by default. */
  placeholder?: string;
  /** Accessible name of the calendar button. */
  calendarLabel?: string;
  /** Controlled open state of the calendar popup. */
  open?: boolean;
  /** Initial open state when uncontrolled. */
  defaultOpen?: boolean;
  /** Called when the popup opens or closes. */
  onOpenChange?: (open: boolean) => void;
  /** The form field name of the text field; a Field's name wins. */
  name?: string;
  id?: string;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  autoFocus?: boolean;
  /** Accessible name when there is no FieldLabel; set on the text field. */
  "aria-label"?: string;
  "aria-describedby"?: string;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
  /** Extra classes for the frame, merged after the component's own so they win. */
  className?: string;
  /** Reaches the text `<input>`. */
  ref?: Ref<HTMLInputElement>;
}

interface SingleProps extends CommonProps {
  /** One day (default) or a range of two. */
  mode?: "single";
  /** Controlled value; null when empty or when the text is not a date. */
  value?: Date | null;
  /** Initial value when uncontrolled. */
  defaultValue?: Date | null;
  /** Called with the new day, or null. */
  onValueChange?: (value: Date | null) => void;
}

interface RangeProps extends CommonProps {
  mode: "range";
  /** Controlled value: both ends, or null. */
  value?: DatePickerRange | null;
  defaultValue?: DatePickerRange | null;
  /** Called with both ends once the range is complete, or null. */
  onValueChange?: (value: DatePickerRange | null) => void;
}

export type DatePickerProps = SingleProps | RangeProps;

type Value = Date | DatePickerRange | null;

const sameValue = (a: Value | undefined, b: Value | undefined) => {
  if (a == null || b == null) return a == b;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return a.from.getTime() === b.from.getTime() && a.to.getTime() === b.to.getTime();
};

/**
 * A date field on InputGroup and Base UI's Popover: type the date, or open the Calendar with the
 * button (or Alt+ArrowDown). `mode="range"` takes two dates. Inside a Field the text field takes
 * the label, description and validity. The ref reaches the text `<input>`.
 */
export function DatePicker(props: DatePickerProps) {
  const {
    mode = "single",
    value,
    defaultValue = null,
    onValueChange,
    format = "yyyy-MM-dd",
    locale,
    min,
    max,
    disabledDays,
    weekStartsOn,
    numberOfMonths = mode === "range" ? 2 : 1,
    size = "md",
    placeholder,
    calendarLabel = mode === "range" ? "Choose dates" : "Choose date",
    open: openProp,
    defaultOpen = false,
    onOpenChange,
    disabled,
    readOnly,
    onBlur,
    className,
    ref,
    ...inputProps
  } = props;
  const range = mode === "range";
  const report = onValueChange as ((value: Value) => void) | undefined;

  // exactOptionalPropertyTypes: date-fns takes no `locale: undefined`.
  const options = locale ? { locale } : {};

  const write = (v: Value) => {
    if (!v) return "";
    if (v instanceof Date) return formatDate(v, format, options);
    return `${formatDate(v.from, format, options)}${RANGE_JOIN}${formatDate(v.to, format, options)}`;
  };

  const [current, setCurrent] = useState<Value>(() => (value !== undefined ? value : defaultValue));
  const [text, setText] = useState(() => write(current));
  const [unparsed, setUnparsed] = useState(false);
  // A controlled value that changes elsewhere replaces the text.
  const [known, setKnown] = useState<Value | undefined>(value);
  if (value !== undefined && !sameValue(value, known)) {
    setKnown(value);
    setCurrent(value);
    setText(write(value));
    setUnparsed(false);
  }

  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  // The days chosen so far while the popup is open (the first end of a range).
  const [draft, setDraft] = useState<DateRange | undefined>();

  const { ref: frameRef, anchor, scope, refresh } = useThemeScope<HTMLDivElement>();
  const input = useRef<HTMLInputElement | null>(null);
  const popup = useRef<HTMLDivElement | null>(null);

  // A disabled Field disables the text field (Base UI's Input); the button follows it.
  const [fieldDisabled, setFieldDisabled] = useState(false);
  useLayoutEffect(() => {
    const next = input.current?.hasAttribute("data-disabled") ?? false;
    if (next !== fieldDisabled) setFieldDisabled(next);
  });

  const inBounds = (day: Date) => (!min || !isBefore(day, startOfDay(min))) && (!max || !isAfter(day, startOfDay(max)));

  const read = (raw: string): Value | undefined => {
    const day = (part: string) => {
      const parsed = parse(part.trim(), format, new Date(), options);
      return isValid(parsed) && inBounds(parsed) ? parsed : undefined;
    };
    if (!range) return day(raw);
    const parts = raw.split(RANGE_SEPARATOR);
    if (parts.length !== 2) return undefined;
    const from = day(parts[0]!);
    const to = day(parts[1]!);
    return from && to && !isAfter(from, to) ? { from, to } : undefined;
  };

  const commit = (next: Value) => {
    setCurrent(next);
    if (!sameValue(next, current)) {
      setKnown(next);
      report?.(next);
    }
  };

  const commitText = () => {
    if (!text.trim()) {
      setUnparsed(false);
      setText("");
      return commit(null);
    }
    const parsed = read(text);
    if (parsed === undefined) {
      setUnparsed(true);
      return commit(null);
    }
    setUnparsed(false);
    setText(write(parsed));
    commit(parsed);
  };

  const setOpen = (next: boolean) => {
    if (next) {
      refresh();
      setDraft(undefined);
    }
    setOpenState(next);
    onOpenChange?.(next);
  };

  const choose = (next: Value) => {
    setUnparsed(false);
    setText(write(next));
    commit(next);
    setOpen(false);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") commitText();
    if (event.key === "ArrowDown" && event.altKey && !readOnly && !disabled) {
      event.preventDefault();
      commitText();
      setOpen(true);
    }
  };

  const setInputRef = (element: HTMLInputElement | null) => {
    input.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  };

  const days: Matcher[] = [...(min ? [{ before: min }] : []), ...(max ? [{ after: max }] : []), ...(disabledDays === undefined ? [] : Array.isArray(disabledDays) ? disabledDays : [disabledDays])];
  const shownMonth = current instanceof Date ? current : (current?.from ?? (max && isBefore(max, new Date()) ? max : min && isAfter(min, new Date()) ? min : undefined));
  const calendar = {
    ...options,
    ...(weekStartsOn === undefined ? {} : { weekStartsOn }),
    ...(shownMonth ? { defaultMonth: shownMonth } : {}),
    ...(min ? { startMonth: min } : {}),
    ...(max ? { endMonth: max } : {}),
    numberOfMonths,
    disabled: days,
  };
  const triggerDisabled = disabled || readOnly || fieldDisabled;

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={(next) => setOpen(next)}>
      <InputGroup ref={frameRef} data-slot="date-picker" size={size} className={cn(className)}>
        <InputGroupInput
          ref={setInputRef}
          value={text}
          onValueChange={(next) => {
            setText(next);
            if (unparsed && read(next) !== undefined) setUnparsed(false);
          }}
          onKeyDown={handleKeyDown}
          onBlur={(event) => {
            commitText();
            onBlur?.(event);
          }}
          placeholder={placeholder ?? (range ? `${format}${RANGE_JOIN}${format}` : format)}
          aria-invalid={unparsed || undefined}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          readOnly={readOnly}
          {...inputProps}
        />
        <PopoverPrimitive.Trigger
          disabled={triggerDisabled}
          render={
            <InputGroupButton data-slot="date-picker-trigger" aria-label={calendarLabel} className={cn(triggerClasses)}>
              <CalendarIcon />
            </InputGroupButton>
          }
        />
      </InputGroup>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner {...scope} data-slot="date-picker-positioner" anchor={anchor} side="bottom" align="start" sideOffset={() => popupOffset(anchor.current)} className={cn(popupClasses.positioner)}>
          <PopoverPrimitive.Popup
            ref={popup}
            data-slot="date-picker-popup"
            style={popupStyle}
            initialFocus={() => popup.current?.querySelector<HTMLElement>('[data-slot="calendar-day-button"][tabindex="0"]') ?? true}
            finalFocus={input}
            className={cn(popupClasses.popup, "p-inset-sm")}
          >
            {range ? (
              <Calendar
                mode="range"
                {...calendar}
                resetOnSelect
                selected={draft ?? (current && !(current instanceof Date) ? current : undefined)}
                onSelect={(next) => {
                  setDraft(next ?? undefined);
                  if (next?.from && next.to && draft?.from) choose({ from: next.from, to: next.to });
                }}
                aria-label={calendarLabel}
              />
            ) : (
              <Calendar
                mode="single"
                {...calendar}
                required
                selected={current instanceof Date ? current : undefined}
                onSelect={(next) => choose(next)}
                aria-label={calendarLabel}
              />
            )}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
