// Keyboard shortcuts (DBee spec §9): every row of the table for this shell, rendered with Kbd.
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ACTIONS, type Shell, bindingsOf, displayKeys } from "../shortcuts";

export interface ShortcutsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shell: Shell;
}

const EXTRA: { label: string; keys: string[][] }[] = [
  { label: "Editor: find, comment", keys: [["Mod", "F"], ["Mod", "/"]] },
  { label: "Tree: move, collapse and expand, type-ahead", keys: [["↑"], ["↓"], ["←"], ["→"], ["Home"], ["End"]] },
  { label: "Grid: move, select range, resize column", keys: [["Arrows"], ["Shift", "Arrows"], ["Alt", "Shift", "←/→"]] },
];

export function ShortcutsDialog({ open, onOpenChange, shell }: ShortcutsDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>{shell === "web" ? "Keys the browser owns use Alt+Shift instead." : "The desktop app has the full set."} F6 cycles tree, editor and results; Escape closes the innermost popup.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Table aria-label="Shortcuts">
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Keys</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ACTIONS.map((a) => (
                <TableRow key={a.id}>
                  <TableCell wrap>{a.label}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-inline-sm">
                      {bindingsOf(a, shell).map((b) => (
                        <KbdGroup key={b}>
                          {displayKeys(b).map((k, i) => (
                            <span key={i} className="contents">
                              {i > 0 ? "+" : null}
                              <Kbd>{k}</Kbd>
                            </span>
                          ))}
                        </KbdGroup>
                      ))}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {EXTRA.map((e) => (
                <TableRow key={e.label}>
                  <TableCell wrap>{e.label}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-inline-sm">
                      {e.keys.map((keys, j) => (
                        <KbdGroup key={j}>
                          {keys.map((k, i) => (
                            <span key={i} className="contents">
                              {i > 0 ? "+" : null}
                              <Kbd>{k === "Mod" ? displayKeys("Mod")[0] : k}</Kbd>
                            </span>
                          ))}
                        </KbdGroup>
                      ))}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="primary" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
