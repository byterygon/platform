import { EditorView } from "@codemirror/view";
import { createRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { CodeInput, prettyCode } from "./code-input";

afterEach(cleanup);

const parts = (container: HTMLElement) => {
  const root = container.querySelector<HTMLElement>("[data-slot=code-input]")!;
  const content = root.querySelector<HTMLElement>(".cm-content")!;
  const control = root.querySelector<HTMLInputElement>("[data-slot=code-input-control]")!;
  const view = EditorView.findFromDOM(root.querySelector<HTMLElement>(".cm-editor")!)!;
  return { root, content, control, view };
};
const insert = (view: EditorView, text: string) =>
  act(() => {
    view.dispatch(view.state.update({ changes: { from: view.state.doc.length, insert: text }, userEvent: "input.type" }));
  });
const press = (element: HTMLElement, key: string) =>
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });

describe("prettyCode", () => {
  test("pretty-prints JSON and leaves anything else alone", () => {
    expect(prettyCode('{"a":1,"b":[true,null]}', "json")).toBe('{\n  "a": 1,\n  "b": [\n    true,\n    null\n  ]\n}');
    expect(prettyCode("{not json", "json")).toBe("{not json");
    expect(prettyCode("select 1", "sql")).toBe("select 1");
  });
});

describe("CodeInput", () => {
  test("renders CodeMirror's text area, named, with the value in the hidden form control", () => {
    const { container } = render(<CodeInput aria-label="Filter" name="filter" defaultValue="id = 1" />);
    const { root, content, control, view } = parts(container);
    expect(root.dataset.size).toBe("md");
    expect(content.getAttribute("role")).toBe("textbox");
    expect(content.getAttribute("aria-label")).toBe("Filter");
    expect(content.getAttribute("aria-multiline")).toBe("false");
    expect(view.state.doc.toString()).toBe("id = 1");
    expect([control.name, control.value, control.tabIndex, control.getAttribute("aria-hidden")]).toEqual(["filter", "id = 1", -1, "true"]);
  });

  test("reports edits through onValueChange and keeps the form control in step", () => {
    const onValueChange = vi.fn();
    const { container } = render(<CodeInput aria-label="Filter" onValueChange={onValueChange} />);
    const { view, control } = parts(container);
    insert(view, "status = 'new'");
    expect(onValueChange).toHaveBeenLastCalledWith("status = 'new'");
    expect(control.value).toBe("status = 'new'");
  });

  test("one line: line breaks become spaces and Enter submits without changing the text", () => {
    const onSubmit = vi.fn();
    const { container } = render(<CodeInput aria-label="Filter" onSubmit={onSubmit} />);
    const { view, content } = parts(container);
    insert(view, "a = 1\nand b = 2");
    expect(view.state.doc.toString()).toBe("a = 1 and b = 2");
    press(content, "Enter");
    expect(onSubmit).toHaveBeenCalledWith("a = 1 and b = 2");
    expect(view.state.doc.lines).toBe(1);
  });

  test("multiline: Enter inserts a line break, aria-multiline and data-multiline are set", () => {
    const onSubmit = vi.fn();
    const { container } = render(<CodeInput aria-label="JSON" multiline language="json" defaultValue="{}" onSubmit={onSubmit} />);
    const { root, view, content } = parts(container);
    act(() => view.dispatch({ selection: { anchor: 1 } }));
    press(content, "Enter");
    expect(view.state.doc.lines).toBeGreaterThan(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(content.getAttribute("aria-multiline")).toBe("true");
    expect(root.hasAttribute("data-multiline")).toBe(true);
  });

  test("pretty: read-only, multi-line, JSON pretty-printed", () => {
    const { container } = render(<CodeInput aria-label="Cell value" language="json" pretty value='{"id":42,"tags":["a"]}' />);
    const { root, view, content } = parts(container);
    expect(view.state.doc.toString()).toBe('{\n  "id": 42,\n  "tags": [\n    "a"\n  ]\n}');
    expect(view.state.readOnly).toBe(true);
    expect(content.getAttribute("aria-readonly")).toBe("true");
    expect(root.hasAttribute("data-readonly")).toBe(true);
    expect(root.hasAttribute("data-multiline")).toBe(true);
  });

  test("a controlled value replaces the text without echoing onValueChange", async () => {
    const onValueChange = vi.fn();
    let set: (v: string) => void = () => {};
    function Controlled() {
      const [value, setValue] = useState("a = 1");
      set = setValue;
      return <CodeInput aria-label="Filter" value={value} onValueChange={onValueChange} />;
    }
    const { container } = render(<Controlled />);
    await act(async () => set("b = 2"));
    expect(parts(container).view.state.doc.toString()).toBe("b = 2");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test("standalone aria-invalid marks the frame and the text area", () => {
    const { container } = render(<CodeInput aria-label="Filter" aria-invalid />);
    const { root, content } = parts(container);
    expect(root.hasAttribute("data-invalid")).toBe(true);
    expect(content.getAttribute("aria-invalid")).toBe("true");
  });

  test("disabled: not editable, aria-disabled, data-disabled, control disabled", () => {
    const { container } = render(<CodeInput aria-label="Filter" disabled defaultValue="x" />);
    const { root, content, control } = parts(container);
    expect(content.getAttribute("contenteditable")).toBe("false");
    expect(content.getAttribute("aria-disabled")).toBe("true");
    expect(root.hasAttribute("data-disabled")).toBe(true);
    expect(control.disabled).toBe(true);
  });

  test("inside a Field it takes the label, the description, the error and the validity", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>Settings</FieldLabel>
        <CodeInput language="json" required />
        <FieldDescription>JSON object.</FieldDescription>
        <FieldError match>Not valid JSON.</FieldError>
      </Field>,
    );
    await act(async () => {});
    const { root, content } = parts(container);
    const label = container.querySelector("label")!;
    expect(content.getAttribute("aria-labelledby")).toBe(label.id);
    expect(content.hasAttribute("aria-label")).toBe(false);
    const described = content.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(expect.arrayContaining(["JSON object.", "Not valid JSON."]));
    expect(content.getAttribute("aria-invalid")).toBe("true");
    expect(content.getAttribute("aria-required")).toBe("true");
    expect(root.hasAttribute("data-invalid")).toBe(true);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("forwards the ref to the root and takes className", () => {
    const ref = createRef<HTMLDivElement>();
    render(<CodeInput ref={ref} aria-label="Filter" size="lg" className="max-w-panel-sm" />);
    expect(ref.current?.dataset.slot).toBe("code-input");
    expect(ref.current?.className).toContain("h-control-lg");
    expect(ref.current?.className).toContain("max-w-panel-sm");
  });
});
