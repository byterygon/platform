import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Stat, StatDelta, StatDescription, StatLabel, StatValue } from "./stat";

afterEach(cleanup);

describe("Stat", () => {
  test("renders label, value, delta and description", async () => {
    const { container } = render(
      <Stat>
        <StatLabel>Query time</StatLabel>
        <StatValue>38 ms</StatValue>
        <StatDelta trend="up" intent="negative">
          12 %
        </StatDelta>
        <StatDescription>since the previous run</StatDescription>
      </Stat>,
    );
    expect(container.querySelector('[data-slot="stat-value"]')!.className).toContain("tabular-nums");
    const delta = container.querySelector('[data-slot="stat-delta"]') as HTMLElement;
    expect(delta.dataset.intent).toBe("negative");
    expect(delta.textContent).toBe("Up 12 %");
    expect(delta.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("intent defaults from the trend; trendLabel replaces the words", () => {
    const { container } = render(
      <>
        <StatDelta trend="up">1</StatDelta>
        <StatDelta trend="down">2</StatDelta>
        <StatDelta trend="flat" trendLabel="Unchanged">
          3
        </StatDelta>
      </>,
    );
    const deltas = [...container.querySelectorAll<HTMLElement>('[data-slot="stat-delta"]')];
    expect(deltas.map((d) => d.dataset.intent)).toEqual(["positive", "negative", "neutral"]);
    expect(deltas[2]!.textContent).toBe("Unchanged 3");
  });

  test("size and ref", () => {
    const ref = createRef<HTMLDivElement>();
    render(<Stat ref={ref} size="sm" />);
    expect(ref.current?.dataset.size).toBe("sm");
  });
});
