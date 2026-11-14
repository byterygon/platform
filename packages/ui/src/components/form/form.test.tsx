import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Form } from "./form";
import { FormRealistic } from "./form.example";

afterEach(cleanup);

const type = (element: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const settle = () => act(async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
});

const submit = async (form: HTMLFormElement) => {
  await act(async () => {
    form.requestSubmit();
  });
  await settle();
};

const byLabel = (container: HTMLElement, label: string) => {
  const found = [...container.querySelectorAll("label")].find((l) => l.textContent === label);
  return (found?.control ?? null) as HTMLInputElement | null;
};

const errors = (container: HTMLElement) => [...container.querySelectorAll('[data-slot="field-error"]')].map((e) => e.textContent);

describe("Form", () => {
  test("renders a <form> with its slot; without a TanStack form it submits natively", () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    const ref = createRef<HTMLFormElement>();
    const { container } = render(
      <Form ref={ref} aria-label="Search" onSubmit={onSubmit}>
        <button type="submit">Go</button>
      </Form>,
    );
    const form = container.querySelector("form")!;
    expect(ref.current).toBe(form);
    expect(form.dataset.slot).toBe("form");
    expect(form.noValidate).toBe(false);
    act(() => form.requestSubmit());
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  test("with a TanStack form: noValidate, every error on submit, focus on the first invalid field", async () => {
    const { container } = render(<FormRealistic />);
    const form = container.querySelector("form")!;
    expect(form.noValidate).toBe(true);
    expect(errors(container)).toEqual([]);
    await submit(form);
    expect(errors(container)).toEqual(["Give the connection a name.", "Enter the server's host name or address.", "Enter the database to open.", "Enter the user to sign in as."]);
    const name = byLabel(container, "Name")!;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(name);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("after the first submit, errors follow every change; a valid form saves", async () => {
    const { container } = render(<FormRealistic />);
    const form = container.querySelector("form")!;
    await submit(form);
    type(byLabel(container, "Name")!, "Analytics");
    type(byLabel(container, "Host")!, "db internal");
    await settle();
    expect(errors(container)).toEqual(["A host name has no spaces.", "Enter the database to open.", "Enter the user to sign in as."]);
    type(byLabel(container, "Port")!, "70000");
    await settle();
    expect(errors(container)).toContain("Use a port from 1 to 65535.");
    await submit(form);
    expect(document.activeElement).toBe(byLabel(container, "Host"));
    type(byLabel(container, "Host")!, "db.internal");
    type(byLabel(container, "Port")!, "5432");
    type(byLabel(container, "Database")!, "analytics");
    type(byLabel(container, "User")!, "reader");
    await settle();
    expect(errors(container)).toEqual([]);
    await submit(form);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(container.querySelector('[role="status"]')!.textContent).toBe("Saved Analytics.");
  });

  test("the submit button shows loading while TanStack Form submits", async () => {
    const { container } = render(<FormRealistic />);
    for (const [label, value] of [["Name", "A"], ["Host", "h"], ["Database", "d"], ["User", "u"]] as const) type(byLabel(container, label)!, value);
    const form = container.querySelector("form")!;
    await submit(form);
    const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "Save connection")!;
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });
    expect(button.hasAttribute("aria-busy")).toBe(false);
  });
});
