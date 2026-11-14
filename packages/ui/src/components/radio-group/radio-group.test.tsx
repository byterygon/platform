import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldItem, FieldLabel, FieldLegend } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { RadioGroup, RadioGroupItem } from "./radio-group";

afterEach(cleanup);

const radios = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
const checked = (container: HTMLElement) => radios(container).map((r) => r.getAttribute("aria-checked"));

function Storage(props: Partial<Parameters<typeof RadioGroup>[0]> & { invalid?: boolean }) {
  const { invalid, ...group } = props;
  return (
    <form>
      <Field name="storage" invalid={invalid}>
        <RadioGroup defaultValue="ssd" {...group}>
          <FieldLegend>Storage</FieldLegend>
          {["ssd", "hdd", "nvme"].map((value) => (
            <FieldItem key={value}>
              <FieldLabel>
                <RadioGroupItem value={value} />
                {value.toUpperCase()}
              </FieldLabel>
            </FieldItem>
          ))}
        </RadioGroup>
        <FieldError>Choose a storage type.</FieldError>
      </Field>
    </form>
  );
}

describe("RadioGroup", () => {
  test("is a radiogroup named by its legend, with one radio checked", async () => {
    const { container } = render(<Storage />);
    const group = container.querySelector<HTMLElement>('[data-slot="radio-group"]')!;
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.dataset.size).toBe("md");
    const legend = container.querySelector('[data-slot="field-legend"]')!;
    expect(group.getAttribute("aria-labelledby")).toBe(legend.id);
    expect(checked(container)).toEqual(["true", "false", "false"]);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("clicking a label chooses its radio and reports the value", () => {
    const onValueChange = vi.fn();
    const { container } = render(<Storage onValueChange={onValueChange} />);
    act(() => container.querySelectorAll("label")[1]!.click());
    expect(checked(container)).toEqual(["false", "true", "false"]);
    expect(onValueChange).toHaveBeenCalledWith("hdd", expect.anything());
  });

  test("arrow keys move the choice", async () => {
    const { container } = render(<Storage />);
    const [ssd] = radios(container);
    act(() => ssd!.focus());
    act(() => {
      ssd!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await act(async () => {});
    expect(checked(container)).toEqual(["false", "true", "false"]);
    expect(document.activeElement).toBe(radios(container)[1]);
  });

  test("submits the chosen value under the field's name", () => {
    const { container } = render(<Storage defaultValue="nvme" />);
    const data = new FormData(container.querySelector("form")!);
    expect(data.get("storage")).toBe("nvme");
  });

  test("an invalid Field marks the radios invalid and shows the error", () => {
    const { container } = render(<Storage invalid />);
    for (const radio of radios(container)) expect(radio.hasAttribute("data-invalid")).toBe(true);
    expect(container.querySelector('[data-slot="field-error"]')?.textContent).toBe("Choose a storage type.");
  });

  test("disabled disables every radio", () => {
    const { container } = render(<Storage disabled />);
    for (const radio of radios(container)) expect(radio.hasAttribute("data-disabled")).toBe(true);
  });

  test("forwards the ref to the group", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Storage ref={ref} />);
    expect(ref.current?.dataset.slot).toBe("radio-group");
  });
});
