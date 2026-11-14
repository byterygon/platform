import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { PasswordInput } from "./password-input";

afterEach(cleanup);

describe("PasswordInput", () => {
  test("is a password input inside a Field, with a named show button", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Password</FieldLabel>
        <PasswordInput />
        <FieldDescription>Stored in the keychain.</FieldDescription>
        <FieldError>Enter a password.</FieldError>
      </Field>,
    );
    const input = container.querySelector("input")!;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("current-password");
    expect(input.labels?.[0]?.textContent).toBe("Password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[data-slot="password-input"]')).not.toBeNull();
    const button = container.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Show password");
    expect(button.getAttribute("aria-pressed")).toBe("false");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("the button shows and hides the text and keeps its name", () => {
    const onVisibleChange = vi.fn();
    const { container } = render(<PasswordInput aria-label="Password" defaultValue="secret" onVisibleChange={onVisibleChange} />);
    const input = container.querySelector("input")!;
    const button = container.querySelector("button")!;
    act(() => button.click());
    expect(input.type).toBe("text");
    expect(input.value).toBe("secret");
    expect(button.getAttribute("aria-pressed")).toBe("true");
    expect(button.getAttribute("aria-label")).toBe("Show password");
    expect(onVisibleChange).toHaveBeenLastCalledWith(true);
    act(() => button.click());
    expect(input.type).toBe("password");
    expect(onVisibleChange).toHaveBeenLastCalledWith(false);
  });

  test("controlled visible follows the prop", () => {
    const onVisibleChange = vi.fn();
    const { container } = render(<PasswordInput aria-label="Password" visible={false} onVisibleChange={onVisibleChange} />);
    act(() => container.querySelector("button")!.click());
    expect(onVisibleChange).toHaveBeenCalledWith(true);
    expect(container.querySelector("input")!.type).toBe("password");
  });

  test("forwards the ref to the input and reports changes", () => {
    const ref = createRef<HTMLInputElement>();
    const onValueChange = vi.fn();
    render(<PasswordInput ref={ref} aria-label="Password" onValueChange={onValueChange} />);
    expect(ref.current).toBeInstanceOf(HTMLInputElement);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(ref.current, "hunter2");
      ref.current!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onValueChange).toHaveBeenCalledWith("hunter2", expect.anything());
  });

  test("disabled disables the input and the button", () => {
    const { container } = render(<PasswordInput aria-label="Password" disabled />);
    expect(container.querySelector("input")!.disabled).toBe(true);
    expect(container.querySelector("button")!.disabled).toBe(true);
  });
});
