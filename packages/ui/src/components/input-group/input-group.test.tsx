import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./input-group";

afterEach(cleanup);

describe("InputGroup", () => {
  test("renders the frame, the control, an addon and a button", async () => {
    const { container } = render(
      <InputGroup>
        <InputGroupAddon>postgres://</InputGroupAddon>
        <InputGroupInput aria-label="Server" />
        <InputGroupButton>Test</InputGroupButton>
      </InputGroup>,
    );
    const root = container.querySelector('[data-slot="input-group"]')!;
    expect((root as HTMLElement).dataset.size).toBe("medium");
    expect((root as HTMLElement).dataset.appearance).toBe("outline");
    expect(root.querySelector("input")!.dataset.slot).toBe("input-group-input");
    const button = root.querySelector("button")!;
    expect(button.dataset.slot).toBe("input-group-button");
    expect(button.dataset.appearance).toBe("subtle");
    expect(button.dataset.size).toBe("small");
    expect(button.type).toBe("button");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("keeps sm/md/lg as aliases for one release, and takes Fluent's field appearances", () => {
    for (const [size, fluent] of [["sm", "small"], ["md", "medium"], ["lg", "large"]] as const) {
      const { container, unmount } = render(
        <InputGroup size={size} appearance="underline">
          <InputGroupInput aria-label="Host" />
        </InputGroup>,
      );
      const root = container.querySelector('[data-slot="input-group"]') as HTMLElement;
      expect(root.dataset.size).toBe(fluent);
      expect(root.dataset.appearance).toBe("underline");
      unmount();
    }
  });

  test("the button is one size smaller than the group", () => {
    const sizes = (["small", "medium", "large"] as const).map((size) => {
      const { container, unmount } = render(
        <InputGroup size={size}>
          <InputGroupInput aria-label="Value" />
          <InputGroupButton>Go</InputGroupButton>
        </InputGroup>,
      );
      const button = container.querySelector("button")!;
      const result = [button.dataset.size, button.className.includes("h-control-xs")];
      unmount();
      return result;
    });
    expect(sizes).toEqual([
      ["small", true],
      ["small", false],
      ["medium", false],
    ]);
  });

  test("clicking an addon focuses the control; clicking the button does not", () => {
    const onClick = vi.fn();
    const { container } = render(
      <InputGroup>
        <InputGroupAddon>ms</InputGroupAddon>
        <InputGroupInput aria-label="Timeout" />
        <InputGroupButton onClick={onClick}>Reset</InputGroupButton>
      </InputGroup>,
    );
    const input = container.querySelector("input")!;
    const addon = container.querySelector('[data-slot="input-group-addon"]')!;
    act(() => {
      addon.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(input);
    const button = container.querySelector("button")!;
    act(() => {
      button.focus();
      button.click();
    });
    expect(document.activeElement).toBe(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  test("forwards refs to the frame and to the input", () => {
    const frame = createRef<HTMLDivElement>();
    const input = createRef<HTMLInputElement>();
    render(
      <InputGroup ref={frame}>
        <InputGroupInput ref={input} aria-label="Value" />
      </InputGroup>,
    );
    expect(frame.current?.dataset.slot).toBe("input-group");
    expect(input.current).toBeInstanceOf(HTMLInputElement);
  });

  test("inside a Field the control takes the label and the validity, which the frame shows", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Timeout</FieldLabel>
        <InputGroup>
          <InputGroupInput />
          <InputGroupAddon>ms</InputGroupAddon>
        </InputGroup>
        <FieldError>Use a positive number.</FieldError>
      </Field>,
    );
    const input = container.querySelector("input")!;
    expect(input.labels?.[0]?.textContent).toBe("Timeout");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(container.querySelector('[data-slot="input-group"]')!.matches(":has([data-slot=input-group-input][data-invalid])")).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("a disabled Field disables the control", () => {
    const { container } = render(
      <Field disabled>
        <FieldLabel>Path</FieldLabel>
        <InputGroup>
          <InputGroupInput />
        </InputGroup>
      </Field>,
    );
    const input = container.querySelector("input")!;
    expect(input.disabled).toBe(true);
    expect(input.hasAttribute("data-disabled")).toBe(true);
  });
});
