// "Move my profiles to the server" (TSK-135 §8, DOC-25 §3.4.9, TSK-140 batch 4c): the three steps,
// the choice per profile (selection, personal or shared, the name on the server), a name the server
// already has renamed before the move, Stop, and a failure part way.
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MoveDialog, type MoveDialogProps, type MovePlan, type MoveRun } from "@/app/dialogs/MoveDialog";
import type { MoveResult } from "@/profiles/move";
import type { ProfileRecord } from "@/profiles/record";
import { axeViolations, byRole, cleanup, click, render, type as typeText, waitFor } from "./support/render";

afterEach(cleanup);
beforeEach(() => vi.useRealTimers());

const rec = (id: string, tool: string, name: string, secrets: Record<string, string> = {}): ProfileRecord => ({ id, tool, version: 1, name, createdAt: "", updatedAt: "", fields: {}, secrets, extras: {} });
const RECORDS = [rec("a", "nats", "nats-prod", { password: "x" }), rec("b", "nats", "nats-dev"), rec("c", "docker", "build-host", { a: "1", b: "2" })];

function Host(props: Partial<MoveDialogProps> & { onMove: MoveDialogProps["onMove"] }) {
  const [open, setOpen] = useState(true);
  return (
    <MoveDialog
      open={open}
      onOpenChange={setOpen}
      records={RECORDS}
      existing={[]}
      toolLabel={(t) => t}
      target={(r) => `target of ${r.name}`}
      canShare={false}
      onBackup={() => "backup.json"}
      {...props}
    />
  );
}

const done = (moved: string[]): MoveResult => ({ moved: moved.map((from) => ({ from, to: `S-${from}` })), cleared: false });
const table = () => document.querySelector<HTMLElement>('table[aria-label="Profiles to move"]')!;
const skipBackup = async () => {
  await click(byRole("button", "Skip the backup"));
  await waitFor(() => document.querySelector('table[aria-label="Profiles to move"]') !== null, "the choice");
};

describe("the steps", () => {
  test("backup first: saved (and named in the result) or explicitly skipped", async () => {
    const onMove = vi.fn(async (_p: MovePlan, _r: MoveRun) => done(["a", "b", "c"]));
    render(<Host onMove={onMove} />);
    expect(document.querySelector('[data-testid="move-dialog"]')?.textContent).toContain("1. Backup");
    expect(await axeViolations()).toEqual([]);
    await click(byRole("button", "Save backup file…"));
    await waitFor(() => document.querySelector('table[aria-label="Profiles to move"]') !== null, "the choice");
    await click(byRole("button", "Move 3 profiles"));
    await waitFor(() => document.querySelector('[data-testid="move-done"]') !== null, "the result");
    expect(document.querySelector('[data-testid="move-dialog"]')?.textContent).toContain("backup.json, with secrets in plain text");
  });

  test("skipping the backup is said in the result", async () => {
    render(<Host onMove={async () => done(["a", "b", "c"])} />);
    await skipBackup();
    await click(byRole("button", "Move 3 profiles"));
    await waitFor(() => document.querySelector('[data-testid="move-done"]') !== null, "the result");
    expect(document.querySelector('[data-testid="move-dialog"]')?.textContent).toContain("None was saved");
  });

  test("Back from the choice returns to the backup step", async () => {
    render(<Host onMove={async () => done([])} />);
    await skipBackup();
    await click(byRole("button", "Back"));
    expect(byRole("button", "Save backup file…")).not.toBeNull();
  });
});

describe("the choice", () => {
  test("every profile is chosen to start with; unticking one leaves it in the browser and the plan names the rest", async () => {
    const onMove = vi.fn(async (_p: MovePlan, _r: MoveRun) => done(["a", "c"]));
    render(<Host onMove={onMove} />);
    await skipBackup();
    expect(table().textContent).toContain("target of nats-prod");
    expect(table().textContent).toContain("2 secrets");
    expect(table().textContent).toContain("none");
    expect(await axeViolations()).toEqual([]);
    await click(byRole("checkbox", "Move nats-dev"));
    await click(byRole("button", "Move 2 profiles"));
    await waitFor(() => onMove.mock.calls.length === 1, "the move");
    const plan = onMove.mock.calls[0]![0];
    expect([...plan.only]).toEqual(["a", "c"]);
    expect([...plan.shared]).toEqual([]);
    expect(plan.names).toEqual({ a: "nats-prod", c: "build-host" });
    await waitFor(() => document.querySelector('[data-testid="move-done"]') !== null, "the result");
    expect(document.querySelector('[data-testid="move-done"]')?.textContent).toContain("2 profiles moved; 1 left in this browser");
  });

  test("with nothing chosen there is nothing to move", async () => {
    render(<Host onMove={async () => done([])} />);
    await skipBackup();
    await click(byRole("checkbox", "Select all"));
    const move = byRole("button", "Move 0 profiles") as HTMLButtonElement;
    expect(move.disabled).toBe(true);
  });

  test("only a person who may share can move a profile as shared", async () => {
    const onMove = vi.fn(async (_p: MovePlan, _r: MoveRun) => done(["a", "b", "c"]));
    const first = render(<Host onMove={onMove} />);
    await skipBackup();
    expect(byRole("combobox", "Move nats-prod as")).toBeNull();
    first.unmount();
    cleanup();
    render(<Host onMove={onMove} canShare />);
    await skipBackup();
    await click(byRole("combobox", "Move nats-prod as"));
    await click(byRole("option", "Shared"));
    await click(byRole("button", "Move 3 profiles"));
    await waitFor(() => onMove.mock.calls.length === 1, "the move");
    expect([...onMove.mock.calls[0]![0].shared]).toEqual(["a"]);
  });
});

