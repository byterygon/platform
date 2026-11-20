import { act, createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FitAddon, terminals, type Terminal as FakeTerminal } from "../../../test/fakes/xterm.ts";
import { waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { XTERM_COLORS, xtermMetrics } from "@/lib/xterm";
import { Terminal, type TerminalHandle } from "./terminal";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  terminals.length = 0;
  FitAddon.next = { cols: 100, rows: 30 };
});

async function mount(props: Parameters<typeof Terminal>[0] = {}) {
  const ref = createRef<TerminalHandle>();
  const onReady = vi.fn();
  const rendered = render(<Terminal ref={ref} onReady={onReady} {...props} />);
  const root = () => rendered.container.querySelector<HTMLElement>('[data-slot="terminal"]')!;
  const ready = async () => {
    await waitFor(() => expect(onReady).toHaveBeenCalled());
    return terminals[terminals.length - 1]!;
  };
  return { ...rendered, ref, root, ready, onReady };
}

/** jsdom has no layout: give elements a size so the fit addon runs. */
function laidOut() {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
}

const keydown = (term: FakeTerminal, init: KeyboardEventInit) => term.keyHandler!(new KeyboardEvent("keydown", init));

describe("Terminal", () => {
  test("shows the fallback until xterm.js has loaded, then opens it in a data-foreign-dom element", async () => {
    const { root, ready, container } = await mount({ "aria-label": "orders-api shell" });
    expect(root().hasAttribute("data-loading")).toBe(true);
    expect(root().getAttribute("aria-busy")).toBe("true");
    expect(container.querySelector('[data-slot="terminal-fallback"]')!.textContent).toBe("Loading the terminal…");
    const term = await ready();
    expect(root().hasAttribute("data-loading")).toBe(false);
    expect(container.querySelector<HTMLElement>('[data-slot="terminal-fallback"]')!.hidden).toBe(true);
    expect(container.querySelector('[data-foreign-dom] .xterm')).toBe(term.element);
    expect(root().getAttribute("role")).toBe("group");
    expect(root().getAttribute("aria-label")).toBe("orders-api shell");
    expect(term.textarea!.getAttribute("aria-label")).toBe("orders-api shell");
  });

  test("its theme reads every terminal.* role and its font text.code", async () => {
    const { ready } = await mount({ scrollback: 1234 });
    const term = await ready();
    expect(Object.keys(term.options["theme"] as object).sort()).toEqual(Object.keys(XTERM_COLORS).sort());
    expect(Object.values(XTERM_COLORS).filter((v) => v.startsWith("--by-terminal-ansi-"))).toHaveLength(16);
    expect(term.options["scrollback"]).toBe(1234);
    expect(typeof term.options["fontFamily"]).toBe("string");
    expect(term.options["fontSize"]).toBeGreaterThan(0);
  });

  test("xtermMetrics: text.code's size and leading as a ratio, fontSize overrides", () => {
    const values: Record<string, string> = { "--by-text-code-size": "13px", "--by-text-code-leading": "20px", "--by-font-mono": '"JetBrains Mono", monospace' };
    const read = { value: (v: string) => values[v] ?? "" };
    expect(xtermMetrics(read)).toEqual({ fontFamily: '"JetBrains Mono", monospace', fontSize: 13, lineHeight: 20 / 13 });
    expect(xtermMetrics(read, 16).fontSize).toBe(16);
    values["--by-text-code-leading"] = "1.5";
    expect(xtermMetrics(read).lineHeight).toBe(1.5);
  });

  test("writes before load are queued and flushed in order", async () => {
    const { ref, ready } = await mount();
    act(() => {
      ref.current!.write("one ");
      ref.current!.write(new TextEncoder().encode("two"));
    });
    const term = await ready();
    ref.current!.write("\r\nthree");
    expect(term.output()).toBe("one two\r\nthree");
  });

  test("keystrokes and binary input leave as bytes; readOnly drops them", async () => {
    const onData = vi.fn();
    const { ready } = await mount({ onData });
    const term = await ready();
    term.type("ls é\r");
    term.sendBinary("\u001b[M !!");
    expect(onData.mock.calls.map(([b]) => [...(b as Uint8Array)])).toEqual([[...new TextEncoder().encode("ls é\r")], [0x1b, 0x5b, 0x4d, 0x20, 0x21, 0x21]]);
  });

  test("readOnly ignores keystrokes and stops the cursor blinking", async () => {
    const onData = vi.fn();
    const { ready } = await mount({ onData, readOnly: true });
    const term = await ready();
    term.type("x");
    expect(onData).not.toHaveBeenCalled();
    expect(term.options["disableStdin"]).toBe(true);
    expect(term.options["cursorBlink"]).toBe(false);
  });

  test("reports its size once fitted, and again when it changes; nothing while it has no size", async () => {
    const onResize = vi.fn();
    FitAddon.next = { cols: 120, rows: 40 };
    laidOut();
    const { ready } = await mount({ onResize });
    const term = await ready();
    expect(onResize.mock.calls).toEqual([[120, 40]]);
    term.resizeTo(90, 20);
    expect(onResize).toHaveBeenLastCalledWith(90, 20);
    expect(onResize).toHaveBeenCalledTimes(2);
    cleanup();
    vi.restoreAllMocks();
    const hidden = vi.fn();
    const second = await mount({ onResize: hidden });
    const unfitted = await second.ready();
    expect(unfitted.addons.some((a) => a instanceof FitAddon && a.fits > 0)).toBe(false);
    expect(hidden.mock.calls).toEqual([[80, 24]]);
  });

  test("Mod+Shift+C copies the selection and Mod+Shift+V pastes; Ctrl+C goes to the process", async () => {
    const writeText = vi.fn(async () => {});
    const readText = vi.fn(async () => "pasted");
    Object.defineProperty(navigator, "clipboard", { value: { writeText, readText }, configurable: true });
    const onData = vi.fn();
    const { ready } = await mount({ onData });
    const term = await ready();
    term.selection = "selected text";
    expect(keydown(term, { code: "KeyC", key: "C", ctrlKey: true, shiftKey: true })).toBe(false);
    expect(writeText).toHaveBeenCalledWith("selected text");
    expect(keydown(term, { code: "KeyV", key: "V", metaKey: true, shiftKey: true })).toBe(false);
    await waitFor(() => expect(term.pasted).toEqual(["pasted"]));
    expect(keydown(term, { code: "KeyC", key: "c", ctrlKey: true })).toBe(true);
  });

  test("the ref focuses, clears, resets, searches and gives the size", async () => {
    laidOut();
    const { ref, ready } = await mount();
    const term = await ready();
    ref.current!.write("hello world");
    ref.current!.focus();
    ref.current!.clear();
    ref.current!.reset();
    expect([term.focused, term.cleared, term.resets]).toEqual([1, 1, 1]);
    expect(ref.current!.findNext("world")).toBe(true);
    expect(ref.current!.findPrevious("nope")).toBe(false);
    expect(ref.current!.size()).toEqual({ cols: 100, rows: 30 });
  });

  test("unmounting disposes xterm.js", async () => {
    const { ready, unmount } = await mount();
    const term = await ready();
    unmount();
    expect(term.disposed).toBe(true);
  });

  test("has no axe violations, loading and loaded", async () => {
    const { container, ready } = await mount();
    expect(await axeViolations(container)).toEqual([]);
    await ready();
    expect(await axeViolations(container)).toEqual([]);
  });
});
