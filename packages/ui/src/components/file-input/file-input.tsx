import { Input as InputPrimitive } from "@base-ui/react/input";
import { useRef, useState, type DragEvent, type MouseEvent, type Ref } from "react";
import { Button } from "@/components/button/button";
import { Icon } from "@/components/icon/icon";
import { cn } from "@/lib/cn";
import { controlSize, fieldAppearance, fieldAppearances, fieldFrame, fieldSizes, type ControlSizeProp, type FieldAppearance } from "@/lib/control";
import { Dismiss } from "@/lib/icons";

// Base UI has no file input, so this is a native <input type="file"> rendered by Base UI's Input
// (Field.Control: it takes a Field's label, description and validity) inside a styled frame. The
// input stays in the page, visually hidden but focusable: Tab, Space and the FieldLabel open the
// system picker, and screen readers announce the input and the chosen file as usual. The frame's
// look (a "Choose file" chip and the file names) is aria-hidden. Files never leave the browser.
// The frame takes Input's Fluent appearances, sizes, focus underline and states.

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const fileInputVariants = {
  variant: {
    /** One line, the height of an Input: a chip and the file names. */
    field: "ps-inline-xs pe-inline-xs",
    /** A larger dashed area that also takes files dropped on it. */
    dropzone: "h-auto flex-col justify-center gap-stack-sm border-dashed p-inset-lg text-center",
  },
  appearance: fieldAppearances,
  size: {
    small: `${fieldSizes.small} [&_[data-slot=file-input-chip]]:h-control-xs`,
    medium: `${fieldSizes.medium} [&_[data-slot=file-input-chip]]:h-control-sm`,
    large: `${fieldSizes.large} [&_[data-slot=file-input-chip]]:h-control-md`,
  },
} as const;

// Written out in full (no template strings): Tailwind finds classes by scanning the source as text.
const base = [
  "relative flex w-full min-w-0 cursor-pointer items-center gap-inline-sm",
  fieldFrame,
  // Only the dropzone sets data-dragging.
  "data-dragging:border-accent-solid data-dragging:bg-accent-subtle",
  "has-[[data-slot=file-input-input]:focus-visible]:shadow-focus-underline",
  "has-[[data-slot=file-input-input][aria-invalid=true]]:border-danger-border has-[[data-slot=file-input-input][aria-invalid=true]]:border-b-danger",
  "has-[[data-slot=file-input-input][data-invalid]]:border-danger-border has-[[data-slot=file-input-input][data-invalid]]:border-b-danger",
  "has-[[data-slot=file-input-input][data-disabled]]:cursor-not-allowed has-[[data-slot=file-input-input][data-disabled]]:border-border-disabled",
  "has-[[data-slot=file-input-input][data-disabled]]:bg-transparent has-[[data-slot=file-input-input][data-disabled]]:text-fg-disabled",
];

// The "Choose file" chip looks like a small secondary Button (decoration: the input is the control).
const chipClasses = [
  "inline-flex shrink-0 items-center rounded-sm border border-border-subtle border-b-border-control-bottom-subtle bg-layer px-inset-xs text-caption-1 text-fg",
];

const namesClasses = ["min-w-0 flex-1 truncate text-start", "data-empty:text-fg-subtle"];

const clearClasses = ["h-control-xs px-inset-xs text-fg-muted hover:text-fg"];

/** Whether a file matches an `accept` list: extensions (".pem"), MIME types and wildcards ("image/*"). */
export function acceptsFile(accept: string | undefined, file: File): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  const type = file.type.toLowerCase();
  return accept.split(",").some((raw) => {
    const rule = raw.trim().toLowerCase();
    if (!rule) return false;
    if (rule.startsWith(".")) return name.endsWith(rule);
    if (rule.endsWith("/*")) return type.startsWith(rule.slice(0, -1));
    return type === rule;
  });
}

export interface FileInputProps extends Omit<InputPrimitive.Props, "className" | "size" | "type" | "value" | "defaultValue" | "onValueChange" | "children"> {
  /** One line like an Input, or a dashed area that also takes dropped files. */
  variant?: keyof typeof fileInputVariants.variant | undefined;
  /** Fluent's field appearance of the frame: outline (default), underline, filled-darker or filled-lighter. */
  appearance?: FieldAppearance | undefined;
  /** Height of the field variant: small, medium or large (`sm`, `md`, `lg` are deprecated aliases). */
  size?: ControlSizeProp | undefined;
  /** Called with the chosen (or dropped) files; [] when cleared. */
  onFilesChange?: (files: File[]) => void;
  /** The chip's text. */
  chooseLabel?: string;
  /** Shown while no file is chosen. */
  emptyLabel?: string;
  /** The dropzone's instruction. */
  dropLabel?: string;
  /** The Clear button's accessible name. */
  clearLabel?: string;
  /** Extra classes for the frame, merged after the component's own so they win. */
  className?: string;
}

