// The message detail pane (DOC-21 §5.6, TSK-112): beside or below the list, easy to find and to
// grab (a grip, a larger hit area, the keys), maximized and restored (a button, a double click on
// the handle, Alt+Shift+D), and its side, size and maximized state kept per kind of view in the
// workspace settings so a reload brings it back.
import { inThreadArrowDecoder } from "@byterygon/ambidex/arrow-decoder";
import { afterEach, describe, expect, test } from "vitest";
import { ProgressBus } from "@/app/progress";
import { DEFAULT_SETTINGS, StoreProvider, loadPersisted } from "@/app/store";
import { MessageViewer } from "@/messaging/MessageViewer";
import { useLiveTail } from "@/messaging/useLiveTail";
import { MemoryStorage } from "@/profiles/storage";
import { messageCall, messageTable, type TestMessage } from "./support/messages";
import { fake as monaco } from "../../../../packages/ui/test/fakes/monaco.ts";
import { act, axeViolations, byRole, cleanup, click, key, render, settle, waitFor } from "./support/render";

void monaco;
afterEach(cleanup);

const services = { decoder: inThreadArrowDecoder(), progress: new ProgressBus() };
const note = (e: unknown) => ({ title: e instanceof Error ? e.message : String(e) });
const orders: TestMessage[] = [{ partition: 0, offset: 0n, key: "k-0", value: '{"id":"o-0","total":12}', codec: "json" }];
const summary = { scanned: 1, matched: 1, dropped: 0, decodeErrors: 0, endReason: "end" as const, lastPositions: [] };

function Viewer({ paneKey = "nats.subscribe" }: { paneKey?: string }) {
  const built = useMemo(() => messageCall(messageTable(orders), summary), []);
  const tail = useLiveTail(services, (() => built.call) as never, note);
  return <MessageViewer paneKey={paneKey} system="kafka" tail={tail} />;
}
import { useMemo } from "react";

async function mount(storage: MemoryStorage, paneKey?: string) {
  const persisted = await loadPersisted(storage, ["nats"]);
  const view = render(
    <StoreProvider persisted={persisted} storage={storage} saveDelayMs={0}>
      <Viewer {...(paneKey ? { paneKey } : {})} />
    </StoreProvider>,
  );
  await click(byRole("button", /^Start$/));
  await waitFor(() => document.querySelector('[data-slot="resizable"]') !== null, "the split");
  return view;
}

const group = () => document.querySelector<HTMLElement>('[data-slot="resizable"]')!;
const handle = () => document.querySelector<HTMLElement>('[data-slot="resizable-handle"]')!;
const panels = () => [...document.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]')];
const flexOf = (el: HTMLElement) => Number.parseFloat(el.style.flex);
const saved = async (storage: MemoryStorage) => (await storage.getSettings<{ settings: { detailPanes: Record<string, unknown> } }>())?.settings.detailPanes;
const later = () => act(async () => new Promise<void>((r) => setTimeout(r, 20)));

describe("the message detail pane", () => {
  test("starts to the right of a wide list with room for the value; the handle has a grip and a bigger hit area", async () => {
    const { container } = await mount(new MemoryStorage());
    expect(group().getAttribute("data-orientation")).toBe("horizontal");
    expect(panels().map(flexOf)).toEqual([55, 45]);
    expect(handle().querySelector('[data-slot="resizable-grip"]')).not.toBeNull();
    expect(handle().className).toContain("after:-inset-x-[var(--by-size-control-xs)]");
    expect(await axeViolations(container)).toEqual([]);
  });

  test("the toggle puts it below and back; the choice is saved under the view's key", async () => {
    const storage = new MemoryStorage();
    await mount(storage);
    await click(byRole("button", "Show the detail below the list"));
    expect(group().getAttribute("data-orientation")).toBe("vertical");
    // Below the list the detail starts with more of the height: 60 percent.
    expect(panels().map(flexOf)).toEqual([40, 60]);
    await later();
    expect(await saved(storage)).toEqual({ "nats.subscribe": { size: 60, side: "bottom", maximized: false } });
    await click(byRole("button", "Show the detail to the right of the list"));
    expect(group().getAttribute("data-orientation")).toBe("horizontal");
  });

  test("the keys resize it, and the size is kept", async () => {
    const storage = new MemoryStorage();
    await mount(storage);
    const h = handle();
    h.focus();
    await key("ArrowLeft", {}, h);
    await key("ArrowLeft", {}, h);
    expect(panels().map(flexOf)).toEqual([45, 55]);
    await later();
    expect(((await saved(storage)) as Record<string, { size: number }>)["nats.subscribe"]!.size).toBe(55);
  });

  test("the button, a double click on the handle and Alt+Shift+D maximize and restore it", async () => {
    const storage = new MemoryStorage();
    await mount(storage);
    await click(byRole("button", "Maximize the detail"));
    expect(panels().map(flexOf)).toEqual([0, 100]);
    expect(byRole("button", "Restore the detail")?.getAttribute("aria-pressed")).toBe("true");
    expect(handle().getAttribute("aria-disabled")).toBe("true");
    await click(byRole("button", "Restore the detail"));
    expect(panels().map(flexOf)).toEqual([55, 45]);
    await act(async () => {
      handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    expect(panels().map(flexOf)).toEqual([0, 100]);
    await key("d", { altKey: true, shiftKey: true, code: "KeyD" }, document.querySelector('[data-slot="message-viewer"]'));
    expect(panels().map(flexOf)).toEqual([55, 45]);
    await later();
    expect(((await saved(storage)) as Record<string, { maximized: boolean }>)["nats.subscribe"]!.maximized).toBe(false);
  });

  test("a reload brings back the side, the size and the maximized state; another kind of view has its own", async () => {
    const storage = new MemoryStorage();
    const first = await mount(storage);
    await click(byRole("button", "Show the detail below the list"));
    handle().focus();
    await key("ArrowUp", {}, handle());
    await click(byRole("button", "Maximize the detail"));
    await later();
    first.unmount();
    await mount(storage);
    expect(group().getAttribute("data-orientation")).toBe("vertical");
    expect(panels().map(flexOf)).toEqual([0, 100]);
    await click(byRole("button", "Restore the detail"));
    // Below the list: 60 percent for the detail, then one key press up gave it 5 more.
    expect(panels().map(flexOf)).toEqual([35, 65]);
    cleanup();
    await mount(storage, "nats.kv");
    expect(group().getAttribute("data-orientation")).toBe("horizontal");
    expect(panels().map(flexOf)).toEqual([55, 45]);
  });

  test("a damaged setting is read as the defaults", async () => {
    const storage = new MemoryStorage();
    await storage.putSettings({ version: 1, settings: { detailPanes: { a: { size: 3, side: "left", maximized: "yes" }, b: { size: 61.5, side: "right", maximized: true }, c: 7, d: null } } });
    const p = await loadPersisted(storage, ["nats"]);
    expect(p.settings.detailPanes).toEqual({ a: { size: 20, side: null, maximized: false }, b: { size: 61.5, side: "right", maximized: true } });
    expect(DEFAULT_SETTINGS.detailPanes).toEqual({});
    await settle();
  });
});
