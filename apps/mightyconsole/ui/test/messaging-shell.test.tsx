// The echo tool's Messages and Composer tabs through the shell (TSK-80, Mightyconsole spec §5.8):
// the test backend's tail shows in the MessageViewer with the filter applied on the server, and the
// Composer sends through echo.messages.produce.
import { act } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { App } from "@/app/App";
import { ServicesContext } from "@/app/client";
import { loadPersisted, StoreProvider } from "@/app/store";
import type { ProfileRecord } from "@/profiles/record";
import { ipcChunks } from "../../../../packages/data-grid/test/support.ts";
import { createFakeServices } from "./support/fake-services";
import { messageTable } from "./support/messages";
import { axeViolations, byRole, byText, cleanup, click, editorArea, render, settle, type, waitFor } from "./support/render";

afterEach(cleanup);

type Fake = ReturnType<typeof createFakeServices>;

async function mount(fake: Fake) {
  const persisted = await loadPersisted(fake.storage, ["echo"]);
  const view = render(
    <ServicesContext.Provider value={fake.services}>
      <StoreProvider persisted={persisted} storage={fake.storage} saveDelayMs={0}>
        <App />
      </StoreProvider>
    </ServicesContext.Provider>,
  );
  await waitFor(() => fake.server.calls.some((c) => c.procedure === "app.events"), "the events subscription");
  return view;
}

const treeItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]")).find((el) => el.textContent?.includes(label)) ?? null;
async function doubleClick(el: Element | null) {
  if (!el) throw new Error("nothing to double-click");
  await click(el);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}

async function setup() {
  const fake = createFakeServices();
  const record: ProfileRecord = { id: "01PLAB", tool: "echo", version: 1, name: "lab", createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z", fields: { greeting: "" }, secrets: {}, extras: {} };
  await fake.storage.putProfile(record);
  fake.server.messageChunks = ipcChunks(messageTable([{ partition: 0, offset: 0n, value: '{"id":"o-1"}' }, { partition: 1, offset: 0n, value: '{"id":"o-2"}' }]));
  const view = await mount(fake);
  await doubleClick(treeItem("lab"));
  await waitFor(() => treeItem("Messages") !== null, "the resource tree");
  return { fake, ...view };
}

describe("echo's messaging tabs", () => {
  test("Messages: Start tails the topic in the MessageViewer with the decode options and the filter", async () => {
    const { fake, container } = await setup();
    await doubleClick(treeItem("Messages"));
    await waitFor(() => byRole("tab", /Messages · lab/) !== null, "the Messages tab");
    await waitFor(() => editorArea("jq") !== null, "the jq editor");
    await type(editorArea("jq")!, ".value.id == \"o-2\"");
    await click(byRole("button", "Apply"));
    await click(byRole("button", "Start"));
    await waitFor(() => byText("2 records shown") !== null, "the rows");
    const call = fake.server.calls.find((c) => c.procedure === "echo.messages.tail")!.input as Record<string, unknown>;
    expect(call["start"]).toEqual({ kind: "latestN", n: 100 });
    expect(call["follow"]).toBe(true);
    expect(call["filter"]).toEqual({ jq: '.value.id == "o-2"' });
    expect(call["decode"]).toEqual({ key: { codec: "auto" }, value: { codec: "auto" } });
    expect(await axeViolations(container)).toEqual([]);
  });

  test("Composer: Send produces to the topic with the key, headers and payload", async () => {
    const { fake } = await setup();
    await doubleClick(treeItem("Composer"));
    await waitFor(() => byRole("tab", /Composer · lab/) !== null, "the Composer tab");
    const key = [...document.querySelectorAll<HTMLInputElement>("input")].find((i) => i.labels?.[0]?.textContent === "Key")!;
    await type(key, "k-9");
    await click(byRole("button", "Add header"));
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Name 1"]')!, "trace");
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Value 1"]')!, "abc");
    await click(byRole("button", /^Send$/));
    await waitFor(() => fake.server.produced.length === 1, "the produce call");
    expect(fake.server.produced[0]).toMatchObject({ partition: null, key: { codec: "utf8", text: "k-9" }, headers: [{ key: "trace", value: "abc", encoding: "text" }], value: { codec: "json" } });
    await waitFor(() => byText(/Written to partition 0 at offset 0/) !== null, "the result");
  });
});
