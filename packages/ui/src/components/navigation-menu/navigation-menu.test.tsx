import { afterEach, describe, expect, test } from "vitest";
import { $, $$, click, focus, honoursReducedMotion, key, waitFor, zLayer } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { NavigationMenuRealistic } from "./navigation-menu.example";

afterEach(cleanup);

const trigger = (text: string) => $$<HTMLButtonElement>('[data-slot="navigation-menu-trigger"]').find((element) => element.textContent === text)!;
const panel = () => $('[data-slot="navigation-menu-content"]');

describe("NavigationMenu", () => {
  test("a nav of triggers and links; a trigger opens its panel of links", async () => {
    const { container } = render(<NavigationMenuRealistic />);
    expect($("nav")!.getAttribute("data-slot")).toBe("navigation-menu");
    expect($('[data-slot="navigation-menu-list"]')!.tagName).toBe("UL");
    expect(trigger("Workspace").getAttribute("aria-expanded")).toBe("false");
    expect($$("a").map((a) => a.textContent)).toEqual(["About"]);
    await click(trigger("Workspace"));
    await waitFor(() => expect(panel()).not.toBeNull());
    expect(trigger("Workspace").getAttribute("aria-expanded")).toBe("true");
    const links = $$<HTMLAnchorElement>('[data-slot="navigation-menu-content"] a');
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#connections", "#saved", "#history"]);
    expect(links[0]!.getAttribute("aria-current")).toBe("page");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Escape closes the panel and returns focus to its trigger", async () => {
    render(<NavigationMenuRealistic />);
    await focus(trigger("Administration"));
    // A browser turns Enter on a button into a click; jsdom does not, so open with ArrowDown.
    await key("ArrowDown");
    await waitFor(() => expect(panel()).not.toBeNull());
    await key("Escape");
    await waitFor(() => expect(trigger("Administration").getAttribute("aria-expanded")).toBe("false"));
    await waitFor(() => expect(document.activeElement).toBe(trigger("Administration")));
  });

  test("clicking another trigger switches panels", async () => {
    render(<NavigationMenuRealistic />);
    await click(trigger("Workspace"));
    await waitFor(() => expect(panel()).not.toBeNull());
    await click(trigger("Administration"));
    await waitFor(() => expect(trigger("Administration").getAttribute("aria-expanded")).toBe("true"));
    expect(trigger("Workspace").getAttribute("aria-expanded")).toBe("false");
    await waitFor(() => expect($$('[data-slot="navigation-menu-content"] a').map((a) => a.getAttribute("href"))).toContain("#grants"));
  });

  test("the popup takes the row's theme, at z.popover, and honours reduced motion", async () => {
    render(<NavigationMenuRealistic />, { theme: "dark", density: "compact" });
    await click(trigger("Workspace"));
    await waitFor(() => expect($('[data-slot="navigation-menu-positioner"]')).not.toBeNull());
    const positioner = $('[data-slot="navigation-menu-positioner"]')!;
    expect(positioner.getAttribute("data-theme")).toBe("dark");
    expect(positioner.getAttribute("data-density")).toBe("compact");
    expect(zLayer(positioner)).toBe(500);
    expect(honoursReducedMotion($$("[data-slot^='navigation-menu']"))).toEqual([]);
  });
});
