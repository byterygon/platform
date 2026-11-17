import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click, focus, key, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Toolbar, ToolbarButton, ToolbarGroup, ToolbarInput, ToolbarSeparator } from "./toolbar";

afterEach(cleanup);

function Tools({ onRun }: { onRun?: () => void }) {
  return (
    <Toolbar aria-label="Query tools">
      <ToolbarGroup>
        <ToolbarButton onClick={onRun}>Run</ToolbarButton>
        <ToolbarButton disabled focusableWhenDisabled>
          Cancel
        </ToolbarButton>
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarButton>Format</ToolbarButton>
      <ToolbarInput aria-label="Row limit" defaultValue="1000" />
    </Toolbar>
  );
}

const buttons = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-slot="toolbar-button"]')];

describe("Toolbar", () => {
  test("is a labelled role=toolbar with a single tab stop", async () => {
    const { container } = render(<Tools />);
    const toolbar = container.querySelector('[data-slot="toolbar"]')!;
    expect(toolbar.getAttribute("role")).toBe("toolbar");
    expect(toolbar.getAttribute("aria-label")).toBe("Query tools");
    const tabbable = [...container.querySelectorAll<HTMLElement>("button, input")].filter((el) => el.tabIndex === 0);
    expect(tabbable).toHaveLength(1);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("arrow keys move focus between items and reach a disabled one", async () => {
    const { container } = render(<Tools />);
    const [run, cancel, format] = buttons(container);
    await focus(run!);
    await key("ArrowRight", run!);
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(cancel!.getAttribute("aria-disabled")).toBe("true");
    await key("ArrowRight", cancel!);
    await waitFor(() => expect(document.activeElement).toBe(format));
    const input = container.querySelector<HTMLElement>('[data-slot="toolbar-input"]')!;
    await key("ArrowRight", format!);
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  test("a button click runs its handler; the separator is perpendicular", async () => {
    const onRun = vi.fn();
    const { container } = render(<Tools onRun={onRun} />);
    await click(buttons(container)[0]!);
    expect(onRun).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-slot="toolbar-separator"]')!.getAttribute("aria-orientation")).toBe("vertical");
  });

  test("variant and orientation reach the root; the ref too", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <Toolbar ref={ref} variant="plain" orientation="vertical" aria-label="Panel">
        <ToolbarButton>A</ToolbarButton>
      </Toolbar>,
    );
    expect(ref.current?.dataset.variant).toBe("plain");
    expect(container.querySelector('[data-slot="toolbar"]')!.getAttribute("aria-orientation")).toBe("vertical");
  });

  test("a group follows its own toolbar's orientation, not an ancestor's", () => {
    const group = (container: HTMLElement) => container.querySelector<HTMLElement>('[data-slot="toolbar-group"]')!;
    const horizontal = render(
      <div data-orientation="vertical">
        <Toolbar aria-label="Row">
          <ToolbarGroup>
            <ToolbarButton>A</ToolbarButton>
          </ToolbarGroup>
        </Toolbar>
      </div>,
    );
    expect(group(horizontal.container).dataset.orientation).toBe("horizontal");
    const vertical = render(
      <div data-orientation="horizontal">
        <Toolbar aria-label="Column" orientation="vertical">
          <ToolbarGroup>
            <ToolbarButton>A</ToolbarButton>
          </ToolbarGroup>
        </Toolbar>
      </div>,
    );
    expect(group(vertical.container).dataset.orientation).toBe("vertical");
    // The stacking classes key on the group's own attribute, never on any ancestor's.
    expect(group(vertical.container).className).toContain("data-[orientation=vertical]:flex-col");
    expect(group(vertical.container).className).not.toContain("in-data-[orientation");
  });
});
