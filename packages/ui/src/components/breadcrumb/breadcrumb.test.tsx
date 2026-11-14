import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { $, $$, click, focus, honoursReducedMotion, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { BreadcrumbMinimal, BreadcrumbRealistic } from "./breadcrumb.example";
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList } from "./breadcrumb";

afterEach(cleanup);

describe("Breadcrumb", () => {
  test("a nav landmark with an ordered list, links, and the current page", async () => {
    const { container } = render(<BreadcrumbMinimal />);
    const nav = $("nav")!;
    expect(nav.getAttribute("aria-label")).toBe("Breadcrumb");
    expect($('[data-slot="breadcrumb-list"]')!.tagName).toBe("OL");
    expect($$("a").map((a) => a.getAttribute("href"))).toEqual(["#orders-prod", "#public"]);
    const page = $('[data-slot="breadcrumb-page"]')!;
    expect(page.getAttribute("aria-current")).toBe("page");
    expect(page.closest("a")).toBeNull();
    for (const separator of $$('[data-slot="breadcrumb-separator"]')) expect(separator.getAttribute("aria-hidden")).toBe("true");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("links are reachable by Tab order and focusable; render swaps the element and keeps the ref", async () => {
    const ref = createRef<HTMLAnchorElement>();
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink ref={ref} render={<button type="button" />}>
              Workspace
            </BreadcrumbLink>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );
    expect(ref.current!.tagName).toBe("BUTTON");
    expect(ref.current!.getAttribute("data-slot")).toBe("breadcrumb-link");
    await focus(ref.current!);
    expect(document.activeElement).toBe(ref.current);
  });

  test("the collapsed middle is a named menu button listing the hidden places; Escape returns focus", async () => {
    const { container } = render(<BreadcrumbRealistic />);
    const trigger = $<HTMLButtonElement>('[aria-label="Show collapsed places"]')!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect($('[data-slot="breadcrumb-ellipsis"]')!.textContent).toBe("More places");
    trigger.focus();
    await click(trigger);
    expect($$('[role="menuitem"]').map((item) => item.textContent)).toEqual(["orders-prod", "public", "Tables"]);
    await key("Escape");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(await axeViolations(container)).toEqual([]);
  });

  test("honours reduced motion", () => {
    render(<BreadcrumbMinimal />);
    expect(honoursReducedMotion($$("[data-slot^='breadcrumb']"))).toEqual([]);
  });
});
