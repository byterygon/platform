import { useState } from "react";
import { DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut } from "@/components/dropdown-menu/dropdown-menu";
import { SplitButton } from "@/components/split-button/split-button";

/** The smallest useful SplitButton: an action and one variant of it. */
export function SplitButtonMinimal() {
  return (
    <SplitButton menuLabel="More export options" variant="secondary" menu={<DropdownMenuItem>Export as JSON Lines</DropdownMenuItem>}>
      Export CSV
    </SplitButton>
  );
}

/** DBee's Run: the statement under the cursor, the selection in the menu; loading while it runs; the three sizes. */
export function SplitButtonRealistic() {
  const [running, setRunning] = useState(false);
  const run = () => {
    setRunning(true);
    setTimeout(() => setRunning(false), 800);
  };
  const runMenu = (
    <>
      <DropdownMenuGroup>
        <DropdownMenuLabel>Run</DropdownMenuLabel>
        <DropdownMenuItem onClick={run}>
          Run statement under cursor <DropdownMenuShortcut>Ctrl+Enter</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={run}>Run selection</DropdownMenuItem>
      </DropdownMenuGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem>Explain</DropdownMenuItem>
    </>
  );
  return (
    <div className="flex flex-wrap items-center gap-inline-md">
      <SplitButton menuLabel="Run options" loading={running} onClick={run} menu={runMenu}>
        Run
      </SplitButton>
      <SplitButton size="sm" variant="ghost" menuLabel="More copy options" menu={<DropdownMenuItem>Copy as JSON</DropdownMenuItem>}>
        Copy
      </SplitButton>
      <SplitButton size="lg" menuLabel="More save options" menu={<DropdownMenuItem>Save as…</DropdownMenuItem>}>
        Save
      </SplitButton>
      <SplitButton disabled menuLabel="More run options" menu={<DropdownMenuItem>Run selection</DropdownMenuItem>}>
        Run (no connection)
      </SplitButton>
    </div>
  );
}
