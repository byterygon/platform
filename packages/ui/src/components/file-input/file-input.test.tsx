import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Field, FieldError, FieldLabel } from "@/components/field/field";
import { act, axeViolations, cleanup, render } from "../../../test/render.tsx";
import { acceptsFile, FileInput } from "./file-input";

afterEach(cleanup);

const file = (name: string, type = "") => new File(["x"], name, { type });

/** Sets files on a file input the way a picker does, and fires change. */
const choose = (input: HTMLInputElement, files: File[]) => {
  Object.defineProperty(input, "files", { configurable: true, value: Object.assign([...files], { item: (i: number) => files[i] }) });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
};

const dropOn = (element: Element, files: File[]) => {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  act(() => {
    element.dispatchEvent(event);
  });
  return event;
};

describe("FileInput", () => {
  test("a FieldLabel names the native file input, which stays focusable", async () => {
    const { container } = render(
      <Field invalid>
        <FieldLabel>CA certificate</FieldLabel>
        <FileInput accept=".pem" />
        <FieldError>Choose a certificate.</FieldError>
      </Field>,
    );
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.labels?.[0]?.textContent).toBe("CA certificate");
    expect(input.accept).toBe(".pem");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    act(() => input.focus());
    expect(document.activeElement).toBe(input);
    expect(container.querySelector('[data-slot="file-input-names"]')!.textContent).toBe("No file chosen");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("choosing files reports them, shows their names and Clear empties it", () => {
    const onFilesChange = vi.fn();
    const { container } = render(<FileInput aria-label="Scripts" multiple onFilesChange={onFilesChange} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    choose(input, [file("a.sql"), file("b.sql")]);
    expect(onFilesChange).toHaveBeenLastCalledWith([expect.objectContaining({ name: "a.sql" }), expect.objectContaining({ name: "b.sql" })]);
    expect(container.querySelector('[data-slot="file-input-names"]')!.textContent).toBe("a.sql, b.sql");
    const clear = container.querySelector("button")!;
    expect(clear.hidden).toBe(false);
    act(() => clear.click());
    expect(onFilesChange).toHaveBeenLastCalledWith([]);
    expect(clear.hidden).toBe(true);
    expect(document.activeElement).toBe(input);
  });

  test("clicking the frame opens the picker", () => {
    const { container } = render(<FileInput aria-label="Key" />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    act(() => (container.querySelector('[data-slot="file-input-names"]') as HTMLElement).click());
    expect(click).toHaveBeenCalledOnce();
  });

  test("the dropzone takes dropped files that match accept", () => {
    const onFilesChange = vi.fn();
    const { container } = render(<FileInput aria-label="Scripts" variant="dropzone" accept=".sql" multiple onFilesChange={onFilesChange} />);
    const zone = container.querySelector('[data-slot="file-input"]')!;
    const event = dropOn(zone, [file("init.sql"), file("photo.png", "image/png")]);
    expect(event.defaultPrevented).toBe(true);
    expect(onFilesChange).toHaveBeenCalledWith([expect.objectContaining({ name: "init.sql" })]);
  });

  test("the field variant ignores drops", () => {
    const onFilesChange = vi.fn();
    const { container } = render(<FileInput aria-label="Key" onFilesChange={onFilesChange} />);
    dropOn(container.querySelector('[data-slot="file-input"]')!, [file("a.key")]);
    expect(onFilesChange).not.toHaveBeenCalled();
  });

  test("accept matches extensions, MIME types and wildcards", () => {
    expect(acceptsFile(".pem, .crt", file("ca.CRT"))).toBe(true);
    expect(acceptsFile("image/*", file("a.png", "image/png"))).toBe(true);
    expect(acceptsFile("application/json", file("a.json", "application/json"))).toBe(true);
    expect(acceptsFile(".pem", file("a.txt", "text/plain"))).toBe(false);
    expect(acceptsFile(undefined, file("anything"))).toBe(true);
  });

  test("forwards the ref to the input; disabled disables it", () => {
    const ref = createRef<HTMLInputElement>();
    render(<FileInput ref={ref} aria-label="Key" disabled />);
    expect(ref.current?.type).toBe("file");
    expect(ref.current?.disabled).toBe(true);
  });
});