/**
 * A file picker on a native `<input type="file">` (Base UI's Input), with a dropzone variant.
 * `accept` and `multiple` work as on the native input and also filter dropped files. Read the
 * files from `onFilesChange`; they also submit with the form. The ref reaches the `<input>`;
 * className the frame.
 */
export function FileInput({
  variant = "field",
  appearance,
  size,
  onFilesChange,
  onChange,
  chooseLabel = "Choose file",
  emptyLabel = "No file chosen",
  dropLabel = "Drop a file here, or",
  clearLabel = "Clear file",
  accept,
  multiple,
  disabled,
  ref,
  className,
  ...props
}: FileInputProps) {
  const input = useRef<HTMLInputElement | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);

  const update = (next: File[]) => {
    setFiles(next);
    onFilesChange?.(next);
  };
  const changed = (event: Parameters<NonNullable<InputPrimitive.Props["onChange"]>>[0]) => {
    onChange?.(event);
    update(Array.from(event.currentTarget.files ?? []));
  };
  const open = (event: MouseEvent<HTMLDivElement>) => {
    if (disabled || (event.target as Element).closest("button, input, label")) return;
    input.current?.click();
  };
  const clear = () => {
    if (input.current) input.current.value = "";
    update([]);
    input.current?.focus();
  };
  const dragOver = (event: DragEvent<HTMLDivElement>) => {
    if (variant !== "dropzone" || disabled) return;
    event.preventDefault();
    setDragging(true);
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    if (variant !== "dropzone" || disabled) return;
    event.preventDefault();
    setDragging(false);
    const dropped = Array.from(event.dataTransfer?.files ?? []).filter((file) => acceptsFile(accept, file));
    const next = multiple ? dropped : dropped.slice(0, 1);
    if (next.length === 0) return;
    // Hand the files to the input too, so they submit with the form (where the browser allows it).
    try {
      if (input.current && typeof DataTransfer !== "undefined") {
        const transfer = new DataTransfer();
        for (const file of next) transfer.items.add(file);
        input.current.files = transfer.files;
      }
    } catch {
      // Some engines refuse to set files; onFilesChange still has them.
    }
    update(next);
  };
  const setRef = (element: HTMLInputElement | null) => {
    input.current = element;
    if (typeof ref === "function") ref(element);
    else if (ref) (ref as { current: HTMLInputElement | null }).current = element;
  };

  const names = files.map((file) => file.name).join(", ");
  const look = fieldAppearance(appearance);
  const height = controlSize(size);
  return (
    <div
      data-slot="file-input"
      data-variant={variant}
      data-appearance={look}
      data-size={height}
      data-dragging={dragging ? "" : undefined}
      className={cn(base, fileInputVariants.appearance[look], fileInputVariants.size[height], fileInputVariants.variant[variant], className)}
      onClick={open}
      onDragOver={dragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={drop}
    >
      <InputPrimitive
        ref={setRef as Ref<HTMLInputElement>}
        data-slot="file-input-input"
        type="file"
        accept={accept}
        multiple={multiple}
        disabled={disabled}
        onChange={changed}
        className="sr-only"
        {...props}
      />
      {variant === "dropzone" ? (
        <span aria-hidden="true" className="text-fg-muted">
          {dropLabel}
        </span>
      ) : null}
      <span aria-hidden="true" data-slot="file-input-chip" className={cn(chipClasses)}>
        {chooseLabel}
      </span>
      <span aria-hidden="true" data-slot="file-input-names" data-empty={files.length === 0 ? "" : undefined} className={cn(namesClasses)}>
        {files.length === 0 ? emptyLabel : names}
      </span>
      <Button appearance="subtle" size="small" aria-label={clearLabel} hidden={files.length === 0 || disabled} onClick={clear} className={cn(clearClasses)}>
        <Icon icon={Dismiss} />
      </Button>
    </div>
  );
}
