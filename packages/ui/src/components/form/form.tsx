import { useRender } from "@base-ui/react/use-render";
import type { AnyFormApi } from "@tanstack/react-form";
import type { SubmitEvent } from "react";
import { cn } from "@/lib/cn";

// The form element for TanStack Form (`useForm`): submitting calls `form.handleSubmit()` instead
// of the browser's submission and native validation (TanStack Form validates), then moves focus
// to the first control whose field has errors, in document order, so a keyboard or screen-reader
// user lands on the problem. Base UI's own Form is not used: it validates through Base UI's
// field validity, which TanStack Form replaces (Base UI's TanStack Form guide uses a plain form).

/** Classes per variant prop. The manifest's `variants` lists the same keys; a test compares them. */
export const formVariants = {} as const;

const base = ["flex min-w-0 flex-col gap-stack-md"];

/** Focuses the first control of `element` whose TanStack field has errors. Returns it, or null. */
export function focusFirstInvalid(element: HTMLFormElement, form: AnyFormApi): HTMLElement | null {
  const fieldMeta = form.state.fieldMeta as Record<string, { errors?: readonly unknown[] } | undefined>;
  for (const control of Array.from(element.elements)) {
    const name = control.getAttribute("name");
    if (!name || !(control instanceof HTMLElement) || (fieldMeta[name]?.errors?.length ?? 0) === 0) continue;
    control.focus();
    return control;
  }
  return null;
}

export interface FormProps extends Omit<useRender.ComponentProps<"form">, "className"> {
  /**
   * The TanStack Form instance from `useForm`. Submitting calls its `handleSubmit()` and focuses
   * the first invalid control. Without it, Form is a styled `<form>` and submits as usual.
   */
  form?: AnyFormApi;
  /** Extra classes, merged after the component's own so they win. */
  className?: string;
}

/**
 * A form laid out as a column of Fields, submitted through TanStack Form. Built on Base UI's
 * useRender: `render` swaps the `<form>`, the ref reaches it.
 */
export function Form({ form, className, render, onSubmit, noValidate, ...props }: FormProps) {
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    onSubmit?.(event);
    if (!form) return;
    event.preventDefault();
    event.stopPropagation();
    const element = event.currentTarget;
    void form.handleSubmit().then(() => {
      focusFirstInvalid(element, form);
    });
  };
  return useRender({
    defaultTagName: "form",
    render,
    props: { "data-slot": "form", noValidate: noValidate ?? (form ? true : undefined), ...props, onSubmit: submit, className: cn(base, className) },
  });
}
