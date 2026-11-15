import { createRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { axeViolations, cleanup, render } from "../../../test/render.tsx";
import { DescriptionListDetails, DescriptionListItem, DescriptionList, DescriptionListTerm } from "./description-list";

afterEach(cleanup);

describe("DescriptionList", () => {
  test("renders dl > div > dt + dd", async () => {
    const { container } = render(
      <DescriptionList>
        <DescriptionListItem>
          <DescriptionListTerm>Host</DescriptionListTerm>
          <DescriptionListDetails>db.internal</DescriptionListDetails>
        </DescriptionListItem>
      </DescriptionList>,
    );
    const dl = container.querySelector("dl")!;
    expect(dl.dataset.slot).toBe("description-list");
    expect(dl.dataset.layout).toBe("inline");
    expect(dl.querySelector(":scope > div > dt")!.textContent).toBe("Host");
    expect(dl.querySelector(":scope > div > dd")!.textContent).toBe("db.internal");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("layout, divided and ref", () => {
    const ref = createRef<HTMLDListElement>();
    render(<DescriptionList ref={ref} layout="stacked" divided />);
    expect(ref.current?.dataset.layout).toBe("stacked");
    expect(ref.current?.hasAttribute("data-divided")).toBe(true);
  });

  test("values wrap", () => {
    const { container } = render(
      <DescriptionList>
        <DescriptionListItem>
          <DescriptionListTerm>Digest</DescriptionListTerm>
          <DescriptionListDetails>sha256:abc</DescriptionListDetails>
        </DescriptionListItem>
      </DescriptionList>,
    );
    expect(container.querySelector("dd")!.className).toContain("wrap-break-word");
  });
});
