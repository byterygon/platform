import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fake } from "../../../test/fakes/monaco.ts";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { CodeEditor, type CodeDiagnostic } from "./code-editor";

afterEach(cleanup);
beforeEach(() => fake.reset());

const settle = () => act(async () => {});
const type = (textarea: HTMLTextAreaElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
};
const ctrlEnter = (target: Element) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true, cancelable: true }));
  });

describe("CodeEditor", () => {
  test("a textarea stands in until Monaco loads, then Monaco holds the text", async () => {
    const { container } = render(<CodeEditor defaultValue='{"a":1}' />);
    const root = container.querySelector('[data-slot="code-editor"]') as HTMLElement;
    expect(root.dataset.language).toBe("json");
    const fallback = container.querySelector('[data-slot="code-editor-fallback"]') as HTMLTextAreaElement;
    expect(fallback.getAttribute("aria-label")).toBe("JSON editor");
    await settle();
    expect(fake.editors).toHaveLength(1);
    expect(fake.editors[0]!.model.getValue()).toBe('{"a":1}');
    expect(fake.editors[0]!.model.language).toBe("json");
    expect(fallback.hidden).toBe(true);
    expect(root.hasAttribute("data-loading")).toBe(false);
  });

  test("controlled: typing reports, a new value replaces the text", async () => {
    let latest = "";
    function Harness() {
      const [v, setV] = useState("{}");
      latest = v;
      return (
        <>
          <CodeEditor value={v} onValueChange={setV} />
          <button onClick={() => setV('{"b":2}')}>reset</button>
        </>
      );
    }
    const { container } = render(<Harness />);
    await settle();
    const textarea = fake.editors[0]!.textarea;
    type(textarea, '{"a":1}');
    expect(latest).toBe('{"a":1}');
    await act(async () => container.querySelector("button")!.click());
    expect(fake.editors[0]!.model.getValue()).toBe('{"b":2}');
  });

  test("Mod+Enter submits the text, before and after Monaco", async () => {
    const onSubmit = vi.fn();
    const { container } = render(<CodeEditor defaultValue="x" onSubmit={onSubmit} language="plaintext" />);
    await ctrlEnter(container.querySelector("textarea")!);
    expect(onSubmit).toHaveBeenLastCalledWith("x");
    await settle();
    await ctrlEnter(fake.editors[0]!.textarea);
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  test("the JSON Schema goes to the language service for this model only, and is removed on unmount", async () => {
    const schema = { type: "object", required: ["id"] };
    const { unmount } = render(<CodeEditor jsonSchema={schema} />);
    await settle();
    const schemas = fake.jsonOptions!.schemas as { fileMatch: string[]; schema: unknown }[];
    expect(fake.jsonOptions!.enableSchemaRequest).toBe(false);
    expect(schemas).toHaveLength(1);
    expect(schemas[0]!.schema).toEqual(schema);
    expect(schemas[0]!.fileMatch[0]).toBe(fake.editors[0]!.model.uri.toString());
    unmount();
    expect(fake.jsonOptions!.schemas).toEqual([]);
  });

  test("markers by line and column; the language service's problems are reported", async () => {
    const onDiagnosticsChange = vi.fn<(d: CodeDiagnostic[]) => void>();
    render(<CodeEditor defaultValue={'{\n "a": }'} markers={[{ line: 2, column: 7, message: "bad value" }]} onDiagnosticsChange={onDiagnosticsChange} />);
    await settle();
    expect(fake.markers).toEqual([{ startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 8, message: "bad value", severity: 8 }]);
    await act(async () => fake.report([{ owner: "json", startLineNumber: 2, startColumn: 7, message: "Value expected", severity: 8 }, { owner: "byterygon", startLineNumber: 2, startColumn: 7, message: "bad value", severity: 8 }]));
    expect(onDiagnosticsChange).toHaveBeenLastCalledWith([{ line: 2, column: 7, message: "Value expected", severity: "error" }]);
  });

  test("diff: an original on the left, the text editable on the right", async () => {
    render(<CodeEditor language="yaml" diff={{ original: "a: 1\n" }} defaultValue={"a: 2\n"} />);
    await settle();
    expect(fake.diffEditors).toHaveLength(1);
    const d = fake.diffEditors[0]!;
    expect(d.models!.original.getValue()).toBe("a: 1\n");
    expect(d.models!.modified.getValue()).toBe("a: 2\n");
    expect(d.options.originalEditable).toBe(false);
    expect(d.models!.modified.language).toBe("yaml");
  });

  test("protobuf uses Monaco's proto grammar; readOnly and labels follow the props", async () => {
    const { container } = render(<CodeEditor language="protobuf" readOnly aria-label="order.proto" />);
    await settle();
    expect(fake.editors[0]!.model.language).toBe("proto");
    expect(fake.editors[0]!.options.readOnly).toBe(true);
    expect(fake.editors[0]!.textarea.getAttribute("aria-label")).toBe("order.proto");
    expect(container.querySelector("[data-readonly]")).not.toBeNull();
  });

  test("forwards the ref; no axe violations", async () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(<CodeEditor ref={ref} aria-label="Value" defaultValue="{}" />);
    expect(ref.current?.dataset.slot).toBe("code-editor");
    expect(await axeViolations(container)).toEqual([]);
  });
});
