import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./card";

afterEach(cleanup);

function Full() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>orders-prod</CardTitle>
        <CardDescription>Read-only</CardDescription>
        <CardAction>
          <button type="button">Edit</button>
        </CardAction>
      </CardHeader>
      <CardContent>Body</CardContent>
      <CardFooter>Footer</CardFooter>
    </Card>
  );
}

describe("Card", () => {
  test("renders every part with its slot and element", async () => {
    const { container } = render(<Full />);
    const card = container.querySelector('[data-slot="card"]') as HTMLElement;
    expect(card.dataset.variant).toBe("outline");
    expect(card.querySelector('[data-slot="card-title"]')!.tagName).toBe("H3");
    expect(card.querySelector('[data-slot="card-description"]')!.tagName).toBe("P");
    for (const slot of ["card-header", "card-action", "card-content", "card-footer"]) expect(card.querySelector(`[data-slot="${slot}"]`)).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("variant sets its classes and data-variant", () => {
    const { container } = render(<Card variant="raised">x</Card>);
    const card = container.querySelector('[data-slot="card"]') as HTMLElement;
    expect(card.dataset.variant).toBe("raised");
    expect(card.className).toContain("shadow-raised");
  });

  test("render swaps the element; the ref reaches it", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <Card ref={ref} render={<article />}>
        <CardTitle render={<h2 />}>Title</CardTitle>
      </Card>,
    );
    expect(ref.current?.tagName).toBe("ARTICLE");
    expect(container.querySelector("h2")!.dataset.slot).toBe("card-title");
  });

  test("long titles wrap instead of overflowing", () => {
    const { container } = render(<Full />);
    expect(container.querySelector('[data-slot="card-title"]')!.className).toContain("wrap-break-word");
    expect(container.querySelector('[data-slot="card"]')!.className).toContain("min-w-0");
  });
});
