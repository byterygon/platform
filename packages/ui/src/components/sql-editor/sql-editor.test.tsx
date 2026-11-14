import { createRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { cssColorToHex, monacoMetrics, monacoTheme, themeName } from "@/lib/monaco";
import { fake } from "../../../test/fakes/monaco.ts";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { SqlEditor, splitSqlStatements, sqlRunFor, sqlStatementAt } from "./sql-editor";

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

describe("splitSqlStatements", () => {
  test("splits on top-level semicolons and trims", () => {
    expect(splitSqlStatements("select 1;  select 2 ;\n\nselect 3").map((s) => s.text)).toEqual(["select 1", "select 2", "select 3"]);
  });

  test("ignores semicolons in strings, identifiers, comments and dollar quotes", () => {
    const sql = [
      "select 'a;b', 'it''s;', E'x\\';y', \"col;umn\" from t; -- c;omment",
      "/* block ; /* nested ; */ still ; */ select 2;",
      "create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql;",
      "select $$;$$, $1;",
    ].join("\n");
    expect(splitSqlStatements(sql).map((s) => s.text)).toEqual([
      "select 'a;b', 'it''s;', E'x\\';y', \"col;umn\" from t",
      "select 2",
      "create function f() returns int as $body$ begin; return 1; end $body$ language plpgsql",
      "select $$;$$, $1",
    ]);
  });

  test("offsets point into the text; blank and comment-only pieces are dropped", () => {
    const sql = ";;  -- only a comment\n; select 1 ;";
    const [statement] = splitSqlStatements(sql);
    expect(splitSqlStatements(sql)).toHaveLength(1);
    expect(sql.slice(statement!.start, statement!.end)).toBe("select 1");
  });

  test("an unterminated string or dollar quote runs to the end", () => {
    expect(splitSqlStatements("select 'oops; select 2").map((s) => s.text)).toEqual(["select 'oops; select 2"]);
    expect(splitSqlStatements("select $q$ ; ").map((s) => s.text)).toEqual(["select $q$ ;"]);
  });
});

describe("sqlStatementAt", () => {
  const sql = "select 1;\nselect 2;\n\n-- note\n\nselect 3";
  test("the statement holding the cursor, including right after its semicolon", () => {
    expect(sqlStatementAt(sql, 3)?.text).toBe("select 1");
    expect(sqlStatementAt(sql, sql.indexOf(";") + 1)?.text).toBe("select 1");
    expect(sqlStatementAt(sql, sql.indexOf("2"))?.text).toBe("select 2");
    expect(sqlStatementAt(sql, sql.length)?.text).toBe("select 3");
  });

  test("in blank space or comments between statements: the previous one on its line, else the next", () => {
    expect(sqlStatementAt(sql, sql.indexOf("-- note"))?.text).toBe("select 3");
    expect(sqlStatementAt("select 1;   ", 11)?.text).toBe("select 1");
    expect(sqlStatementAt("select 1;\n\n", 11)?.text).toBe("select 1");
    expect(sqlStatementAt("\n\nselect 1", 0)?.text).toBe("select 1");
    expect(sqlStatementAt("  -- nothing  ", 3)).toBeNull();
  });
});

describe("sqlRunFor", () => {
  test("a selection runs as is and lists its statements with document offsets", () => {
    const sql = "x; select 1; select 2; y";
    const start = sql.indexOf("select 1");
    const end = sql.indexOf("; y");
    const run = sqlRunFor(sql, start, end)!;
    expect(run.source).toBe("selection");
    expect(run.text).toBe("select 1; select 2");
    expect(run.statements.map((s) => [s.text, sql.slice(s.start, s.end)])).toEqual([
      ["select 1", "select 1"],
      ["select 2", "select 2"],
    ]);
  });

  test("no selection runs the statement under the cursor; nothing to run gives null", () => {
    expect(sqlRunFor("select 1; select 2", 12, 12)).toMatchObject({ source: "statement", text: "select 2", statements: [{ text: "select 2" }] });
    expect(sqlRunFor("   ", 1, 1)).toBeNull();
    expect(sqlRunFor("a;  ;b", 2, 4)).toBeNull();
  });
});

describe("monaco theme from tokens", () => {
  test("converts the computed colour formats to hex", () => {
    expect(cssColorToHex("rgb(255, 0, 128)")).toBe("#ff0080");
    expect(cssColorToHex("rgba(0, 0, 0, 0.5)")).toBe("#00000080");
    expect(cssColorToHex("rgb(10 20 30 / 25%)")).toBe("#0a141e40");
    expect(cssColorToHex("oklch(1 0 0)")).toBe("#ffffff");
    expect(cssColorToHex("oklch(0 0 0)")).toBe("#000000");
    expect(cssColorToHex("oklch(0.628 0.2577 29.23)")).toBe("#ff0000");
    expect(cssColorToHex("oklch(0.5666 0.1349 242.23 / 0.216)")).toMatch(/^#[0-9a-f]{6}37$/);
    expect(cssColorToHex("oklab(0.452014 -0.032457 -0.311528)")).toBe("#0000ff");
    expect(cssColorToHex("color(srgb 1 0.5 0)")).toBe("#ff8000");
    expect(cssColorToHex("#abc")).toBe("#aabbcc");
    expect(cssColorToHex("transparent")).toBe("#00000000");
    expect(cssColorToHex("hsl(0 100% 50%)")).toBeNull();
  });

  test("every editor and syntax role reaches the theme; the base follows the background", () => {
    const colors: Record<string, string> = { "--by-editor-bg": "#101418", "--by-syntax-keyword": "#a080ff", "--by-syntax-string": "#60c080" };
    const theme = monacoTheme({ color: (v) => colors[v] ?? "#808080" });
    expect(theme.base).toBe("vs-dark");
    expect(theme.colors["editor.background"]).toBe("#101418");
    expect(theme.rules).toContainEqual({ token: "keyword", foreground: "a080ff" });
    expect(theme.rules).toContainEqual({ token: "string", foreground: "60c080" });
    expect(monacoTheme({ color: (v) => (v === "--by-editor-bg" ? "#fcfcfd" : "#000000") }).base).toBe("vs");
    expect(themeName(theme)).toBe(themeName(monacoTheme({ color: (v) => colors[v] ?? "#808080" })));
  });

  test("text metrics come from text.code and space.inset.sm", () => {
    const values: Record<string, string> = { "--by-text-code-size": "13px", "--by-text-code-leading": "1.5", "--by-space-inset-sm": "6px", "--by-text-code-family": "\"JetBrains Mono\", monospace", "--by-text-code-tracking": "0" };
    expect(monacoMetrics({ value: (v) => values[v] ?? "" })).toEqual({ fontFamily: "\"JetBrains Mono\", monospace", fontSize: 13, lineHeight: 20, letterSpacing: 0, padding: { top: 6, bottom: 6 } });
  });
});

describe("SqlEditor", () => {
  test("starts with a working fallback textarea, then mounts Monaco with the text", async () => {
    const { container } = render(<SqlEditor aria-label="Query" defaultValue="select 1;" />);
    const root = container.querySelector<HTMLElement>("[data-slot=sql-editor]")!;
    const fallback = container.querySelector<HTMLTextAreaElement>("[data-slot=sql-editor-fallback]")!;
    expect(root.hasAttribute("data-loading")).toBe(true);
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(fallback.value).toBe("select 1;");
    expect(fallback.getAttribute("aria-label")).toBe("Query");
    await settle();
    expect(root.hasAttribute("data-loading")).toBe(false);
    expect(container.querySelector("[data-slot=sql-editor-fallback]")).toBeNull();
    expect(fake.editors).toHaveLength(1);
    expect(fake.editors[0]!.model.getValue()).toBe("select 1;");
    expect(fake.editors[0]!.model.language).toBe("pgsql");
    expect(fake.editors[0]!.options).toMatchObject({ ariaLabel: "Query", readOnly: false, lineNumbers: "on", tabFocusMode: false, minimap: { enabled: false }, automaticLayout: true });
  });

  test("Monaco takes over the fallback's text, selection and focus", async () => {
    const { container } = render(<SqlEditor aria-label="Query" />);
    const fallback = container.querySelector<HTMLTextAreaElement>("[data-slot=sql-editor-fallback]")!;
    fallback.focus();
    type(fallback, "select 42;");
    fallback.setSelectionRange(7, 9);
    await settle();
    const editor = fake.editors[0]!;
    expect(editor.model.getValue()).toBe("select 42;");
    expect([editor.textarea.selectionStart, editor.textarea.selectionEnd]).toEqual([7, 9]);
    expect(document.activeElement).toBe(editor.textarea);
    expect(container.querySelector("[data-slot=sql-editor]")!.hasAttribute("data-focused")).toBe(true);
  });

  test("defines a theme from the tokens and activates it", async () => {
    render(<SqlEditor aria-label="Query" />);
    await settle();
    expect(fake.theme).toMatch(/^byterygon-/);
    expect(fake.themes.has(fake.theme!)).toBe(true);
  });

  test("reports edits through onValueChange, before and after Monaco mounts", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<SqlEditor aria-label="Query" onValueChange={onValueChange} />);
    type(container.querySelector<HTMLTextAreaElement>("[data-slot=sql-editor-fallback]")!, "select");
    expect(onValueChange).toHaveBeenLastCalledWith("select");
    await settle();
    type(fake.editors[0]!.textarea, "select 2");
    expect(onValueChange).toHaveBeenLastCalledWith("select 2");
  });

  test("a controlled value replaces the text after mount, without echoing onValueChange", async () => {
    const onValueChange = vi.fn();
    let set: (v: string) => void = () => {};
    function Controlled() {
      const [value, setValue] = useState("select 1");
      set = setValue;
      return <SqlEditor aria-label="Query" value={value} onValueChange={onValueChange} />;
    }
    render(<Controlled />);
    await settle();
    await act(async () => set("select 2"));
    expect(fake.editors[0]!.model.getValue()).toBe("select 2");
    expect(fake.editors[0]!.textarea.value).toBe("select 2");
    expect(onValueChange).not.toHaveBeenCalled();
  });

  test("Ctrl+Enter runs the statement under the cursor, in the fallback and in Monaco", async () => {
    const onRun = vi.fn();
    const { container } = render(<SqlEditor aria-label="Query" defaultValue={"select 1;\nselect 2;"} onRun={onRun} />);
    const fallback = container.querySelector<HTMLTextAreaElement>("[data-slot=sql-editor-fallback]")!;
    fallback.setSelectionRange(2, 2);
    await ctrlEnter(fallback);
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ source: "statement", text: "select 1" }));
    await settle();
    const editor = fake.editors[0]!;
    editor.textarea.setSelectionRange(12, 12);
    await ctrlEnter(editor.textarea);
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ source: "statement", text: "select 2", start: 10, end: 18 }));
    editor.textarea.setSelectionRange(0, 18);
    await ctrlEnter(editor.textarea);
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ source: "selection", statements: [expect.objectContaining({ text: "select 1" }), expect.objectContaining({ text: "select 2" })] }));
  });

  test("markers become Monaco markers at the right positions", async () => {
    const sql = "select *\nfrom ordrs;";
    render(<SqlEditor aria-label="Query" defaultValue={sql} markers={[{ start: sql.indexOf("ordrs"), message: 'relation "ordrs" does not exist' }, { start: 0, end: 6, message: "slow", severity: "warning" }]} />);
    await settle();
    expect(fake.markers).toEqual([
      { startLineNumber: 2, startColumn: 6, endLineNumber: 2, endColumn: 11, message: 'relation "ordrs" does not exist', severity: 8 },
      { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7, message: "slow", severity: 4 },
    ]);
  });

  test("read-only: data-readonly, a read-only fallback and a read-only editor", async () => {
    const { container } = render(<SqlEditor aria-label="Query" readOnly defaultValue="select 1" />);
    expect(container.querySelector<HTMLTextAreaElement>("[data-slot=sql-editor-fallback]")!.readOnly).toBe(true);
    await settle();
    expect(container.querySelector("[data-slot=sql-editor]")!.hasAttribute("data-readonly")).toBe(true);
    expect(fake.editors[0]!.options.readOnly).toBe(true);
  });

  test("options follow the props after mount", async () => {
    const { container, unmount } = render(<SqlEditor aria-label="Query" />);
    await settle();
    unmount();
    expect(fake.editors[0]!.disposed).toBe(true);
    expect(fake.editors[0]!.model.disposed).toBe(true);
    render(<SqlEditor aria-label="Statement" tabMovesFocus lineNumbers={false} screenReaderOptimized language="sql" placeholder="Type SQL" />);
    await settle();
    expect(fake.editors[1]!.options).toMatchObject({ ariaLabel: "Statement", tabFocusMode: true, lineNumbers: "off", accessibilitySupport: "on", placeholder: "Type SQL" });
    expect(fake.editors[1]!.model.language).toBe("sql");
    expect(container.isConnected).toBe(false);
  });

  test("forwards the ref to the root, calls onEditorReady, takes className", async () => {
    const ref = createRef<HTMLDivElement>();
    const onEditorReady = vi.fn();
    render(<SqlEditor ref={ref} aria-label="Query" className="h-full" onEditorReady={onEditorReady} />);
    await settle();
    expect(ref.current?.dataset.slot).toBe("sql-editor");
    expect(ref.current?.className).toContain("h-full");
    expect(ref.current?.className).not.toContain("h-panel-xs");
    expect(onEditorReady).toHaveBeenCalledWith(fake.editors[0], expect.objectContaining({ editor: expect.anything() }));
  });

  test("the fallback has no axe violations", async () => {
    const { container } = render(<SqlEditor aria-label="Query" defaultValue="select 1" />);
    expect(await axeViolations(container)).toEqual([]);
    await settle();
  });
});
