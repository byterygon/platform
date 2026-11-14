import { afterEach, describe, expect, test, vi } from "vitest";
import { $, $$, click, focus, honoursReducedMotion } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Stepper, stepStatus, type Step } from "./stepper";

afterEach(cleanup);

const steps: Step[] = [{ title: "Details" }, { title: "Approve" }, { title: "Connect", description: "Open a session" }];

describe("Stepper", () => {
  test("an ordered list with the current step marked and each status in words", async () => {
    const { container } = render(<Stepper steps={steps} value={1} aria-label="New connection" />);
    const list = $('[data-slot="stepper"]')!;
    expect(list.tagName).toBe("OL");
    expect(list.getAttribute("aria-label")).toBe("New connection");
    const items = $$('[data-slot="stepper-item"]');
    expect(items.map((item) => item.dataset.status)).toEqual(["complete", "current", "upcoming"]);
    expect(items[1]!.getAttribute("aria-current")).toBe("step");
    expect($$('[data-slot="stepper-text"]').map((text) => text.textContent)).toEqual(["Details, completed", "Approve, current step", "ConnectOpen a session, not started"]);
    expect($('[data-slot="stepper-indicator"]')!.getAttribute("aria-hidden")).toBe("true");
    expect($$('[data-slot="stepper-connector"]')).toHaveLength(2);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("without onValueChange nothing is interactive; with it completed steps are buttons that go back", async () => {
    render(<Stepper steps={steps} value={2} />);
    expect($$("button")).toHaveLength(0);
    cleanup();
    const onValueChange = vi.fn();
    const { container } = render(<Stepper steps={steps} value={2} onValueChange={onValueChange} />);
    const buttons = $$<HTMLButtonElement>('[data-slot="stepper-button"]');
    expect(buttons.map((button) => button.textContent)).toEqual(["Details, completed", "Approve, completed"]);
    await focus(buttons[0]!);
    expect(document.activeElement).toBe(buttons[0]);
    await click(buttons[1]!);
    expect(onValueChange).toHaveBeenCalledWith(1);
    expect(await axeViolations(container)).toEqual([]);
  });

  test("an error step shows as failed; all steps done past the end", () => {
    expect(stepStatus([{ title: "a" }, { title: "b", error: true }], 1, 1)).toBe("error");
    render(<Stepper steps={steps} value={3} orientation="vertical" />);
    expect($$('[data-slot="stepper-item"]').map((item) => item.dataset.status)).toEqual(["complete", "complete", "complete"]);
    expect($('[data-slot="stepper"]')!.dataset.orientation).toBe("vertical");
  });

  test("honours reduced motion", () => {
    render(<Stepper steps={steps} value={1} onValueChange={() => {}} />);
    expect(honoursReducedMotion($$("[data-slot^='stepper']"))).toEqual([]);
  });
});
