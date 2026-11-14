import { Input as InputPrimitive } from "@base-ui/react/input";
import { useState } from "react";
import { InputGroup, InputGroupButton, InputGroupInput, inputGroupVariants } from "@/components/input-group/input-group";
import { cn } from "@/lib/cn";

// A password field: an InputGroup with Base UI's Input (so it works inside a Field) and a button
// that shows or hides the text. The button keeps one name ("Show password") and reports its state
// with aria-pressed, so a screen reader hears "Show password, toggle button, pressed".

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const passwordInputVariants = {
  /** InputGroup applies these; listed here so the manifest and the tests see every size. */
  size: inputGroupVariants.size,
} as const;

const toggleClasses = ["text-fg-muted hover:text-fg aria-pressed:text-fg"];

const EyeIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
    <circle cx="8" cy="8" r="2" />
  </svg>
);

const EyeOffIcon = () => (
  <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M2 2l12 12M6.6 6.7a2 2 0 0 0 2.7 2.7M4.2 4.4C2.5 5.6 1.5 8 1.5 8s2.4 4.5 6.5 4.5c1.4 0 2.6-.5 3.6-1.2M7 3.6c.3 0 .7-.1 1-.1 4.1 0 6.5 4.5 6.5 4.5s-.6 1.1-1.6 2.3" />
  </svg>
);

export interface PasswordInputProps extends Omit<InputPrimitive.Props, "className" | "size" | "type"> {
  /** Height, from the density-aware `size.control.*` roles. */
  size?: keyof typeof inputGroupVariants.size;
  /** Controlled: whether the text is shown. */
  visible?: boolean;
  /** Initially shown when uncontrolled. */
  defaultVisible?: boolean;
  /** Called when the user shows or hides the text. */
  onVisibleChange?: (visible: boolean) => void;
  /** The toggle's accessible name; it stays the same in both states. */
  toggleLabel?: string;
  /** Extra classes for the frame, merged after the component's own so they win. */
  className?: string;
}

/**
 * A password input with a show/hide button, on InputGroup and Base UI's Input. Inside a Field it
 * takes the label, description and validity. `autoComplete` defaults to "current-password"; use
 * "new-password" when the user sets one. The ref reaches the `<input>`; className the frame.
 */
export function PasswordInput({
  size = "md",
  visible,
  defaultVisible = false,
  onVisibleChange,
  toggleLabel = "Show password",
  autoComplete = "current-password",
  disabled,
  className,
  ...props
}: PasswordInputProps) {
  const [own, setOwn] = useState(defaultVisible);
  const shown = visible ?? own;
  const toggle = () => {
    setOwn(!shown);
    onVisibleChange?.(!shown);
  };
  return (
    <InputGroup data-slot="password-input" size={size} className={cn(className)}>
      <InputGroupInput type={shown ? "text" : "password"} autoComplete={autoComplete} spellCheck={false} disabled={disabled} {...props} />
      <InputGroupButton aria-label={toggleLabel} aria-pressed={shown} disabled={disabled} onClick={toggle} className={cn(toggleClasses)}>
        {shown ? <EyeOffIcon /> : <EyeIcon />}
      </InputGroupButton>
    </InputGroup>
  );
}
