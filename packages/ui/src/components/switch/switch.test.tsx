import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Switch } from "./switch";

afterEach(cleanup);

const control = (container: HTMLElement) => container.querySelector<HTMLElement>('[role="switch"]')!;

describe("Switch", () => {
  test("a wrapping FieldLabel names it and a FieldDescription describes it", async () => {
    const { container } = render(
      <Field>
        <FieldLabel>
          <Switch />
          Auto-commit
        </FieldLabel>
        <FieldDescription>Commit every statement.</FieldDescription>
      </Field>,
    );
    const root = control(container);
    expect(root.dataset.slot).toBe("switch");
    expect(root.dataset.size).toBe("md");
    expect(root.getAttribute("aria-checked")).toBe("false");
    expect(root.querySelector('[data-slot="switch-thumb"]')).not.toBeNull();
    const description = container.querySelector('[data-slot="field-description"]')!;
    expect(root.getAttribute("aria-describedby")).toContain(description.id);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("clicking the label flips it and reports the state", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(
      <Field>
        <FieldLabel>
          <Switch onCheckedChange={onCheckedChange} />
          Auto-commit
        </FieldLabel>
      </Field>,
    );
    act(() => container.querySelector("label")!.click());
    expect(control(container).getAttribute("aria-checked")).toBe("true");
    expect(control(container).hasAttribute("data-checked")).toBe(true);
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });

  test("controlled checked follows the prop", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<Switch aria-label="Wrap" checked onCheckedChange={onCheckedChange} />);
    act(() => control(container).click());
    expect(onCheckedChange).toHaveBeenCalledWith(false, expect.anything());
    expect(control(container).getAttribute("aria-checked")).toBe("true");
  });

  test("submits its value through a hidden input", () => {
    const { container } = render(
      <form>
        <Switch name="autocommit" aria-label="Auto-commit" defaultChecked />
      </form>,
    );
    expect(new FormData(container.querySelector("form")!).get("autocommit")).toBe("on");
  });

  test("disabled ignores clicks", () => {
    const onCheckedChange = vi.fn();
    const { container } = render(<Switch aria-label="Wrap" disabled onCheckedChange={onCheckedChange} />);
    expect(control(container).hasAttribute("data-disabled")).toBe(true);
    act(() => control(container).click());
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  test("forwards the ref", () => {
    const ref = createRef<HTMLSpanElement>();
    render(<Switch ref={ref} aria-label="Wrap" />);
    expect(ref.current?.dataset.slot).toBe("switch");
  });
});
