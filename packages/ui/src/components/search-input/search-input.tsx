import { Input as InputPrimitive } from "@base-ui/react/input";
import { useRef, useState } from "react";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, inputGroupVariants } from "@/components/input-group/input-group";
import { cn } from "@/lib/cn";

// A search box: an InputGroup with a search icon, Base UI's Input as type="search" (so it works
// inside a Field and gets role searchbox), and a Clear button while there is text. Escape clears
// too; with nothing to clear it lets Escape through, so a dialog around it still closes.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const searchInputVariants = {
  /** InputGroup applies these; listed here so the manifest and the tests see every size. */
  size: inputGroupVariants.size,
} as const;

// The browser's own clear button would duplicate ours. While Clear is hidden the input is the
// last visible item but not :last-child, so it takes the end padding itself.
const inputClasses = ["[&::-webkit-search-cancel-button]:appearance-none", "[&:has(+[hidden])]:pe-control-x"];

const clearClasses = ["text-fg-muted hover:text-fg"];

const SearchIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3.5 3.5" />
  </svg>
);

const ClearIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m4.5 4.5 7 7m0-7-7 7" />
  </svg>
);

export interface SearchInputProps extends Omit<InputPrimitive.Props, "className" | "size" | "type" | "value" | "defaultValue" | "onValueChange"> {
  /** Controlled text. */
  value?: string;
  /** Initial text when uncontrolled. */
  defaultValue?: string;
  /** Called on every change, with "" when the text is cleared. */
  onValueChange?: (value: string) => void;
  /** Height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof inputGroupVariants.size;
  /** The Clear button's accessible name. */
  clearLabel?: string;
  /** Extra classes for the frame, merged after the component's own so they win. */
  className?: string;
}

/**
 * A search box on InputGroup and Base UI's Input (`type="search"`): a search icon, the text, and a
 * Clear button while there is text. Escape clears. Name it with a FieldLabel or aria-label. The ref
 * reaches the `<input>`; className the frame.
 */
export function SearchInput({
  value,
  defaultValue = "",
  onValueChange,
  size = "md",
  clearLabel = "Clear search",
  disabled,
  readOnly,
  onKeyDown,
  ref,
  className,
  ...props
}: SearchInputProps) {
  const [own, setOwn] = useState(defaultValue);
  const text = value ?? own;
  const input = useRef<HTMLInputElement | null>(null);
  const change = (next: string) => {
    setOwn(next);
    onValueChange?.(next);
  };
  const clear = () => {
    change("");
    input.current?.focus();
  };
  const keyDown = (event: Parameters<NonNullable<InputPrimitive.Props["onKeyDown"]>>[0]) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== "Escape" || text === "" || disabled || readOnly) return;
    event.preventDefault();
    event.stopPropagation();
    change("");
  };
  const setRef = (element: HTMLInputElement | null) => {
    input.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) ref.current = element;
  };
  return (
    <InputGroup data-slot="search-input" size={size} className={cn(className)}>
      <InputGroupAddon>
        <SearchIcon />
      </InputGroupAddon>
      <InputGroupInput
        ref={setRef}
        type="search"
        value={text}
        onValueChange={change}
        onKeyDown={keyDown}
        disabled={disabled}
        readOnly={readOnly}
        className={cn(inputClasses)}
        {...props}
      />
      {/* Always rendered (hidden while there is nothing to clear), so the DOM and tab order stay stable. */}
      <InputGroupButton aria-label={clearLabel} hidden={text === "" || disabled || readOnly} onClick={clear} className={cn(clearClasses)}>
        <ClearIcon />
      </InputGroupButton>
    </InputGroup>
  );
}
