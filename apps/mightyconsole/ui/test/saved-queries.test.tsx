// Saved queries under Workflows in the Temporal tree (TSK-95, mockup frame temporal-workflows):
// renamed and deleted from the node's context menu, through the shell's question dialogs.
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ConnectionList } from "@/app/sidebar/ConnectionList";
import type { ProfileRecord } from "@/profiles/record";
import { temporalTool } from "@/tools/temporal";
import { renameError, renameSaved, savedQueryActions } from "@/tools/temporal/list-parts";
import { profile as schema, savedQueriesOf } from "@/tools/temporal/profile";
import { act, byRole, byText, cleanup, click, dialogWith, render, settle, type, waitFor } from "./support/render";

afterEach(cleanup);

const SAVED = [
  { name: "Failed today", query: 'ExecutionStatus = "Failed"' },
  { name: "Slow orders", query: "ExecutionDuration > 600000000000" },
];

describe("saved query helpers", () => {
  test("rename keeps the place and the query; a clash or an empty name is refused", () => {
    expect(renameSaved(SAVED, "Failed today", "Failures")).toEqual([{ name: "Failures", query: 'ExecutionStatus = "Failed"' }, SAVED[1]]);
    expect(renameSaved(SAVED, "Gone", "X")).toEqual(SAVED);
    expect(renameError(SAVED, "Failed today", "Slow orders")).toBe('A saved query is already named "Slow orders".');
    expect(renameError(SAVED, "Failed today", "Failed today")).toBeNull();
    expect(renameError(SAVED, "Failed today", "")).toBe("A name is required.");
  });

  test("the tree's saved query nodes carry Rename and Delete", async () => {
    let record = { extras: { savedQueries: SAVED } } as unknown as ProfileRecord;
    const updateProfile = async (change: (r: ProfileRecord) => ProfileRecord) => {
      record = change(record);
    };
    const [rename, remove] = savedQueryActions("Failed today", SAVED);
    expect(rename!.prompt?.validate?.("Slow orders")).not.toBeNull();
    await rename!.run({ value: "Failures", updateProfile });
    expect(savedQueriesOf(record.extras).map((s) => s.name)).toEqual(["Failures", "Slow orders"]);
    await remove!.run({ value: "", updateProfile });
    // "Failed today" is gone already (renamed), so Delete leaves the list as it is.
    expect(savedQueriesOf(record.extras).map((s) => s.name)).toEqual(["Failures", "Slow orders"]);
    await savedQueryActions("Slow orders", SAVED)[1]!.run({ value: "", updateProfile });
    expect(savedQueriesOf(record.extras).map((s) => s.name)).toEqual(["Failures"]);
  });
});

const treeItem = (label: string) => Array.from(document.querySelectorAll<HTMLElement>("[role=treeitem]")).find((el) => el.textContent?.trim().startsWith(label)) ?? null;

async function contextMenu(el: HTMLElement) {
  await click(el);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
  await settle(2);
}

function mount() {
  const base: ProfileRecord = { id: "01T", tool: "temporal", version: 1, name: "lab", createdAt: "x", updatedAt: "x", ...schema.defaults() };
  const initial: ProfileRecord = { ...base, extras: { ...base.extras, savedQueries: SAVED } };
  const onUpdateProfile = vi.fn<(id: string, change: (r: ProfileRecord) => ProfileRecord) => Promise<void>>();
  function Harness() {
    const [record, setRecord] = useState(initial);
    const [selected, setSelected] = useState<string | null>(null);
    onUpdateProfile.mockImplementation(async (_id, change) => setRecord((r) => change(r)));
    return (
      <ConnectionList
        tool={temporalTool}
        profiles={[record]}
        recordStates={{}}
        conns={{ "01T": { status: "connected", connId: "c1" } }}
        selected={selected}
        onSelect={setSelected}
        onConnect={async () => true}
        onDisconnect={() => {}}
        onOpenResource={() => {}}
        onAdd={() => {}}
        onImport={() => {}}
        onEdit={() => {}}
        onDuplicate={() => {}}
        onExport={() => {}}
        onDelete={() => {}}
        onUpdateProfile={onUpdateProfile}
      />
    );
  }
  render(<Harness />);
  return { onUpdateProfile };
}

describe("the tree's context menu on a saved query", () => {
  test("Rename asks a name, refuses a clash, and renames in the profile; Delete confirms first", async () => {
    const { onUpdateProfile } = mount();
    // Open the profile: its namespace and Workflows open by themselves, with the saved queries.
    await act(async () => {
      document.querySelector<HTMLElement>("[role=treeitem]")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => treeItem("Failed today") !== null, "the saved queries");

    await contextMenu(treeItem("Failed today")!);
    await click(byRole("menuitem", "Rename saved query…"));
    await waitFor(() => dialogWith('Rename "Failed today"') !== null, "the rename dialog");
    const field = dialogWith('Rename "Failed today"')!.querySelector("input")!;
    expect(field.value).toBe("Failed today");
    await type(field, "Slow orders");
    expect(byText('A saved query is already named "Slow orders".')).not.toBeNull();
    expect((byRole("button", "Rename") as HTMLButtonElement).disabled).toBe(true);
    await type(field, "Failures");
    await click(byRole("button", "Rename"));
    await waitFor(() => treeItem("Failures") !== null, "the renamed node");
    expect(onUpdateProfile).toHaveBeenCalledTimes(1);
    expect(dialogWith('Rename "Failed today"')).toBeNull();

    await contextMenu(treeItem("Slow orders")!);
    await click(byRole("menuitem", "Delete saved query…"));
    await waitFor(() => dialogWith('Delete the saved query "Slow orders"?') !== null, "the confirmation");
    expect(onUpdateProfile).toHaveBeenCalledTimes(1);
    await click(byRole("button", "Delete"));
    await waitFor(() => treeItem("Slow orders") === null, "the node gone");
    expect(treeItem("Failures")).not.toBeNull();
  });

  test("a node without items shows only the shell's menu", async () => {
    mount();
    await act(async () => {
      document.querySelector<HTMLElement>("[role=treeitem]")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    });
    await waitFor(() => treeItem("Schedules") !== null, "the tree");
    await contextMenu(treeItem("Schedules")!);
    expect(byRole("menuitem", "Open")).not.toBeNull();
    expect(byRole("menuitem", "Rename saved query…")).toBeNull();
  });
});
