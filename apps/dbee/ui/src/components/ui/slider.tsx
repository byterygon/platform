import { Slider as SliderPrimitive } from "@base-ui/react/slider";
import { cn } from "@/lib/cn";

// A slider on Base UI's Slider: a track of size.track, an accent indicator for the selected part
// and one thumb per value (two for a range). Each thumb holds a native <input type="range">, so
// the keyboard and screen readers work as on any range input; the ring follows that input.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const sliderVariants = {
  size: {
    sm: "[&_[data-slot=slider-thumb]]:size-icon-sm",
    md: "[&_[data-slot=slider-thumb]]:size-icon-md",
    lg: "[&_[data-slot=slider-thumb]]:size-icon-lg",
  },
} as const;

const base = [
  "flex w-full min-w-0 touch-none select-none font-sans",
  "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-auto",
  "data-disabled:cursor-not-allowed data-disabled:opacity-[var(--by-opacity-disabled)]",
];

const controlClasses = [
  "flex h-control-xs w-full items-center",
  "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-control-xs data-[orientation=vertical]:justify-center",
];

const trackClasses = [
  "relative h-track w-full rounded-full bg-border",
  "data-[orientation=vertical]:h-full data-[orientation=vertical]:w-track",
];

const indicatorClasses = ["rounded-full bg-accent-solid data-[orientation=horizontal]:h-full data-[orientation=vertical]:w-full"];

const thumbClasses = [
  "rounded-full border border-border-strong bg-surface shadow-raised",
  "transition-colors duration-[var(--by-motion-duration-fast)] ease-standard",
  "hover:border-accent-solid data-dragging:border-accent-solid",
  "has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-[length:var(--by-ring-width)] has-[:focus-visible]:outline-offset-[var(--by-ring-offset)] has-[:focus-visible]:outline-ring",
  "data-invalid:border-danger-border",
];

export interface SliderProps extends Omit<SliderPrimitive.Root.Props, "className" | "children"> {
  /** Thumb size, from the `size.icon.*` roles. */
  size?: keyof typeof sliderVariants.size;
  /** Accessible name of the thumb when there is no FieldLabel. */
  "aria-label"?: string;
  /** Names each thumb of a range ("Minimum", "Maximum"); the index is the thumb's. */
  getAriaLabel?: (index: number) => string;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A slider on Base UI's Slider: a number (`value`, `onValueChange`) or a range (an array of two
 * numbers, two thumbs) between `min` and `max` in `step`s. Inside a Field it takes the label and
 * validity. Vertical sliders need a height from the layout. The ref reaches the root `<div>`.
 */
export function Slider({ size = "md", "aria-label": ariaLabel, getAriaLabel, className, ...props }: SliderProps) {
  const initial = props.value ?? props.defaultValue;
  const count = Array.isArray(initial) ? initial.length : 1;
  return (
    <SliderPrimitive.Root data-slot="slider" data-size={size} className={cn(base, sliderVariants.size[size], className)} {...props}>
      <SliderPrimitive.Control data-slot="slider-control" className={cn(controlClasses)}>
        <SliderPrimitive.Track data-slot="slider-track" className={cn(trackClasses)}>
          <SliderPrimitive.Indicator data-slot="slider-indicator" className={cn(indicatorClasses)} />
          {Array.from({ length: count }, (_, index) => (
            <SliderPrimitive.Thumb
              key={index}
              index={index}
              data-slot="slider-thumb"
              aria-label={getAriaLabel ? undefined : ariaLabel}
              getAriaLabel={getAriaLabel}
              className={cn(thumbClasses)}
            />
          ))}
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}
