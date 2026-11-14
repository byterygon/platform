import { afterEach, describe, expect, test } from "vitest";
import { themeScopeOf, tokenPx, useThemeScope } from "@/lib/theme-scope";
import { act, cleanup, render } from "./render.tsx";

afterEach(cleanup);

const tree = (html: string) => {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.append(host);
  return { host, target: host.querySelector("#target")!, remove: () => host.remove() };
};

describe("themeScopeOf", () => {
  test("takes the nearest data-theme and data-density, which may sit on different elements", () => {
    const { target, remove } = tree(`<div data-density="compact"><section data-theme="light"><div data-theme="dark"><button id="target"></button></div></section></div>`);
    expect(themeScopeOf(target)).toEqual({ "data-theme": "dark", "data-density": "compact" });
    remove();
  });

  test("reads shadcn's .dark and .light classes as themes", () => {
    const { target, remove } = tree(`<div class="dark"><button id="target"></button></div>`);
    expect(themeScopeOf(target)).toEqual({ "data-theme": "dark" });
    remove();
  });

  test("is empty without an element or without attributes, so the page defaults apply", () => {
    const { target, remove } = tree(`<div><button id="target"></button></div>`);
    expect(themeScopeOf(target)).toEqual({});
    expect(themeScopeOf(null)).toEqual({});
    remove();
  });
});

describe("tokenPx", () => {
  test("reads a px variable at the element, or falls back", () => {
    const { target, remove } = tree(`<div style="--by-space-inline-xs: 2px"><span id="target"></span></div>`);
    expect(tokenPx(target, "--by-space-inline-xs", 4)).toBe(2);
    expect(tokenPx(target, "--by-space-inline-sm", 4)).toBe(4);
    expect(tokenPx(null, "--by-space-inline-xs", 4)).toBe(4);
    remove();
  });
});

describe("useThemeScope", () => {
  test("reads the scope when the anchor mounts, refreshes on demand and sets the forwarded ref", async () => {
    const forwarded: { current: HTMLButtonElement | null } = { current: null };
    let api: ReturnType<typeof useThemeScope<HTMLButtonElement>> | undefined;
    function Probe() {
      api = useThemeScope<HTMLButtonElement>(forwarded);
      return <button ref={api.ref} type="button" data-scope={JSON.stringify(api.scope)} />;
    }
    const { container } = render(
      <div data-theme="dark">
        <Probe />
      </div>,
    );
    const button = container.querySelector("button")!;
    expect(forwarded.current).toBe(button);
    expect(api!.anchor.current).toBe(button);
    expect(JSON.parse(button.dataset.scope!)).toEqual({ "data-theme": "dark", "data-density": "comfortable" });
    button.parentElement!.setAttribute("data-theme", "light");
    await act(async () => api!.refresh());
    expect(JSON.parse(button.dataset.scope!)).toEqual({ "data-theme": "light", "data-density": "comfortable" });
  });
});
