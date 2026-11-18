import { act, createRef, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { click, key } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { isBase64, KeyValueEditor, keyValueProblems, type KeyValueEntry } from "./key-value-editor";

afterEach(cleanup);

let latest: KeyValueEntry[] = [];
function Harness(props: { initial: KeyValueEntry[]; allowDuplicates?: boolean; encodings?: boolean; readOnly?: boolean }) {
  const [value, setValue] = useState(props.initial);
  latest = value;
  return (
    <KeyValueEditor
      aria-label="Headers"
      value={value}
      onChange={setValue}
      allowDuplicates={props.allowDuplicates}
      valueEncodings={props.encodings ? ["text", "base64"] : undefined}
      readOnly={props.readOnly}
      keySuggestions={["trace-id"]}
    />
  );
}

const inputs = (c: HTMLElement) => [...c.querySelectorAll<HTMLInputElement>("input")];
const button = (c: HTMLElement, name: string) => [...c.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === name || b.textContent === name)!;
const type = async (input: HTMLInputElement, text: string) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

describe("KeyValueEditor", () => {
  test("rows of labelled inputs; typing edits; add and remove", async () => {
    const { container } = render(<Harness initial={[{ key: "a", value: "1" }]} />);
    expect(container.querySelector('[role="group"]')!.getAttribute("aria-label")).toBe("Headers");
    const [k, v] = inputs(container);
    expect(k!.getAttribute("aria-label")).toBe("Key 1");
    expect(v!.getAttribute("aria-label")).toBe("Value 1");
    expect(k!.getAttribute("list")).toBe(container.querySelector("datalist")!.id);
    await type(v!, "42");
    expect(latest).toEqual([{ key: "a", value: "42" }]);
    await click(button(container, "Add"));
    expect(latest).toHaveLength(2);
    expect(document.activeElement).toBe(inputs(container)[2]);
    await click(button(container, "Remove row 1"));
    expect(latest).toEqual([{ key: "", value: "" }]);
  });

  test("Enter in a key goes to its value, Enter in a value adds a row below; Mod+Backspace removes", async () => {
    const { container } = render(<Harness initial={[{ key: "a", value: "1" }, { key: "b", value: "2" }]} />);
    const [k1, v1] = inputs(container);
    await key("Enter", k1!);
    expect(document.activeElement).toBe(v1);
    await key("Enter", v1!);
    expect(latest.map((e) => e.key)).toEqual(["a", "", "b"]);
    expect(document.activeElement).toBe(inputs(container)[2]);
    await key("Backspace", inputs(container)[2]!, { ctrlKey: true });
    expect(latest.map((e) => e.key)).toEqual(["a", "b"]);
    expect(document.activeElement).toBe(inputs(container)[0]);
  });

  test("duplicates and bad base64 are invalid with a message", async () => {
    const { container } = render(
      <Harness allowDuplicates={false} encodings initial={[{ key: "x", value: "1", encoding: "text" }, { key: "x", value: "%%", encoding: "base64" }]} />,
    );
    const invalid = inputs(container).filter((i) => i.getAttribute("aria-invalid") === "true");
    expect(invalid.map((i) => i.getAttribute("aria-label"))).toEqual(["Key 1", "Key 2", "Value 2"]);
    const described = document.getElementById(invalid[2]!.getAttribute("aria-describedby")!)!;
    expect(described.textContent).toBe("Not valid base64");
    expect(container.querySelectorAll('[aria-label^="Encoding of"]')).toHaveLength(2);
  });

  test("read-only shows the rows without editing controls", () => {
    const { container } = render(<Harness readOnly initial={[{ key: "a", value: "1" }]} />);
    expect(inputs(container).every((i) => i.readOnly)).toBe(true);
    expect(container.querySelector("button")).toBeNull();
  });

  test("helpers", () => {
    expect(isBase64("3q2+7w==")).toBe(true);
    expect(isBase64("3q2+7w")).toBe(true);
    expect(isBase64("abcde")).toBe(false);
    expect(isBase64("ab%")).toBe(false);
    expect(keyValueProblems([{ key: "", value: "v" }, { key: "a", value: "" }, { key: "a", value: "" }], false)).toEqual([
      { key: "A key is needed", value: undefined },
      { key: "Duplicate key", value: undefined },
      { key: "Duplicate key", value: undefined },
    ]);
    expect(keyValueProblems([{ key: "a", value: "" }, { key: "a", value: "" }], true)[1]!.key).toBeUndefined();
  });

  test("forwards the ref; no axe violations", async () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <KeyValueEditor ref={ref} aria-label="Labels" value={[{ key: "a", value: "b", encoding: "base64" }]} onChange={() => {}} valueEncodings={["text", "base64"]} />,
    );
    expect(ref.current?.dataset.slot).toBe("key-value-editor");
    expect(await axeViolations(container)).toEqual([]);
  });
});
