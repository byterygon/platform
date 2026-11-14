import { createRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { click, honoursReducedMotion, waitFor } from "../../../test/interact.ts";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { Accordion, AccordionItem, AccordionPanel, AccordionTrigger } from "./accordion";

afterEach(cleanup);

function Settings(props: { multiple?: boolean; onValueChange?: (value: unknown[]) => void; defaultValue?: string[] }) {
  return (
    <Accordion {...props}>
      {["network", "grant", "audit"].map((value) => (
        <AccordionItem key={value} value={value} disabled={value === "audit"}>
          <AccordionTrigger>{value}</AccordionTrigger>
          <AccordionPanel>{`${value} panel`}</AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

const triggers = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[data-slot="accordion-trigger"]')];

describe("Accordion", () => {
  test("each trigger is a button inside a heading, with aria-expanded", async () => {
    const { container } = render(<Settings />);
    const [first] = triggers(container);
    expect(first!.parentElement!.tagName).toBe("H3");
    expect(first!.getAttribute("aria-expanded")).toBe("false");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("opening one section closes the other unless multiple", async () => {
    const { container } = render(<Settings />);
    const [network, grant] = triggers(container);
    await click(network!);
    await waitFor(() => expect(network!.getAttribute("aria-expanded")).toBe("true"));
    await click(grant!);
    await waitFor(() => expect(grant!.getAttribute("aria-expanded")).toBe("true"));
    expect(network!.getAttribute("aria-expanded")).toBe("false");
  });

  test("multiple keeps several open; onValueChange reports the open values", async () => {
    const onValueChange = vi.fn();
    const { container } = render(<Settings multiple defaultValue={["network"]} onValueChange={onValueChange} />);
    const [network, grant] = triggers(container);
    await click(grant!);
    await waitFor(() => expect(onValueChange).toHaveBeenLastCalledWith(["network", "grant"], expect.anything()));
    expect(network!.getAttribute("aria-expanded")).toBe("true");
  });

  test("every trigger is a native button in the tab order (Enter and Space come with it)", () => {
    const { container } = render(<Settings />);
    for (const trigger of triggers(container)) {
      expect(trigger.type).toBe("button");
      expect(trigger.tabIndex).toBe(0);
    }
  });

  test("a disabled item does not open", async () => {
    const { container } = render(<Settings />);
    const audit = triggers(container)[2]!;
    await click(audit);
    expect(audit.getAttribute("aria-expanded")).toBe("false");
  });

  test("variant and ref reach the root; reduced motion is honoured", () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <Accordion ref={ref} variant="outline" defaultValue={["a"]}>
        <AccordionItem value="a">
          <AccordionTrigger>A</AccordionTrigger>
          <AccordionPanel>Panel</AccordionPanel>
        </AccordionItem>
      </Accordion>,
    );
    expect(ref.current?.dataset.variant).toBe("outline");
    expect(honoursReducedMotion([...container.querySelectorAll("[data-slot]")])).toEqual([]);
  });
});
