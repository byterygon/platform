import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Textarea } from "./textarea";

afterEach(cleanup);

const type = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Textarea", () => {
  test("renders a native textarea with its slot, size and three rows", () => {
    const { container } = render(<Textarea aria-label="Notes" />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.dataset.slot).toBe("textarea");
    expect(textarea.dataset.size).toBe("md");
    expect(textarea.rows).toBe(3);
    expect(container.querySelector("input")).toBeNull();
  });

  test("forwards the ref to the textarea element", () => {
    const ref = createRef<HTMLTextAreaElement>();
    render(<Textarea ref={ref} aria-label="Notes" />);
    expect(ref.current).toBeInstanceOf(HTMLTextAreaElement);
  });

  test("reports changes through onValueChange, keeps line breaks", () => {
    const onValueChange = vi.fn();
    const { container } = render(<Textarea aria-label="Notes" onValueChange={onValueChange} />);
    type(container.querySelector("textarea")!, "line 1\nline 2");
    expect(onValueChange).toHaveBeenCalledWith("line 1\nline 2", expect.anything());
  });

  test("controlled value", () => {
    const { container } = render(<Textarea aria-label="Notes" value="fixed" onValueChange={() => {}} />);
    expect(container.querySelector("textarea")!.value).toBe("fixed");
  });

  test("disabled sets the native attribute and data-disabled", () => {
    const { container } = render(<Textarea aria-label="Notes" disabled />);
    const textarea = container.querySelector("textarea")!;
    expect(textarea.disabled).toBe(true);
    expect(textarea.hasAttribute("data-disabled")).toBe(true);
  });

  test("inside a Field it takes the label, the validity and the error", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Filter</FieldLabel>
        <Textarea />
        <FieldError>Add a condition.</FieldError>
      </Field>,
    );
    const textarea = container.querySelector("textarea")!;
    expect(textarea.labels?.[0]?.textContent).toBe("Filter");
    expect(textarea.hasAttribute("data-invalid")).toBe(true);
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.getAttribute("aria-describedby")).toContain(container.querySelector('[data-slot="field-error"]')!.id);
    expect(await axeViolations(container)).toEqual([]);
  });
});
