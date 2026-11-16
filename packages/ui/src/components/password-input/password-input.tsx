import { Input as InputPrimitive } from "@base-ui/react/input";
import { useState } from "react";
import { Icon } from "@/components/icon/icon";
import { InputGroup, InputGroupButton, InputGroupInput, inputGroupVariants } from "@/components/input-group/input-group";
import { cn } from "@/lib/cn";
import type { ControlSizeProp, FieldAppearance } from "@/lib/control";
import { Eye, EyeOff } from "@/lib/icons";

// A password field: an InputGroup with Base UI's Input (so it works inside a Field) and a button
// that shows or hides the text. The button keeps one name ("Show password") and reports its state
// with aria-pressed, so a screen reader hears "Show password, toggle button, pressed".

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const passwordInputVariants = {
  /** InputGroup applies these; listed here so the manifest and the tests see every value. */
  appearance: inputGroupVariants.appearance,
  size: inputGroupVariants.size,
} as const;

const toggleClasses = ["text-fg-muted hover:text-fg aria-pressed:text-fg"];

export interface PasswordInputProps extends Omit<InputPrimitive.Props, "className" | "size" | "type"> {
  /** Fluent's field appearance: outline (default), underline, filled-darker or filled-lighter. */
  appearance?: FieldAppearance | undefined;
  /** Fluent's size: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
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
  appearance,
  size,
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
    <InputGroup data-slot="password-input" appearance={appearance} size={size} className={cn(className)}>
      <InputGroupInput type={shown ? "text" : "password"} autoComplete={autoComplete} spellCheck={false} disabled={disabled} {...props} />
      <InputGroupButton aria-label={toggleLabel} aria-pressed={shown} disabled={disabled} onClick={toggle} className={cn(toggleClasses)}>
        <Icon icon={shown ? EyeOff : Eye} />
      </InputGroupButton>
    </InputGroup>
  );
}
