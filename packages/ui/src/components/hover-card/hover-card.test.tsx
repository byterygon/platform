import { afterEach, describe, expect, test } from "vitest";
import { $, $$, focus, honoursReducedMotion, hover, key, unhover, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card";

afterEach(cleanup);

function Example() {
  return (
    <p>
      See{" "}
      <HoverCard>
        <HoverCardTrigger href="#orders" delay={0} closeDelay={0}>
          public.orders
        </HoverCardTrigger>
        <HoverCardContent>
          <p>Table, 12 columns.</p>
        </HoverCardContent>
      </HoverCard>
    </p>
  );
}

const link = () => $<HTMLAnchorElement>('[data-slot="hover-card-trigger"]')!;
const card = () => $('[data-slot="hover-card-content"]');

describe("HoverCard", () => {
  test("the trigger is a link; hovering it shows the card and leaving hides it", async () => {
    const { container } = render(<Example />);
    expect(link().tagName).toBe("A");
    expect(link().getAttribute("href")).toBe("#orders");
    await hover(link());
    await waitFor(() => expect(card()).not.toBeNull());
    expect(card()!.textContent).toBe("Table, 12 columns.");
    expect(await axeViolations(container)).toEqual([]);
    await unhover(link());
    await waitFor(() => expect(card()).toBeNull());
  });

  test("keyboard focus on the link shows the card; Escape hides it and focus stays on the link", async () => {
    render(<Example />);
    await focus(link());
    await waitFor(() => expect(card()).not.toBeNull());
    await key("Escape", link());
    await waitFor(() => expect(card()).toBeNull());
    expect(document.activeElement).toBe(link());
  });

  test("takes the link's theme and density, at z.popover", async () => {
    render(<Example />, { theme: "dark", density: "compact" });
    await hover(link());
    await waitFor(() => expect(card()).not.toBeNull());
    const positioner = $('[data-slot="hover-card-positioner"]')!;
    expect(positioner.getAttribute("data-theme")).toBe("dark");
    expect(positioner.getAttribute("data-density")).toBe("compact");
    expect(zLayer(positioner)).toBe(500);
  });

  test("honours reduced motion", async () => {
    render(<Example />);
    await hover(link());
    await waitFor(() => expect(card()).not.toBeNull());
    expect(honoursReducedMotion($$("[data-slot^='hover-card-']"))).toEqual([]);
  });
});