describe("names", () => {
  test("a name the server has is renamed first, said so, and the new name goes into the plan; it can be changed", async () => {
    const onMove = vi.fn(async (_p: MovePlan, _r: MoveRun) => done(["a", "b", "c"]));
    render(<Host onMove={onMove} existing={[{ tool: "nats", name: "nats-prod" }]} />);
    await skipBackup();
    expect(document.querySelector('[data-testid="rename-note"]')?.textContent).toContain("The server already has a profile called nats-prod, so yours moves as nats-prod-mine");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name of nats-prod on the server"]')!;
    expect(input.value).toBe("nats-prod-mine");
    await typeText(input, "nats-prod-old");
    await click(byRole("button", "Move 3 profiles"));
    await waitFor(() => onMove.mock.calls.length === 1, "the move");
    expect(onMove.mock.calls[0]![0].names["a"]).toBe("nats-prod-old");
  });

  test("a name that still clashes, or is empty, blocks the move and says why", async () => {
    render(<Host onMove={async () => done([])} existing={[{ tool: "nats", name: "nats-prod" }, { tool: "nats", name: "taken" }]} />);
    await skipBackup();
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Name of nats-prod on the server"]')!;
    await typeText(input, "taken");
    expect(table().textContent).toContain("The server already has a nats profile called taken.");
    expect((byRole("button", "Move 3 profiles") as HTMLButtonElement).disabled).toBe(true);
    await typeText(input, "");
    expect(table().textContent).toContain("A name is required.");
    await typeText(input, "nats-dev");
    expect(table().textContent).toContain("Another profile of this move is called nats-dev.");
  });
});

describe("moving", () => {
  test("progress names the profile and Stop has focus; Stop ends the run and the rest can be moved again", async () => {
    let runs = 0;
    const onMove = vi.fn(
      (_p: MovePlan, run: MoveRun) =>
        new Promise<MoveResult>((resolve) => {
          runs++;
          if (runs === 1) {
            run.onProgress({ index: 1, total: 3, record: RECORDS[1]! });
            run.signal.addEventListener("abort", () => resolve({ moved: [{ from: "a", to: "S-a" }], stopped: true, cleared: false }));
          } else resolve(done(["b", "c"]));
        }),
    );
    render(<Host onMove={onMove} />);
    await skipBackup();
    await click(byRole("button", "Move 3 profiles"));
    await waitFor(() => (document.querySelector('[data-testid="move-progress"]')?.textContent ?? "").includes("Moving 2 of 3: nats-dev"), "the progress");
    const stop = byRole("button", "Stop")!;
    expect(document.activeElement).toBe(stop);
    expect(document.querySelector('[data-testid="move-progress"]')?.getAttribute("role")).toBe("status");
    await click(stop);
    await waitFor(() => document.querySelector('[data-testid="move-stopped"]') !== null, "the stop");
    expect(document.querySelector('[data-testid="move-stopped"]')?.textContent).toContain("Stopped after 1 profile");
    await click(byRole("button", "Move the rest"));
    await waitFor(() => document.querySelector('table[aria-label="Profiles to move"]') !== null, "the list again");
    await click(byRole("button", "Move 3 profiles"));
    await waitFor(() => document.querySelector('[data-testid="move-done"]') !== null, "the result");
  });

  test("a failure part way says what failed, that the moved ones stay moved, and goes back to the list", async () => {
    const onMove = vi.fn(async (): Promise<MoveResult> => ({ moved: [{ from: "a", to: "S-a" }], failed: { record: RECORDS[1]!, error: new Error("nats-dev: the server does not have password") }, cleared: false }));
    render(<Host onMove={onMove} />);
    await skipBackup();
    await click(byRole("button", "Move 3 profiles"));
    await waitFor(() => (document.querySelector('[data-testid="move-dialog"]')?.textContent ?? "").includes("1 profile moved before this"), "the failure");
    expect(document.querySelector('[data-testid="move-dialog"]')?.textContent).toContain("the server does not have password");
    await click(byRole("button", "Back to the list"));
    expect(table()).not.toBeNull();
  });

  test("a call that rejects is a failure too", async () => {
    render(<Host onMove={async () => Promise.reject(new Error("the server went away"))} />);
    await skipBackup();
    await click(byRole("button", "Move 3 profiles"));
    await waitFor(() => (document.querySelector('[data-testid="move-dialog"]')?.textContent ?? "").includes("Back to the list"), "the failure");
  });
});
