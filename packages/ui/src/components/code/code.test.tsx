import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Code } from "./code";

afterEach(cleanup);

describe("Code", () => {
  test("renders a <code> in the code-sm role that breaks long values", async () => {
    const { container } = render(
      <p>
        <Code>42P01</Code> relation does not exist
      </p>,
    );
    const code = container.querySelector("code")!;
    expect(code.dataset.slot).toBe("code");
    expect(code.className).toContain("text-code-sm");
    expect(code.className).toContain("break-all");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("variant, render and ref", () => {
    const ref = createRef<HTMLElement>();
    const { container } = render(
      <Code ref={ref} variant="plain" render={<samp />}>
        SELECT 1
      </Code>,
    );
    expect(ref.current?.tagName).toBe("SAMP");
    expect(container.querySelector("samp")!.className).not.toContain("bg-inset");
  });
});
