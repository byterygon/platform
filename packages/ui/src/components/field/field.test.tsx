import { useForm } from "@tanstack/react-form";
import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { Input } from "@/components/input/input";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { errorMessages, Field, FieldDescription, FieldError, FieldLabel, type FieldState } from "./field";

afterEach(cleanup);

const meta = (overrides: Partial<FieldState["state"]["meta"]>): FieldState => ({
  name: "port",
  state: { meta: { isTouched: false, isDirty: false, isValid: true, errors: [], ...overrides } },
});

const type = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("Field", () => {
  test("ties the label and the description to the control", () => {
    const { container } = render(
      <Field>
        <FieldLabel>Host</FieldLabel>
        <Input />
        <FieldDescription>A name on your network.</FieldDescription>
      </Field>,
    );
    const input = container.querySelector("input")!;
    expect(input.labels?.[0]?.textContent).toBe("Host");
    const description = container.querySelector('[data-slot="field-description"]')!;
    expect(input.getAttribute("aria-describedby")).toContain(description.id);
  });

  test("forwards the ref to the root element", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Field ref={ref} />);
    expect(ref.current?.dataset.slot).toBe("field");
  });

  test("an untouched TanStack field with errors is not shown as invalid yet", () => {
    const { container } = render(
      <Field field={meta({ isValid: false, errors: ["Required"] })}>
        <FieldLabel>Port</FieldLabel>
        <Input />
        <FieldError />
      </Field>,
    );
    expect(container.querySelector("[data-invalid]")).toBeNull();
    expect(container.querySelector('[data-slot="field-error"]')).toBeNull();
  });

  test("a touched TanStack field with errors is invalid, names the control and shows the messages", async () => {
    const { container } = render(
      <Field field={meta({ isTouched: true, isDirty: true, isValid: false, errors: ["Enter a port.", { message: "Use 1 to 65535." }, "Enter a port."] })}>
        <FieldLabel>Port</FieldLabel>
        <Input />
        <FieldError />
      </Field>,
    );
    const root = container.querySelector('[data-slot="field"]')!;
    expect(root.hasAttribute("data-invalid")).toBe(true);
    expect(root.hasAttribute("data-touched")).toBe(true);
    expect(root.hasAttribute("data-dirty")).toBe(true);
    const input = container.querySelector("input")!;
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.name).toBe("port");
    const error = container.querySelector('[data-slot="field-error"]')!;
    expect([...error.querySelectorAll("span")].map((s) => s.textContent)).toEqual(["Enter a port.", "Use 1 to 65535."]);
    expect(input.getAttribute("aria-describedby")).toContain(error.id);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("explicit props win over the TanStack field", () => {
    const { container } = render(
      <Field field={meta({ isTouched: true, isValid: false, errors: ["Required"] })} invalid={false} name="other">
        <Input />
        <FieldError />
      </Field>,
    );
    expect(container.querySelector("[data-invalid]")).toBeNull();
    expect(container.querySelector("input")!.name).toBe("other");
  });

  test("FieldError shows its children or its errors prop", () => {
    const { container } = render(
      <>
        <Field invalid>
          <Input aria-label="A" />
          <FieldError>Custom message</FieldError>
        </Field>
        <Field invalid>
          <Input aria-label="B" />
          <FieldError errors={[{ message: "From the server" }]} />
        </Field>
      </>,
    );
    expect([...container.querySelectorAll('[data-slot="field-error"]')].map((e) => e.textContent)).toEqual(["Custom message", "From the server"]);
  });

  test("disabled reaches the label and the control", () => {
    const { container } = render(
      <Field disabled>
        <FieldLabel>Driver</FieldLabel>
        <Input />
      </Field>,
    );
    expect(container.querySelector('[data-slot="field-label"]')!.hasAttribute("data-disabled")).toBe(true);
    expect(container.querySelector("input")!.disabled).toBe(true);
  });

  test("works with TanStack Form: blur validation shows the error, fixing the value clears it", () => {
    function Port() {
      const form = useForm({ defaultValues: { port: "5432" } });
      return (
        <form.Field name="port" validators={{ onBlur: ({ value }) => (/^\d+$/.test(value) && Number(value) <= 65535 ? undefined : "Use a number from 1 to 65535.") }}>
          {(field) => (
            <Field field={field}>
              <FieldLabel>Port</FieldLabel>
              <Input value={field.state.value} onValueChange={field.handleChange} onBlur={field.handleBlur} />
              <FieldError />
            </Field>
          )}
        </form.Field>
      );
    }
    const { container } = render(<Port />);
    const input = container.querySelector("input")!;
    type(input, "99999");
    act(() => {
      input.focus();
      input.blur();
    });
    expect(container.querySelector('[data-slot="field-error"]')?.textContent).toBe("Use a number from 1 to 65535.");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    type(input, "6432");
    act(() => {
      input.focus();
      input.blur();
    });
    expect(container.querySelector('[data-slot="field-error"]')).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  test("errorMessages reads strings and message objects, drops blanks and duplicates", () => {
    expect(errorMessages(["a", { message: "b" }, "", null, 3, "a", { message: 1 }])).toEqual(["a", "b"]);
  });
});
