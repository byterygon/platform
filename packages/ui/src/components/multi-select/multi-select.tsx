import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type { ReactNode, Ref } from "react";
import { ChevronIcon, ClearIcon, ComboboxPopup, frameButtonClasses } from "@/components/combobox/combobox";
import { cn } from "@/lib/cn";
import { useThemeScope } from "@/lib/theme-scope";

// Several choices from a list, on Base UI's Combobox with `multiple`: each chosen item is a chip
// (with a remove button) before the text input, which filters the list as in Combobox. The list
// stays open after a choice so several can be picked in a row; Backspace in the empty input
// removes the last chip, and ArrowLeft from the start of the input moves onto the chips. The
// popup and items are Combobox's (ComboboxItem, ComboboxGroup, ComboboxGroupLabel).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const multiSelectVariants = {
  size: {
    sm: "min-h-control-sm",
    md: "min-h-control-md",
    lg: "min-h-control-lg",
  },
} as const;

// Written out in full (no template strings): Tailwind finds classes by scanning the source as text.
const frameClasses = [
  "flex w-full min-w-0 cursor-text items-center gap-inline-xs rounded-md border border-border-strong bg-surface ps-control-x pe-inline-xs font-sans text-body text-fg",
  "has-[[data-slot=multi-select-chip]]:ps-inline-xs",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-[length:var(--by-ring-width)]",
  "has-[input:focus-visible]:outline-offset-[var(--by-ring-offset)] has-[input:focus-visible]:outline-ring",
  "data-popup-open:border-border-focus",
  "data-invalid:border-danger-border has-[[aria-invalid=true]]:border-danger-border",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

const chipsClasses = "flex min-w-0 flex-1 flex-wrap items-center gap-inline-xs py-inset-xs";

const chipClasses = [
  "flex h-control-xs min-w-0 max-w-full cursor-default items-center gap-inline-xs rounded-sm bg-neutral-subtle ps-inset-xs text-label text-neutral-subtle-fg outline-none",
  "has-[[data-slot=multi-select-chip-remove][data-disabled]]:pe-inset-xs",
  "data-highlighted:bg-selected",
  "focus-visible:outline-solid focus-visible:outline-[length:var(--by-ring-width)] focus-visible:outline-ring",
];

const chipRemoveClasses = [
  "flex h-full aspect-square shrink-0 items-center justify-center rounded-sm text-fg-muted outline-none",
  "hover:bg-hover hover:text-fg",
  "data-disabled:hidden",
  "[&_svg]:size-icon-xs",
];

const inputClasses = [
  "h-control-xs min-w-control-lg flex-1 bg-transparent text-body text-fg outline-none",
  "placeholder:text-fg-subtle",
  "data-disabled:cursor-not-allowed",
];

/** A chosen value's text: `itemToStringLabel`, else a `{ label }` object's label, else the value. */
function labelOf<Value>(value: Value, itemToStringLabel?: (value: Value) => string): string {
  if (itemToStringLabel) return itemToStringLabel(value);
  if (value && typeof value === "object" && "label" in value) return String(value.label);
  return String(value);
}

/** A chosen value's React key: a `{ value }` object's value, else the value. */
function keyOf(value: unknown): string {
  if (value && typeof value === "object" && "value" in value) return String(value.value);
  return String(value);
}

export interface MultiSelectProps<Value, Item = Value> extends Omit<ComboboxPrimitive.Root.Props<Value, true, Item>, "multiple" | "children"> {
  /** Minimum frame height, from the density-aware `size.control.*` roles; chips wrap below. */
  size?: keyof typeof multiSelectVariants.size;
  /** Placeholder of the text input while nothing is chosen. */
  placeholder?: string;
  /** Accessible name when there is no FieldLabel; set on the input. */
  "aria-label"?: string;
  /** Shown when no item matches the text. */
  emptyMessage?: ReactNode;
  /** A line above the items (loading, an error), announced politely; nothing when empty. */
  status?: ReactNode;
  /** The clear button's accessible name (it removes every value). */
  clearLabel?: string;
  /** A chip's remove button name, from the chip's text. */
  removeLabel?: (label: string) => string;
  /** The list: a function from each (filtered) item to a ComboboxItem, or ComboboxItem children. */
  children?: ReactNode | ((item: Item, index: number) => ReactNode);
  /** Extra classes for the frame, merged after the component's own so they win. */
  className?: string;
  /** Reaches the `<input>`. */
  ref?: Ref<HTMLInputElement>;
}

/**
 * A multi-select on Base UI's Combobox. Pass `items` and a function child that renders each one
 * as a ComboboxItem, as for Combobox; `value` is an array. Inside a Field it takes the label,
 * description and validity; the ref reaches the input.
 */
export function MultiSelect<Value, Item = Value>({
  size = "md",
  placeholder,
  "aria-label": ariaLabel,
  emptyMessage = "No results.",
  status,
  clearLabel = "Clear all",
  removeLabel = (label) => `Remove ${label}`,
  children,
  className,
  ref,
  autoHighlight = true,
  itemToStringLabel,
  onOpenChange,
  ...props
}: MultiSelectProps<Value, Item>) {
  const { ref: anchorRef, anchor, scope, refresh } = useThemeScope<HTMLDivElement>();
  return (
    <ComboboxPrimitive.Root<Value, true, Item>
      multiple
      autoHighlight={autoHighlight}
      {...(itemToStringLabel ? { itemToStringLabel } : {})}
      onOpenChange={(open, details) => {
        // Keep the list open after a choice, so several can be picked in a row.
        if (!open && details.reason === "item-press") {
          details.cancel();
          return;
        }
        if (open) refresh();
        onOpenChange?.(open, details);
      }}
      {...props}
    >
      <ComboboxPrimitive.InputGroup ref={anchorRef} data-slot="multi-select" data-size={size} className={cn(frameClasses, multiSelectVariants.size[size], className)}>
        <ComboboxPrimitive.Chips data-slot="multi-select-chips" className={chipsClasses}>
          <ComboboxPrimitive.Value>
            {(values: Value[]) => (
              <>
                {values.map((value) => {
                  const label = labelOf(value, itemToStringLabel);
                  return (
                    <ComboboxPrimitive.Chip key={keyOf(value)} data-slot="multi-select-chip" aria-label={label} className={cn(chipClasses)}>
                      <span className="truncate">{label}</span>
                      <ComboboxPrimitive.ChipRemove data-slot="multi-select-chip-remove" aria-label={removeLabel(label)} className={cn(chipRemoveClasses)}>
                        <ClearIcon />
                      </ComboboxPrimitive.ChipRemove>
                    </ComboboxPrimitive.Chip>
                  );
                })}
                <ComboboxPrimitive.Input
                  ref={ref}
                  data-slot="multi-select-input"
                  placeholder={values.length > 0 ? undefined : placeholder}
                  aria-label={ariaLabel}
                  className={cn(inputClasses)}
                />
              </>
            )}
          </ComboboxPrimitive.Value>
        </ComboboxPrimitive.Chips>
        <ComboboxPrimitive.Clear data-slot="multi-select-clear" keepMounted aria-label={clearLabel} className={cn(frameButtonClasses, "not-data-visible:hidden data-disabled:hidden")}>
          <ClearIcon />
        </ComboboxPrimitive.Clear>
        <ComboboxPrimitive.Trigger data-slot="multi-select-trigger" className={cn(frameButtonClasses, "data-popup-open:text-fg")}>
          <ChevronIcon />
        </ComboboxPrimitive.Trigger>
      </ComboboxPrimitive.InputGroup>
      <ComboboxPopup scope={scope} anchor={anchor} emptyMessage={emptyMessage} status={status}>
        {children}
      </ComboboxPopup>
    </ComboboxPrimitive.Root>
  );
}
