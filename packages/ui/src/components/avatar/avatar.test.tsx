import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { act } from "react";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Avatar, initials } from "./avatar";

afterEach(cleanup);

describe("Avatar", () => {
  test("is an image named by `name` showing its initials", async () => {
    const { container } = render(<Avatar name="Uy Son" />);
    await act(async () => {});
    const root = container.querySelector('[data-slot="avatar"]')!;
    expect(root.getAttribute("role")).toBe("img");
    expect(root.getAttribute("aria-label")).toBe("Uy Son");
    const fallback = container.querySelector('[data-slot="avatar-fallback"]')!;
    expect(fallback.textContent).toBe("US");
    expect(fallback.getAttribute("aria-hidden")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("initials take the first letters of the first and last words", () => {
    expect(initials("Uy Son")).toBe("US");
    expect(initials("orders-prod")).toBe("OP");
    expect(initials("analytics_warehouse_replica")).toBe("AR");
    expect(initials("dba")).toBe("DB");
    expect(initials("  ")).toBe("");
  });

  test("an image is not shown until it has loaded (jsdom never loads it): the fallback stays", async () => {
    const { container } = render(<Avatar name="Uy Son" src="data:image/png;base64,AAAA" />);
    await act(async () => {});
    expect(container.querySelector('[data-slot="avatar-fallback"]')).not.toBeNull();
  });

  test("custom fallback, size, shape and ref", async () => {
    const ref = createRef<HTMLSpanElement>();
    const { container } = render(<Avatar ref={ref} name="orders-prod" fallback={<b>DB</b>} size="lg" shape="square" />);
    await act(async () => {});
    expect(ref.current?.dataset.shape).toBe("square");
    expect(container.querySelector('[data-slot="avatar-fallback"]')!.textContent).toBe("DB");
  });
});
