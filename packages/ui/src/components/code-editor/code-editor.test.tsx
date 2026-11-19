import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fake, jsonWorker, suggest } from "../../../test/fakes/monaco.ts";
import { describeJsonSchema, jsonPropertyDetail, objectSchemasAt, registerCodeLanguage, scopedCss } from "@/lib/monaco";
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
      expect(fake.providers.find((p) => p.language === "plaintext")!.provider.triggerCharacters).toEqual([".", " "]);
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
      expect(fake.providers.filter((p) => p.language === "plaintext").every((p) => p.disposed)).toBe(true);
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

  describe("fields and focus (TSK-94)", () => {
    test("rows: sized by the text between rows and maxRows lines; scrollbars only when it overflows", async () => {
      function Harness() {
        const [v, setV] = useState("{\n}");
        return (
          <>
            <CodeEditor aria-label="Input" rows={3} maxRows={5} value={v} onValueChange={setV} />
            <button onClick={() => setV(Array.from({ length: 9 }, (_, i) => `"l${i}"`).join("\n"))}>long</button>
          </>
        );
      }
      const { container } = render(<Harness />);
      const root = container.querySelector('[data-slot="code-editor"]') as HTMLElement;
      // Before Monaco: three lines of the code text (`lh`) and the inset.
      expect(root.style.height).toBe("calc(3lh + 2 * var(--by-space-inset-sm))");
      await settle();
      const editor = fake.editors[0]!;
      expect(editor.options).toMatchObject({ glyphMargin: false, folding: false, lineNumbersMinChars: 2, wordWrap: "on", overviewRulerLanes: 0, scrollbar: { vertical: "hidden" } });
      // jsdom resolves no tokens: 20 px a line, no padding, no frame.
      expect(root.style.height).toBe("60px");
      await act(async () => container.querySelector("button")!.click());
      expect(root.style.height).toBe("100px");
      expect(editor.options).toMatchObject({ overviewRulerLanes: 2, scrollbar: { vertical: "auto" } });
    });

    test("a pane editor (no rows) keeps folding and hides the scrollbars until the text overflows", async () => {
      render(<CodeEditor aria-label="Manifest" language="yaml" defaultValue="a: 1" />);
      await settle();
      expect(fake.editors[0]!.options).toMatchObject({ folding: true, overviewRulerLanes: 0, scrollbar: { vertical: "hidden", horizontal: "auto" }, bracketPairColorization: { enabled: false } });
    });

    test("focused by the pointer: the underline; from the keyboard: the double ring", async () => {
      const { container } = render(<CodeEditor aria-label="Input" defaultValue="{}" />);
      await settle();
      const root = container.querySelector('[data-slot="code-editor"]') as HTMLElement;
      const textarea = fake.editors[0]!.textarea;
      act(() => {
        root.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        textarea.focus();
      });
      expect(root.hasAttribute("data-focused")).toBe(true);
      expect(root.hasAttribute("data-focus-visible")).toBe(false);
      expect(root.className).toContain("data-focused:not-data-focus-visible:shadow-focus-underline");
      act(() => textarea.blur());
      expect(root.hasAttribute("data-focused")).toBe(false);
      act(() => textarea.focus());
      expect(root.hasAttribute("data-focus-visible")).toBe(true);
      expect(root.className).toContain("data-focus-visible:outline-ring");
    });

    test("a small one-line field reads the text.code-sm role", async () => {
      const values: Record<string, string> = { "--by-text-code-size": "14px", "--by-text-code-sm-size": "12px" };
      const original = window.getComputedStyle;
      const spy = vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
        const style = original(el, pseudo);
        return new Proxy(style, { get: (t, k) => (k === "getPropertyValue" ? (name: string) => values[name] ?? t.getPropertyValue(name) : Reflect.get(t, k)) });
      });
      try {
        render(<CodeEditor singleLine size="small" aria-label="Filter" />);
        await settle();
        expect(fake.editors[0]!.options.fontSize).toBe(12);
      } finally {
        spy.mockRestore();
      }
    });

    test("documentation in Markdown reaches Monaco as Markdown", async () => {
      const completion: CodeCompletion = { provide: () => [{ label: "ExecutionStatus", documentation: { markdown: "Example: `ExecutionStatus = \"Running\"`" } }, { label: "plain", documentation: "text" }] };
      render(<CodeEditor singleLine language="plaintext" aria-label="Query" completion={completion} />);
      await settle();
      const items = await suggest(fake.editors[0]!);
      expect(items[0]!.documentation).toEqual({ value: 'Example: `ExecutionStatus = "Running"`', isTrusted: false, supportHtml: false });
      expect(items[1]!.documentation).toBe("text");
    });

    test("value kinds get Monaco kinds of their own", async () => {
      const kinds = ["keyword-value", "list", "text", "number", "boolean", "date", "saved", "property"] as const;
      const completion: CodeCompletion = { provide: () => kinds.map((kind) => ({ label: kind, kind })) };
      render(<CodeEditor singleLine language="plaintext" aria-label="Query" completion={completion} />);
      await settle();
      const items = await suggest(fake.editors[0]!);
      expect(items.map((i) => i.kind)).toEqual([15, 6, 18, 12, 16, 10, 23, 9]);
    });
  });

  describe("JSON completion with the schema's types (TSK-94)", () => {
    const schema = {
      type: "object",
      required: ["customer_id"],
      properties: {
        customer_id: { type: "string" },
        channel: { enum: ["email", "chat"] },
        priority: { type: "integer", minimum: 1, maximum: 5 },
        context: { type: "object" },
        tags: { type: "array", items: { type: "string" } },
        note: { type: ["string", "null"] },
      },
    };

    test("describes a property's schema in a few words", () => {
      expect(describeJsonSchema({ type: "string" })).toBe("string");
      expect(describeJsonSchema({ enum: ["email", "chat"] })).toBe('"email" | "chat"');
      expect(describeJsonSchema({ type: "integer", minimum: 1, maximum: 5 })).toBe("integer 1–5");
      expect(describeJsonSchema({ type: "number", exclusiveMinimum: 0 })).toBe("number ≥ 0");
      expect(describeJsonSchema({ type: "array", items: { type: "string" } })).toBe("string[]");
      expect(describeJsonSchema({ type: ["string", "null"] })).toBe("string | null");
      expect(describeJsonSchema({ anyOf: [{ type: "string" }, { type: "integer" }] })).toBe("string | integer");
      expect(describeJsonSchema({ type: "string", format: "date-time" })).toBe("string (date-time)");
      expect(describeJsonSchema({ const: "v1" })).toBe('"v1"');
      expect(jsonPropertyDetail(schema, "customer_id")).toBe("string · required");
      expect(jsonPropertyDetail(schema, "missing")).toBeUndefined();
    });

    test("the innermost object's schema at the cursor", () => {
      const outer = { node: { type: "object", offset: 0, length: 40 }, schema: { properties: { a: {} } } };
      const inner = { node: { type: "object", offset: 10, length: 10 }, schema: { properties: { b: {} } } };
      const value = { node: { type: "string", offset: 12, length: 3 }, schema: { type: "string" } };
      expect(objectSchemasAt([outer, inner, value], 15)).toEqual([inner.schema]);
      expect(objectSchemasAt([outer, inner, value], 30)).toEqual([outer.schema]);
      expect(objectSchemasAt([outer], 0)).toEqual([]);
    });

    test("the language service's property items get the type and required from the schema", async () => {
      render(<CodeEditor aria-label="Input" jsonSchema={schema} defaultValue='{ "" }' />);
      await settle();
      expect(fake.providers.some((p) => p.language === "json" && !p.disposed)).toBe(true);
      jsonWorker.items = [{ label: "customer_id", kind: 10 }, { label: "channel", kind: 10 }, { label: "true" }];
      jsonWorker.matching = [{ node: { type: "object", offset: 0, length: 6 }, schema }];
      const editor = fake.editors[0]!;
      editor.cursorAt(3);
      const items = await suggest(editor);
      expect(items[0]).toMatchObject({ label: { label: "customer_id", description: "string · required" }, detail: "string · required" });
      expect(items[1]).toMatchObject({ label: { label: "channel", description: '"email" | "chat"' } });
      expect(items[2]!.label).toBe("true");
    });
  });

  test("the scoped CSS gives Monaco's widgets the flyout's look", () => {
    const css = scopedCss({ base: "vs", inherit: true, rules: [], colors: {} }, "");
    expect(css).toContain("box-shadow: var(--by-elevation-flyout-shadow)");
    expect(css).toContain("--vscode-cornerRadius-large: var(--by-radius-md)");
    expect(css).toContain("--vscode-editorSuggestWidget-selectedBackground: var(--by-editor-selection)");
    expect(css).toMatch(/\.monaco-list-row > \.contents \{ display: block; \}/);
  });

  test("the overflow layer is in the editor's scope and follows its region's theme and density (TSK-94)", async () => {
    const { container } = render(
      <div data-theme="light" data-density="comfortable">
        <CodeEditor aria-label="Input" defaultValue="{}" />
      </div>,
    );
    await settle();
    const layer = (fake.editors[0]!.options["overflowWidgetsDomNode"] as HTMLElement).parentElement!;
    expect(layer.hasAttribute("data-monaco-scope")).toBe(true);
    expect([layer.dataset.theme, layer.dataset.density]).toEqual(["light", "comfortable"]);
    const region = container.firstElementChild as HTMLElement;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    await act(async () => {
      region.setAttribute("data-theme", "dark");
      region.setAttribute("data-density", "compact");
      await new Promise((r) => setTimeout(r, 0));
    });
    expect([layer.dataset.theme, layer.dataset.density]).toEqual(["dark", "compact"]);
    vi.restoreAllMocks();
  });
});
