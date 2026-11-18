import { act, createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click, focus, key } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { HexView, bytesToHex, bytesToText } from "./hex-view";

afterEach(cleanup);

const bytes = (n: number) => new Uint8Array(Array.from({ length: n }, (_, i) => i & 0xff));
const grid = (c: HTMLElement) => c.querySelector('[role="grid"]') as HTMLElement;
const active = (c: HTMLElement) => c.querySelector(`#${CSS.escape(grid(c).getAttribute("aria-activedescendant")!)}`) as HTMLElement;
const pointerDown = async (el: Element, init: PointerEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, ...init }));
  });
const selected = (c: HTMLElement) => [...c.querySelectorAll('[data-slot="hex-view-byte"][data-selected]')].map((e) => e.textContent);

describe("HexView", () => {
  test("rows of offset, hex and ASCII", async () => {
    const { container } = render(<HexView bytes={new TextEncoder().encode("AB\u0001CDEFGHIJKLMNOPQ")} />);
    const rows = container.querySelectorAll('[role="row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('[role="rowheader"]')!.textContent).toBe("00000000");
    expect(rows[1]!.querySelector('[role="rowheader"]')!.textContent).toBe("00000010");
    const first = [...rows[0]!.querySelectorAll('[data-slot="hex-view-byte"]')].map((e) => e.textContent);
    expect(first.slice(0, 3)).toEqual(["41", "42", "01"]);
    expect(rows[0]!.textContent).toContain("AB.CD");
    expect(grid(container).getAttribute("aria-rowcount")).toBe("2");
  });

  test("the keyboard moves and extends the selection, Ctrl+C copies hex and Ctrl+Shift+C text", async () => {
    const onCopy = vi.fn();
    const { container } = render(<HexView bytes={new TextEncoder().encode("Hello, world, and more bytes")} onCopy={onCopy} />);
    const g = grid(container);
    await focus(g);
    expect(active(container).textContent).toBe("48");
    await key("ArrowRight", g);
    await key("ArrowRight", g, { shiftKey: true });
    await key("ArrowRight", g, { shiftKey: true });
    expect(selected(container)).toEqual(["65", "6c", "6c"]);
    await key("c", g, { ctrlKey: true });
    expect(onCopy).toHaveBeenLastCalledWith("65 6c 6c", "hex");
    await key("c", g, { ctrlKey: true, shiftKey: true });
    expect(onCopy).toHaveBeenLastCalledWith("ell", "text");
    await key("ArrowDown", g);
    expect(active(container).getAttribute("aria-label")).toBe("13: 6f");
    await key("End", g);
    expect(active(container).getAttribute("aria-label")).toBe("1b: 73");
    await key("Home", g, { ctrlKey: true });
    expect(active(container).getAttribute("aria-label")).toBe("0: 48");
    await key("a", g, { ctrlKey: true });
    expect(selected(container)).toHaveLength(28);
    await key("Escape", g);
    expect(selected(container)).toHaveLength(1);
  });

  test("a click selects, Shift+click extends, and the footer buttons copy", async () => {
    const onCopy = vi.fn();
    const { container } = render(<HexView bytes={bytes(40)} onCopy={onCopy} />);
    const cells = container.querySelectorAll('[data-slot="hex-view-byte"]');
    await pointerDown(cells[2]!);
    await pointerDown(cells[4]!, { shiftKey: true });
    expect(selected(container)).toEqual(["02", "03", "04"]);
    expect(container.querySelector('[data-slot="hex-view-footer"]')!.textContent).toContain("3 of 40 bytes selected, from 0x2");
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Copy hex")!);
    expect(onCopy).toHaveBeenLastCalledWith("02 03 04", "hex");
  });

  test("only rows near the viewport are rendered, and the active one", async () => {
    const { container } = render(<HexView bytes={bytes(16 * 10_000)} overscan={2} />);
    const rendered = container.querySelectorAll('[role="row"]').length;
    expect(rendered).toBeLessThan(60);
    const g = grid(container);
    await key("End", g, { ctrlKey: true });
    expect(active(container)).not.toBeNull();
    expect(active(container).getAttribute("aria-label")).toBe("270ff: ff");
  });

  test("baseOffset shifts the offsets; no bytes shows an empty state", async () => {
    const { container } = render(<HexView bytes={bytes(4)} baseOffset={0x100} bytesPerRow={2} />);
    expect([...container.querySelectorAll('[role="rowheader"]')].map((e) => e.textContent)).toEqual(["00000100", "00000102"]);
    const empty = render(<HexView bytes={new Uint8Array()} />);
    expect(empty.container.textContent).toContain("No bytes");
  });

  test("formats", async () => {
    expect(bytesToHex(new Uint8Array([0, 26, 255]))).toBe("00 1a ff");
    expect(bytesToText(new TextEncoder().encode("Xin chào"))).toBe("Xin chào");
    expect(bytesToText(new Uint8Array([0x41, 0xff, 0x00]))).toBe("A..");
  });

  test("forwards the ref to the root", async () => {
    const ref = createRef<HTMLDivElement>();
    render(<HexView ref={ref} bytes={bytes(3)} />);
    expect(ref.current?.dataset.slot).toBe("hex-view");
  });

  test("has no axe violations", async () => {
    const { container } = render(<HexView bytes={bytes(70)} aria-label="Bytes" />);
    expect(await axeViolations(container)).toEqual([]);
  });
});
