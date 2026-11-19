import { act, createRef, useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { $, $$, click, focus, honoursReducedMotion, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { BreadcrumbMinimal, BreadcrumbRealistic } from "./breadcrumb.example";
import { Breadcrumb, BreadcrumbEllipsis, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, foldBreadcrumb, useBreadcrumbOverflow } from "./breadcrumb";

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

  test("the first places fold when the trail does not fit; the last two always show", () => {
    expect(foldBreadcrumb([50, 50, 50, 50], 200, 20)).toEqual([]);
    expect(foldBreadcrumb([50, 50, 50, 50], 199, 20)).toEqual([0]);
    expect(foldBreadcrumb([50, 50, 50, 50], 120, 20)).toEqual([0, 1]);
    // Never the last two, however narrow.
    expect(foldBreadcrumb([50, 50, 50, 50], 10, 20)).toEqual([0, 1]);
    expect(foldBreadcrumb([50, 50, 50, 50], 10, 20, 1)).toEqual([1]);
  });

  test("useBreadcrumbOverflow measures the items once per set of labels and follows the width", async () => {
    // jsdom lays nothing out: each item says its width.
    const rect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function () {
      const width = Number(this.getAttribute("data-w") ?? 0);
      return { width, height: 20, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 20, toJSON: () => ({}) } as DOMRect;
    };
    try {
      const labels = ["build-host", "Containers", "shop", "shop-api-1", "Logs"];
      let setRoom: (n: number) => void = () => {};
      function Trail() {
        const [available, set] = useState(400);
        setRoom = set;
        const { ref, hidden } = useBreadcrumbOverflow({ count: labels.length, signature: labels.join("/"), available });
        return (
          <Breadcrumb>
            <BreadcrumbList ref={ref} className="flex-nowrap">
              {labels.map((label, i) =>
                hidden.includes(i) ? (
                  i === hidden[0] ? (
                    <BreadcrumbItem key="more" data-breadcrumb-overflow="" data-w="20">
                      <BreadcrumbEllipsis />
                    </BreadcrumbItem>
                  ) : null
                ) : (
                  <BreadcrumbItem key={label} data-breadcrumb-index={i} data-w="60">
                    {i === labels.length - 1 ? <BreadcrumbPage>{label}</BreadcrumbPage> : <BreadcrumbLink href={`#${label}`}>{label}</BreadcrumbLink>}
                  </BreadcrumbItem>
                ),
              )}
            </BreadcrumbList>
          </Breadcrumb>
        );
      }
      render(<Trail />);
      const rerender = (n: number) => act(() => setRoom(n));
      const shownLabels = () => $$("[data-slot=breadcrumb-link], [data-slot=breadcrumb-page]").map((el) => el.textContent);
      expect(shownLabels()).toEqual(labels);
      expect($('[data-slot="breadcrumb-ellipsis"]')).toBeNull();
      rerender(200);
      await waitFor(() => expect(shownLabels()).toEqual(["shop", "shop-api-1", "Logs"]));
      expect($('[data-slot="breadcrumb-ellipsis"]')!.textContent).toBe("More places");
      rerender(100);
      await waitFor(() => expect(shownLabels()).toEqual(["shop-api-1", "Logs"]));
      rerender(300);
      await waitFor(() => expect(shownLabels()).toEqual(labels));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = rect;
    }
  });

  test("honours reduced motion", () => {
    render(<BreadcrumbMinimal />);
    expect(honoursReducedMotion($$("[data-slot^='breadcrumb']"))).toEqual([]);
  });
});
