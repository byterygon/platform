import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { ArrowSortDown, ChevronDown, ColumnTriple, Database, ICON_NAMES, SignOut, type IconDefinition } from "@/lib/icons";
import * as icons from "@/lib/icons";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Icon, iconArtwork, iconArtworkSize, iconVariants } from "./icon";

afterEach(cleanup);

const svgOf = (container: HTMLElement) => container.querySelector('[data-slot="icon"]') as SVGSVGElement;

describe("Icon", () => {
  test("renders the Fluent artwork as an inline svg in currentColor, decorative by default", () => {
    const { container } = render(<Icon icon={ChevronDown} />);
    const svg = svgOf(container);
    expect(svg.tagName.toLowerCase()).toBe("svg");
    expect(svg.getAttribute("viewBox")).toBe("0 0 16 16");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    expect(svg.dataset.icon).toBe("chevron-down");
    expect([...svg.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(ChevronDown.regular[16]);
    expect(svg.getAttribute("class")).toContain("size-icon-md");
  });

  test("a label names it as an image", () => {
    const { container } = render(<Icon icon={Database} label="Database" />);
    const svg = svgOf(container);
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("Database");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });

  test("each size takes the smallest Fluent drawing at least as large, filled takes the solid artwork", () => {
    expect(iconArtworkSize).toEqual({ xs: 16, sm: 16, md: 16, lg: 20, xl: 24 });
    for (const [size, drawn] of Object.entries(iconArtworkSize)) {
      const { container } = render(<Icon icon={Database} size={size as keyof typeof iconArtworkSize} filled />);
      const svg = svgOf(container);
      expect(svg.getAttribute("viewBox")).toBe(`0 0 ${drawn} ${drawn}`);
      expect(svg.getAttribute("class")).toContain(`size-icon-${size}`);
      expect(svg.hasAttribute("data-filled")).toBe(true);
      expect([...svg.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(Database.filled[drawn]);
      cleanup();
    }
  });

  test("a size Fluent did not draw falls back to the nearest drawing", () => {
    // column-triple has only 20 and 24 px drawings; sign-out only 20 and 24.
    expect(iconArtwork(ColumnTriple, 16, false).size).toBe(20);
    expect(iconArtwork(SignOut, 16, true).size).toBe(20);
    expect(iconArtwork(ArrowSortDown, 24, false).size).toBe(24);
    const regularOnly: IconDefinition = { name: "x", regular: { 20: ["M0 0h1"] }, filled: {} };
    expect(iconArtwork(regularOnly, 16, true)).toEqual({ size: 20, paths: ["M0 0h1"] });
  });

  test("tone colours it with a text role; inherit keeps the surrounding colour", () => {
    const { container } = render(<Icon icon={Database} tone="danger" />);
    expect(svgOf(container).getAttribute("class")).toContain("text-danger-fg");
    expect(iconVariants.tone.inherit).toBe("");
  });

  test("forwards the ref and extra props to the svg", () => {
    const ref = createRef<SVGSVGElement>();
    const { container } = render(<Icon icon={Database} ref={ref} className="opacity-[var(--by-opacity-disabled)]" data-testid="db" />);
    expect(ref.current).toBe(svgOf(container));
    expect(svgOf(container).getAttribute("data-testid")).toBe("db");
  });

  test("every vendored icon has regular and filled artwork and is exported under its Fluent name", () => {
    const exported = icons as unknown as Record<string, IconDefinition>;
    const byName = new Map(Object.values(exported).filter((value): value is IconDefinition => typeof value === "object" && value !== null && "regular" in value).map((icon) => [icon.name, icon]));
    expect([...byName.keys()].sort()).toEqual([...ICON_NAMES].sort());
    for (const icon of byName.values()) {
      expect(Object.keys(icon.regular).length, icon.name).toBeGreaterThan(0);
      expect(Object.keys(icon.filled).length, icon.name).toBeGreaterThan(0);
    }
  });

  test("has no axe violations, decorative or named", async () => {
    const { container } = render(
      <p>
        <Icon icon={Database} /> orders <Icon icon={Database} label="Database" />
      </p>,
    );
    expect(await axeViolations(container)).toEqual([]);
  });
});
