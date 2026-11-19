import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fake, suggest } from "../../../test/fakes/monaco.ts";
import { registerCodeLanguage } from "@/lib/monaco";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { CodeEditor, type CodeCompletion, type CodeDiagnostic } from "./code-editor";

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

  test("the floating widgets live in a node of their own on the popover layer, gone with the editor", async () => {
    const { container, unmount } = render(<CodeEditor defaultValue="{}" />);
    await settle();
    const node = fake.editors[0]!.options["overflowWidgetsDomNode"] as HTMLElement;
    const layer = node.parentElement!;
    expect(layer.parentElement).toBe(document.body);
    expect(node.classList.contains("monaco-editor")).toBe(true);
    expect(layer.style.zIndex).toBe("var(--by-z-popover)");
    expect(layer.getAttribute("data-theme")).toBe(container.closest("[data-theme]")?.getAttribute("data-theme"));
    unmount();
    expect(node.isConnected).toBe(false);
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

  describe("singleLine (TSK-93)", () => {
    const enter = (target: Element) =>
      act(async () => {
        target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      });

    test("one line in the field's frame: no gutter or scrollbars, the input's size", async () => {
      const { container } = render(<CodeEditor singleLine size="small" language="jq" aria-label="jq" defaultValue=".value" />);
      const root = container.querySelector('[data-slot="code-editor"]') as HTMLElement;
      expect(root.hasAttribute("data-single-line")).toBe(true);
      expect(root.dataset.size).toBe("small");
      expect(root.className).toContain("h-control-sm");
      expect(root.className).not.toContain("h-panel-xs");
      await settle();
      const options = fake.editors[0]!.options;
      expect(options.lineNumbers).toBe("off");
      expect(options.folding).toBe(false);
      expect(options.scrollbar).toMatchObject({ vertical: "hidden", horizontal: "hidden" });
      expect(options.renderLineHighlight).toBe("none");
    });

    test("Enter submits, unless the suggestions are open; Mod+Enter too", async () => {
      const onSubmit = vi.fn();
      const { container } = render(<CodeEditor singleLine aria-label="Query" defaultValue="a" onSubmit={onSubmit} />);
      const fallback = container.querySelector('[data-slot="code-editor-fallback"]') as HTMLTextAreaElement;
      await enter(fallback);
      expect(onSubmit).toHaveBeenLastCalledWith("a");
      await settle();
      const editor = fake.editors[0]!;
      await enter(editor.textarea);
      expect(onSubmit).toHaveBeenCalledTimes(2);
      editor.suggestVisible = true;
      await enter(editor.textarea);
      expect(onSubmit).toHaveBeenCalledTimes(2);
      await ctrlEnter(editor.textarea);
      expect(onSubmit).toHaveBeenCalledTimes(3);
    });

    test("line breaks, typed, pasted or given, become spaces", async () => {
      const onValueChange = vi.fn();
      function Harness() {
        const [v, setV] = useState("a\nb");
        return (
          <>
            <CodeEditor
              singleLine
              aria-label="Query"
              value={v}
              onValueChange={(next) => {
                onValueChange(next);
                setV(next);
              }}
            />
            <button onClick={() => setV("x\r\ny")}>set</button>
          </>
        );
      }
      const { container } = render(<Harness />);
      await settle();
      const editor = fake.editors[0]!;
      expect(editor.model.getValue()).toBe("a b");
      type(editor.textarea, "c\nd");
      await settle();
      expect(editor.model.getValue()).toBe("c d");
      expect(onValueChange).toHaveBeenLastCalledWith("c d");
      expect(onValueChange).not.toHaveBeenCalledWith("c\nd");
      await act(async () => container.querySelector("button")!.click());
      expect(editor.model.getValue()).toBe("x y");
    });

    test("invalid marks the frame", () => {
      const { container } = render(<CodeEditor singleLine invalid aria-label="Query" />);
      expect(container.querySelector('[data-slot="code-editor"]')!.hasAttribute("data-invalid")).toBe(true);
      expect(container.querySelector('[data-slot="code-editor-fallback"]')!.getAttribute("aria-invalid")).toBe("true");
    });
  });

  describe("completion (TSK-93)", () => {
    const completion: CodeCompletion = {
      triggerCharacters: [".", " "],
      provide: ({ text, word, offset }) => [
        { label: "WorkflowType", kind: "field", detail: "Keyword" },
        { label: "AND", kind: "keyword" },
        { label: '"Order"', kind: "value", replace: { start: word.start, end: offset } },
        { label: "recent", kind: "history", insertText: text.toUpperCase(), snippet: true, sortText: "z" },
      ],
    };

    test("the app's items, by kind, at the word or the range it names", async () => {
      render(<CodeEditor singleLine language="plaintext" aria-label="Query" defaultValue="Work" completion={completion} />);
      await settle();
      const editor = fake.editors[0]!;
      editor.cursorAt(4);
      const items = await suggest(editor);
      expect(items).toHaveLength(4);
      expect(items[0]).toMatchObject({ label: { label: "WorkflowType", description: "Keyword" }, kind: 3, insertText: "WorkflowType", detail: "Keyword", range: { startColumn: 1, endColumn: 5 } });
      expect(items[1]).toMatchObject({ label: "AND", kind: 17 });
      expect(items[2]).toMatchObject({ kind: 13, range: { startLineNumber: 1, startColumn: 1, endColumn: 5 } });
      expect(items[3]).toMatchObject({ kind: 21, insertText: "WORK", insertTextRules: 4, sortText: "z" });
      expect(fake.providers[0]!.provider.triggerCharacters).toEqual([".", " "]);
    });

    test("each editor answers for its own model only, and stops when unmounted", async () => {
      const other: CodeCompletion = { provide: () => [{ label: "other" }] };
      const { unmount } = render(
        <>
          <CodeEditor language="plaintext" aria-label="A" completion={completion} />
          <CodeEditor language="plaintext" aria-label="B" completion={other} />
        </>,
      );
      await settle();
      const items = await suggest(fake.editors[1]!);
      expect(items.map((i) => i.label)).toEqual(["other"]);
      unmount();
      expect(fake.providers.every((p) => p.disposed)).toBe(true);
    });
  });

  describe("languages (TSK-93)", () => {
    test("jq has a Monarch grammar with its builtins and comments", async () => {
      render(<CodeEditor language="jq" aria-label="jq" defaultValue=".value | length" />);
      await settle();
      expect(fake.editors[0]!.model.language).toBe("jq");
      const jq = fake.languages.get("jq") as { tokens: { builtins: string[] }; configuration: { comments: unknown } };
      expect(jq.tokens.builtins).toContain("select");
      expect(jq.configuration.comments).toEqual({ lineComment: "#" });
    });

    test("an app's language is set up once, before its first editor", async () => {
      const setup = vi.fn();
      registerCodeLanguage("test-query", setup);
      registerCodeLanguage("test-query", () => {
        throw new Error("the first setup stays");
      });
      render(
        <>
          <CodeEditor language="test-query" aria-label="One" />
          <CodeEditor language="test-query" aria-label="Two" />
        </>,
      );
      await settle();
      expect(setup).toHaveBeenCalledTimes(1);
      expect(fake.languages.has("test-query")).toBe(true);
      expect(fake.editors.map((e) => e.model.language)).toEqual(["test-query", "test-query"]);
      expect(fake.editors[0]!.textarea.getAttribute("aria-label")).toBe("One");
    });
  });
});
