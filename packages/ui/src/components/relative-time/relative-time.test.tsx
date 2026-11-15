import { createRef } from "react";
import { act } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { focus, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { formatRelative, refreshInterval, RelativeTime } from "./relative-time";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = Date.UTC(2026, 10, 14, 9, 0, 0);

describe("RelativeTime", () => {
  test("formatRelative picks the largest unit and rounds", () => {
    expect(formatRelative(NOW + 14 * 60_000, NOW, "en")).toBe("in 14 min.");
    expect(formatRelative(NOW - 2000, NOW, "en")).toBe("2 sec. ago");
    expect(formatRelative(NOW - 24 * 3600_000, NOW, "en", "long")).toBe("yesterday");
    expect(formatRelative(NOW, NOW, "en", "long")).toBe("now");
    expect(formatRelative(NOW + 3 * 3600_000, NOW, "en", "long")).toBe("in 3 hours");
  });

  test("refreshInterval tightens near now", () => {
    expect(refreshInterval(NOW + 30_000, NOW)).toBe(1000);
    expect(refreshInterval(NOW + 10 * 60_000, NOW)).toBe(15_000);
    expect(refreshInterval(NOW + 2 * 3600_000, NOW)).toBe(60_000);
  });

  test("renders a <time datetime> with the relative text and the absolute time as hidden text", async () => {
    const { container } = render(<RelativeTime date={NOW + 14 * 60_000} now={NOW} locale="en" timeZone="UTC" />);
    const time = container.querySelector("time")!;
    expect(time.getAttribute("datetime")).toBe("2026-11-14T09:14:00.000Z");
    expect(time.firstChild!.textContent).toBe("in 14 min.");
    expect(time.querySelector(".sr-only")!.textContent).toContain("Nov 14, 2026");
    expect(time.tabIndex).toBe(0);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("focus shows the absolute time in a tooltip", async () => {
    const { container } = render(<RelativeTime date={NOW - 60_000} now={NOW} locale="en" timeZone="UTC" />);
    await focus(container.querySelector("time")!);
    await waitFor(() => expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain("08:59:00"));
  });

  test("keeps the text current while live", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { container } = render(<RelativeTime date={NOW - 5000} locale="en" tooltip={false} />);
    expect(container.querySelector("time")!.firstChild!.textContent).toBe("5 sec. ago");
    for (let tick = 0; tick < 3; tick += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
    }
    expect(container.querySelector("time")!.firstChild!.textContent).toBe("8 sec. ago");
  });

  test("tooltip={false} is not focusable; an invalid date shows a dash; the ref reaches the time", () => {
    const ref = createRef<HTMLTimeElement>();
    const { container } = render(
      <>
        <RelativeTime ref={ref} date={NOW} now={NOW} tooltip={false} />
        <RelativeTime date="not a date" />
      </>,
    );
    expect(ref.current?.tabIndex).toBe(-1);
    expect(container.querySelectorAll('[data-slot="relative-time"]')[1]!.textContent).toBe("—");
  });
});
