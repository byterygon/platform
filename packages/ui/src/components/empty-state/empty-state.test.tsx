import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { EmptyState, EmptyStateActions, EmptyStateDescription, EmptyStateIcon, EmptyStateTitle } from "./empty-state";

afterEach(cleanup);

describe("EmptyState", () => {
  test("renders its parts: a hidden icon, a heading, a description and actions", async () => {
    const { container } = render(
      <EmptyState>
        <EmptyStateIcon>
          <svg aria-hidden="true" />
        </EmptyStateIcon>
        <EmptyStateTitle>No connections yet</EmptyStateTitle>
        <EmptyStateDescription>Add one.</EmptyStateDescription>
        <EmptyStateActions>
          <button type="button">Add connection</button>
        </EmptyStateActions>
      </EmptyState>,
    );
    const root = container.querySelector('[data-slot="empty-state"]') as HTMLElement;
    expect(root.dataset.variant).toBe("centered");
    expect(root.querySelector('[data-slot="empty-state-icon"]')!.getAttribute("aria-hidden")).toBe("true");
    expect(root.querySelector('[data-slot="empty-state-title"]')!.tagName).toBe("H3");
    expect(root.querySelector('[data-slot="empty-state-description"]')!.tagName).toBe("P");
    expect(root.querySelector('[data-slot="empty-state-actions"] button')).not.toBeNull();
    expect(await axeViolations(container)).toEqual([]);
  });

  test("inline variant; render swaps the title element; the ref reaches the root", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <EmptyState ref={ref} variant="inline">
        <EmptyStateTitle render={<p />}>No matches</EmptyStateTitle>
      </EmptyState>,
    );
    expect(ref.current?.dataset.variant).toBe("inline");
    expect(container.querySelector('[data-slot="empty-state-title"]')!.tagName).toBe("P");
  });
});
