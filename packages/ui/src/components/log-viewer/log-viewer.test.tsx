import { act, createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { checkClasses } from "../../../test/conventions.ts";
import { click, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, classesIn, cleanup, render } from "../../../test/render.tsx";
import { LogViewer, type LogViewerHandle, ansiClasses, formatLogTimestamp, parseAnsi } from "./log-viewer";

afterEach(cleanup);

const ESC = "\u001b";
const rows = (c: HTMLElement) => [...c.querySelectorAll<HTMLElement>('[data-slot="log-viewer-row"]')];
const footer = (c: HTMLElement) => c.querySelector('[data-slot="log-viewer-footer"]')!.textContent;

async function mount(props: Parameters<typeof LogViewer>[0] = {}) {
  const ref = createRef<LogViewerHandle>();
  const rendered = render(<LogViewer ref={ref} {...props} />);
  const append = async (...lines: Parameters<LogViewerHandle["append"]>[0]) =>
    act(async () => {
      ref.current!.append(lines);
    });
  return { ...rendered, ref, append };
}

describe("parseAnsi", () => {
  test("SGR colours, bright colours, bold and reset become styled runs; the plain text has no escapes", () => {
    const { segments, text } = parseAnsi(`${ESC}[1;31mERROR${ESC}[0m disk ${ESC}[92mok${ESC}[39m done`);
    expect(text).toBe("ERROR disk ok done");
    expect(segments.map((s) => [s.text, s.style])).toEqual([
      ["ERROR", { bold: true, fg: "red" }],
      [" disk ", {}],
      ["ok", { fg: "bright-green" }],
      [" done", {}],
    ]);
  });

  test("256-colour indexes under 16 map to the roles; the cube, greys and true colour keep the text's colour", () => {
    expect(parseAnsi(`${ESC}[38;5;4mx`).segments[0]!.style).toEqual({ fg: "blue" });
    expect(parseAnsi(`${ESC}[38;5;9mx`).segments[0]!.style).toEqual({ fg: "bright-red" });
    expect(parseAnsi(`${ESC}[38;5;202mx`).segments[0]!.style).toEqual({});
    expect(parseAnsi(`${ESC}[38;2;255;0;0;1mx`).segments[0]!.style).toEqual({ bold: true });
    expect(parseAnsi(`${ESC}[48;5;2mx`).segments[0]!.style).toEqual({ bg: "green" });
  });

  test("other escapes and controls are stripped; a carriage return keeps what was drawn last", () => {
    expect(parseAnsi(`${ESC}[2K${ESC}[1Gdone${ESC}]0;title\u0007 \u0008ok\ttab`).text).toBe("done ok\ttab");
    expect(parseAnsi("10%\r50%\r100%").text).toBe("100%");
    expect(parseAnsi("line\r\n").text).toBe("line");
    expect(parseAnsi(`${ESC}[31`).text).toBe("31");
  });

  test("italic, underline, dim, strike and inverse, and their resets", () => {
    const { segments } = parseAnsi(`${ESC}[3;4;9mA${ESC}[23;24;29mB${ESC}[2mC${ESC}[22;7mD${ESC}[27mE`);
    expect(segments.map((s) => s.style)).toEqual([{ italic: true, underline: true, strike: true }, {}, { dim: true }, { inverse: true }, {}]);
  });
});

describe("ansiClasses", () => {
  test("a colour is its terminal.ansi role; a background takes terminal.bg as text; inverse swaps", () => {
    expect(ansiClasses({ fg: "red", bold: true })).toBe("text-terminal-ansi-red font-[var(--by-font-weight-bold)]");
    expect(ansiClasses({ bg: "yellow" })).toBe("bg-terminal-ansi-yellow text-terminal");
    expect(ansiClasses({ inverse: true })).toBe("bg-terminal-fg text-terminal");
    expect(ansiClasses({ inverse: true, fg: "cyan" })).toBe("bg-terminal-ansi-cyan text-terminal");
    expect(ansiClasses({ dim: true })).toBe("text-fg-muted");
    expect(ansiClasses({})).toBe("");
  });

  test("every class the parser can give compiles under the token theme alone", async () => {
    const all = new Set<string>();
    const colors = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
    for (const [i] of colors.entries()) {
      for (const code of [30 + i, 40 + i, 90 + i, 100 + i]) for (const c of ansiClasses(parseAnsi(`${ESC}[${code}mx`).segments[0]!.style).split(" ")) all.add(c);
    }
    for (const c of ansiClasses({ bold: true, italic: true, underline: true, strike: true, dim: true }).split(" ")) all.add(c);
    for (const c of ansiClasses({ inverse: true }).split(" ")) all.add(c);
    const report = await checkClasses(all);
    expect(report.errors).toEqual([]);
    expect(report.tokens.filter((t) => t.startsWith("terminal.ansi."))).toHaveLength(16);
  });
});

test("formatLogTimestamp shows Docker's RFC 3339 to the millisecond, UTC", () => {
  expect(formatLogTimestamp("2026-11-20T08:00:01.120458123Z")).toBe("2026-11-20 08:00:01.120");
  expect(formatLogTimestamp("2026-11-20T08:00:01Z")).toBe("2026-11-20 08:00:01");
  expect(formatLogTimestamp(Date.UTC(2026, 10, 20, 8, 0, 1, 5))).toBe("2026-11-20 08:00:01.005");
  expect(formatLogTimestamp("yesterday")).toBe("yesterday");
});

describe("LogViewer", () => {
  test("appended lines render as rows with their timestamp, stream mark and coloured text", async () => {
    const { container, append } = await mount();
    expect(container.querySelector('[data-slot="log-viewer-empty"]')!.textContent).toBe("No log lines yet.");
    await append({ ts: "2026-11-20T08:00:01.5Z", stream: "stdout", text: `${ESC}[32mINFO${ESC}[0m up` }, { ts: "2026-11-20T08:00:02Z", stream: "stderr", text: "boom" });
    const [first, second] = rows(container);
    expect(first!.textContent).toBe("2026-11-20 08:00:01.5INFO up");
    expect(first!.querySelector(".text-terminal-ansi-green")!.textContent).toBe("INFO");
    expect(second!.dataset.stream).toBe("stderr");
    expect(second!.className).toContain("border-danger-stroke");
    expect(first!.className).not.toContain("border-danger-stroke");
    expect(footer(container)).toContain("2 lines");
    expect(container.querySelector('[role="log"]')!.getAttribute("aria-label")).toBe("Log");
  });

  test("timestamps off hides the column; streamColumn shows the stream with its swatch", async () => {
    const { container, append } = await mount({ timestamps: false, streamColumn: true, streamColors: { web: "cat-1" } });
    await append({ ts: 1, stream: "web", text: "listening" });
    const row = rows(container)[0]!;
    expect(row.textContent).toBe("weblistening");
    expect(row.querySelector(".bg-chart-1")).not.toBeNull();
  });

  test("beyond maxLines the oldest lines are dropped in chunks, and the footer counts them", async () => {
    const { container, ref, append } = await mount({ maxLines: 100, timestamps: false });
    await append(...Array.from({ length: 105 }, (_, i) => ({ text: `line ${i}` })));
    const lines = ref.current!.lines();
    expect(lines.length).toBe(90);
    expect(lines[0]!.text).toBe("line 15");
    expect(footer(container)).toContain("90 lines, 15 older dropped");
    await act(async () => ref.current!.clear());
    expect(ref.current!.lines()).toEqual([]);
    await waitFor(() => expect(container.querySelector('[data-slot="log-viewer-empty"]')).not.toBeNull());
  });

  test("Mod+F searches the loaded lines: count, next and previous, the current match marked", async () => {
    const { container, append } = await mount({ timestamps: false });
    await append({ text: "GET /a 200" }, { text: "GET /b 500" }, { text: "POST /c 500" });
    const scroller = container.querySelector<HTMLElement>('[role="log"]')!;
    scroller.focus();
    await key("f", scroller, { ctrlKey: true });
    const input = container.querySelector<HTMLInputElement>('[role="search"] input')!;
    await waitFor(() => expect(document.activeElement).toBe(input));
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "500");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const count = () => container.querySelector('[role="search"] [aria-live]')!.textContent;
    expect(count()).toBe("1 of 2");
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.querySelector("mark[data-current]")!.closest<HTMLElement>('[data-slot="log-viewer-row"]')!.dataset.index).toBe("1");
    await key("Enter", input);
    expect(count()).toBe("2 of 2");
    expect(container.querySelector("mark[data-current]")!.closest<HTMLElement>('[data-slot="log-viewer-row"]')!.dataset.index).toBe("2");
    await key("Enter", input, { shiftKey: true });
    expect(count()).toBe("1 of 2");
    await key("Escape", input);
    await waitFor(() => expect(container.querySelector('[role="search"]')).toBeNull());
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  test("follow: the footer's Follow and End turn it back on; controlled through onFollowChange", async () => {
    const onFollowChange = vi.fn();
    const off = await mount({ follow: false, onFollowChange });
    await off.append({ text: "a" });
    expect(off.container.querySelector('[data-slot="log-viewer"]')!.hasAttribute("data-follow")).toBe(false);
    await click([...off.container.querySelectorAll("button")].find((b) => b.textContent === "Follow")!);
    expect(onFollowChange).toHaveBeenLastCalledWith(true);
    onFollowChange.mockClear();
    await key("End", off.container.querySelector('[role="log"]')!);
    expect(onFollowChange).toHaveBeenLastCalledWith(true);
    cleanup();
    const on = await mount({ follow: true, onFollowChange });
    expect(on.container.querySelector('[data-slot="log-viewer"]')!.hasAttribute("data-follow")).toBe(true);
    expect([...on.container.querySelectorAll("button")].some((b) => b.textContent === "Follow")).toBe(false);
  });

  test("Download gives the loaded lines as text, with timestamps and marked streams", async () => {
    const onDownload = vi.fn();
    const { container, ref, append } = await mount({ onDownload });
    await append({ ts: "2026-11-20T08:00:01Z", stream: "stdout", text: `${ESC}[1mup${ESC}[0m` }, { ts: "2026-11-20T08:00:02Z", stream: "stderr", text: "boom" });
    await click([...container.querySelectorAll("button")].find((b) => b.textContent === "Download")!);
    expect(onDownload).toHaveBeenCalledWith("2026-11-20 08:00:01 up\n2026-11-20 08:00:02 stderr boom");
    expect(ref.current!.text()).toBe("2026-11-20 08:00:01 up\n2026-11-20 08:00:02 stderr boom");
  });

  test("only the rows in view are rendered", async () => {
    const { container, append } = await mount({ timestamps: false, overscan: 2 });
    await append(...Array.from({ length: 5000 }, (_, i) => ({ text: `line ${i}` })));
    expect(rows(container).length).toBeLessThan(100);
    expect(footer(container)).toContain("5,000 lines");
  });

  test("wrap marks the rows", async () => {
    const { container, append } = await mount({ wrap: true });
    await append({ text: "a very long line" });
    expect(rows(container)[0]!.hasAttribute("data-wrap")).toBe(true);
  });

  test("every class a rendered log uses compiles under the token theme alone", async () => {
    const { container, append } = await mount({ streamColumn: true, streamColors: { stderr: "danger", web: "cat-2" } });
    await append(
      { ts: 1, stream: "stderr", text: `${ESC}[1;3;4;9;31mx${ESC}[0m ${ESC}[7my` },
      { ts: 2, stream: "web", text: `${ESC}[2mdim${ESC}[0m ${ESC}[44mbg` },
    );
    const report = await checkClasses(classesIn(container));
    expect(report.errors).toEqual([]);
  });

  test("has no axe violations, empty and with lines", async () => {
    const { container, append } = await mount({ onDownload: () => {} });
    expect(await axeViolations(container)).toEqual([]);
    await append({ ts: 1, stream: "stderr", text: `${ESC}[31merror${ESC}[0m` }, { ts: 2, text: "ok" });
    expect(await axeViolations(container)).toEqual([]);
  });
});
