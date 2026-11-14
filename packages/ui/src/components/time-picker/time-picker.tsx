import { Input as InputPrimitive } from "@base-ui/react/input";
import { useLayoutEffect, useRef, useState, type ClipboardEvent, type FocusEvent, type KeyboardEvent, type MouseEvent, type Ref } from "react";
import { inputVariants } from "@/components/input/input";
import { cn } from "@/lib/cn";

// A time of day typed into segments: hours, minutes, optionally seconds, and AM/PM in the 12-hour
// cycle. Base UI has no time field, and a native <input type="time"> looks and behaves differently
// in each webview DBee runs in (WebKitGTK, WebView2, WKWebView), so this is one Base UI Input
// (so a Field labels, describes and validates it like any input) that edits its text a segment
// at a time: the selection is always one segment, the digits fill it and move on, the arrow keys
// step it. The value is "HH:mm" or "HH:mm:ss" on the 24-hour clock, or null until every segment
// has a value.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const timePickerVariants = {
  size: inputVariants.size,
} as const;

const base = [
  "flex w-full min-w-0 rounded-md border border-border-strong bg-surface font-sans text-body tabular-nums text-fg",
  "placeholder:text-fg-subtle selection:bg-selected selection:text-fg",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "outline-none focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-offset-[var(--by-ring-offset)] focus-visible:outline-ring",
  "aria-invalid:border-danger-border data-invalid:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

type Kind = "hour" | "minute" | "second" | "period";
type Period = "AM" | "PM";
interface Segments {
  hour: number | null;
  minute: number | null;
  second: number | null;
  period: Period | null;
}

const EMPTY: Segments = { hour: null, minute: null, second: null, period: null };

const range = (kind: Kind, cycle: 12 | 24) => (kind === "hour" ? (cycle === 12 ? [1, 12] : [0, 23]) : [0, 59]) as [number, number];

const pad = (n: number | null) => (n === null ? "--" : String(n).padStart(2, "0"));

/** "14:05", "14:05:09" (24-hour) into segments of the given cycle; null if it is not a time. */
export function parseTime(text: string | null | undefined, cycle: 12 | 24 = 24): Segments | null {
  if (!text) return null;
  const match = /^\s*(\d{1,2})(?:[:.h]?(\d{2}))(?:[:.](\d{2}))?\s*([ap])?\.?m?\.?\s*$/i.exec(text);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const suffix = match[4]?.toLowerCase();
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (suffix === "p" ? 12 : 0);
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (cycle === 24) return { hour, minute, second, period: null };
  return { hour: hour % 12 === 0 ? 12 : hour % 12, minute, second, period: hour < 12 ? "AM" : "PM" };
}

function toValue(s: Segments, kinds: readonly Kind[]): string | null {
  if (kinds.some((kind) => s[kind] === null)) return null;
  let hour = s.hour!;
  if (kinds.includes("period")) hour = (hour % 12) + (s.period === "PM" ? 12 : 0);
  const time = `${pad(hour)}:${pad(s.minute)}`;
  return kinds.includes("second") ? `${time}:${pad(s.second)}` : time;
}

/** The text of the segments and where each one sits in it. */
function layout(s: Segments, kinds: readonly Kind[]) {
  let text = "";
  const spans: [number, number][] = [];
  kinds.forEach((kind, index) => {
    if (index > 0) text += kind === "period" ? " " : ":";
    const part = kind === "period" ? (s.period ?? "--") : pad(s[kind]);
    spans.push([text.length, text.length + part.length]);
    text += part;
  });
  return { text, spans };
}

type Handled = "onKeyDown" | "onFocus" | "onBlur" | "onMouseDown" | "onMouseUp" | "onPaste";

export interface TimePickerProps extends Omit<InputPrimitive.Props, "className" | "size" | "value" | "defaultValue" | "onValueChange" | "type" | "ref" | Handled> {
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  onFocus?: (event: FocusEvent<HTMLInputElement>) => void;
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void;
  onMouseDown?: (event: MouseEvent<HTMLInputElement>) => void;
  onMouseUp?: (event: MouseEvent<HTMLInputElement>) => void;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  /** "HH:mm" (or "HH:mm:ss" with `seconds`) on the 24-hour clock; null while incomplete. */
  value?: string | null;
  /** Initial value when uncontrolled. */
  defaultValue?: string | null;
  /** Called with the new value when a segment changes: the time once all are filled, else null. */
  onValueChange?: (value: string | null) => void;
  /** Shows and edits seconds. */
  seconds?: boolean;
  /** 24 (default) or 12 with an AM/PM segment. The value is on the 24-hour clock either way. */
  hourCycle?: 12 | 24;
  /** How far ArrowUp and ArrowDown move the minutes. */
  minuteStep?: number;
  /** Control height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof timePickerVariants.size;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
  /** Reaches the `<input>`. */
  ref?: Ref<HTMLInputElement>;
}

/**
 * A time field on Base UI's Input, edited by segment. Inside a Field it takes the label,
 * description and validity. The ref reaches the `<input>`.
 */
export function TimePicker({
  value,
  defaultValue = null,
  onValueChange,
  seconds = false,
  hourCycle = 24,
  minuteStep = 1,
  size = "md",
  placeholder,
  readOnly,
  className,
  ref,
  onKeyDown,
  onFocus,
  onBlur,
  onMouseDown,
  onMouseUp,
  onPaste,
  ...props
}: TimePickerProps) {
  const kinds: Kind[] = ["hour", "minute"];
  if (seconds) kinds.push("second");
  if (hourCycle === 12) kinds.push("period");

  const [segments, setSegments] = useState<Segments>(() => parseTime(value !== undefined ? value : defaultValue, hourCycle) ?? EMPTY);
  const [active, setActive] = useState(0);
  // The value last reported or received, so a controlled value that changes elsewhere replaces
  // the segments, while one that only echoes the segments' own value leaves a partial edit alone.
  const [known, setKnown] = useState<string | null | undefined>(value);
  if (value !== undefined && value !== known) {
    setKnown(value);
    setSegments(parseTime(value, hourCycle) ?? EMPTY);
  }
  const typed = useRef("");
  const input = useRef<HTMLInputElement | null>(null);
  const pointer = useRef(false);

  const empty = kinds.every((kind) => segments[kind] === null);
  const { text, spans } = layout(segments, kinds);
  const shown = empty ? "" : text;

  /** Selects segment `index` while the input has focus; the layout effect keeps it selected. */
  const select = (index: number) => {
    const element = input.current;
    if (!element || element.ownerDocument.activeElement !== element || !shown) return;
    const [start, end] = spans[index]!;
    element.setSelectionRange(start, end);
  };

  useLayoutEffect(() => select(active));

  const commit = (next: Segments) => {
    setSegments(next);
    const before = toValue(segments, kinds);
    const after = toValue(next, kinds);
    if (after !== before) {
      setKnown(after);
      onValueChange?.(after);
    }
  };

  const move = (index: number) => {
    typed.current = "";
    setActive(Math.max(0, Math.min(kinds.length - 1, index)));
  };

  const step = (kind: Kind, delta: number) => {
    if (kind === "period") return commit({ ...segments, period: segments.period === "AM" ? "PM" : "AM" });
    const [min, max] = range(kind, hourCycle);
    const current = segments[kind];
    const size = max - min + 1;
    const amount = kind === "minute" ? delta * minuteStep : delta;
    const next = current === null ? (delta > 0 ? min : max) : ((((current - min + amount) % size) + size) % size) + min;
    commit({ ...segments, [kind]: next });
  };

  const type = (kind: Kind, digit: number) => {
    if (kind === "period") return;
    const [min, max] = range(kind, hourCycle);
    const digits = typed.current + String(digit);
    const number = Number(digits);
    if (digits.length === 1) {
      // A first digit that cannot start a two-digit value fills the segment on its own.
      if (number * 10 > max) {
        commit({ ...segments, [kind]: Math.max(min, number) });
        return move(active + 1);
      }
      typed.current = digits;
      commit({ ...segments, [kind]: number < min ? null : number });
      return;
    }
    typed.current = "";
    commit({ ...segments, [kind]: number > max || number < min ? (digit < min ? segments[kind] : digit) : number });
    move(active + 1);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const kind = kinds[active]!;
    const editable = !readOnly && !props.disabled;
    switch (event.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        event.preventDefault();
        const forward = (event.key === "ArrowRight") !== (event.currentTarget.dir === "rtl" || getComputedStyle(event.currentTarget).direction === "rtl");
        return move(active + (forward ? 1 : -1));
      }
      case "ArrowUp":
      case "ArrowDown":
        event.preventDefault();
        typed.current = "";
        if (editable) step(kind, event.key === "ArrowUp" ? 1 : -1);
        return;
      case "Home":
      case "End": {
        event.preventDefault();
        if (!editable) return;
        if (kind === "period") return commit({ ...segments, period: event.key === "Home" ? "AM" : "PM" });
        const [min, max] = range(kind, hourCycle);
        return commit({ ...segments, [kind]: event.key === "Home" ? min : max });
      }
      case "Backspace":
      case "Delete":
        event.preventDefault();
        if (!editable) return;
        typed.current = "";
        if (segments[kind] === null && event.key === "Backspace") return move(active - 1);
        return commit({ ...segments, [kind]: null });
      case ":":
      case ".":
      case " ":
        event.preventDefault();
        return move(active + 1);
      case "Tab":
      case "Enter":
      case "Escape":
        return;
    }
    if (event.key.length !== 1) return;
    event.preventDefault();
    if (!editable) return;
    if (/^\d$/.test(event.key)) {
      if (kind === "period") return;
      return type(kind, Number(event.key));
    }
    const letter = event.key.toLowerCase();
    if (kinds.includes("period") && (letter === "a" || letter === "p")) {
      commit({ ...segments, period: letter === "a" ? "AM" : "PM" });
      if (kind === "period") move(active + 1);
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLInputElement>) => {
    onPaste?.(event);
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (readOnly || props.disabled) return;
    const parsed = parseTime(event.clipboardData.getData("text"), hourCycle);
    if (parsed) commit({ ...parsed, second: seconds ? parsed.second : null });
  };

  const handleFocus = (event: FocusEvent<HTMLInputElement>) => {
    onFocus?.(event);
    typed.current = "";
    if (pointer.current) return;
    setActive(0);
    select(0);
  };

  const handleMouseUp = (event: MouseEvent<HTMLInputElement>) => {
    onMouseUp?.(event);
    pointer.current = false;
    const caret = event.currentTarget.selectionStart ?? 0;
    const index = spans.findIndex(([, end]) => caret <= end);
    const next = index < 0 ? kinds.length - 1 : index;
    typed.current = "";
    setActive(next);
    select(next);
  };

  const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
    onBlur?.(event);
    typed.current = "";
  };

  const setRef = (element: HTMLInputElement | null) => {
    input.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  };

  return (
    <InputPrimitive
      ref={setRef}
      data-slot="time-picker"
      data-size={size}
      type="text"
      inputMode={hourCycle === 24 ? "numeric" : "text"}
      autoComplete="off"
      spellCheck={false}
      placeholder={placeholder ?? layout(EMPTY, kinds).text}
      pattern={hourCycle === 24 ? (seconds ? "\\d{2}:\\d{2}:\\d{2}" : "\\d{2}:\\d{2}") : seconds ? "\\d{2}:\\d{2}:\\d{2} [AP]M" : "\\d{2}:\\d{2} [AP]M"}
      readOnly={readOnly}
      value={shown}
      onValueChange={(next) => {
        // Typing is handled by key; this is an input method, autofill or a mobile keyboard.
        const parsed = parseTime(next, hourCycle);
        if (parsed) commit({ ...parsed, second: seconds ? parsed.second : null });
        else if (!next) commit(EMPTY);
      }}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onMouseDown={(event) => {
        onMouseDown?.(event);
        pointer.current = true;
      }}
      onMouseUp={handleMouseUp}
      className={cn(base, timePickerVariants.size[size], className)}
      {...props}
    />
  );
}
