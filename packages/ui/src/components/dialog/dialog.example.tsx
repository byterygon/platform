import { Button } from "@/components/button/button";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/dialog/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/field/field";
import { Input } from "@/components/input/input";
import { Kbd } from "@/components/kbd/kbd";
import { Select, SelectItem } from "@/components/select/select";

/** The smallest useful Dialog: a trigger, a title, a sentence and the actions. */
export function DialogMinimal() {
  return (
    <Dialog>
      <DialogTrigger render={<Button variant="secondary" />}>About DBee</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>About DBee</DialogTitle>
          <DialogDescription>Version 0.1.0, standalone desktop. Nothing is sent over the network except to the databases you approve.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const formats = { csv: "CSV", tsv: "TSV", jsonl: "JSON Lines" };

const shortcuts: [string, string[]][] = [
  ["Command palette", ["Ctrl", "K"]],
  ["New query tab", ["Ctrl", "T"]],
  ["Run statement", ["Ctrl", "Enter"]],
  ["Cancel running statement", ["Shift", "Escape"]],
  ["Export result", ["Ctrl", "Shift", "S"]],
  ["Toggle sidebar", ["Ctrl", "B"]],
];

/**
 * DBee's dialogs, one per width: rename a tab (sm), export a result with a Select inside (md, the
 * Select's list opens above the dialog), the keyboard shortcuts (lg, a scrolling body) and the
 * details of a column (xl, no close button: the footer closes it).
 */
export function DialogRealistic() {
  return (
    <div className="flex flex-wrap items-center gap-inline-sm">
      <Dialog size="sm">
        <DialogTrigger render={<Button variant="ghost" />}>Rename tab</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename tab</DialogTitle>
          </DialogHeader>
          <Field>
            <FieldLabel>Title</FieldLabel>
            <Input defaultValue="Orders by region" />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <DialogClose render={<Button />}>Rename</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog>
        <DialogTrigger render={<Button variant="secondary" />}>Export result</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export result</DialogTitle>
            <DialogDescription>The statement runs again and the whole result is written, not only the rows loaded in the grid.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field>
              <FieldLabel>Format</FieldLabel>
              <Select items={formats} defaultValue="csv">
                {Object.entries(formats).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </Select>
            </Field>
            <Field>
              <FieldLabel>Null text</FieldLabel>
              <Input placeholder="empty" />
              <FieldDescription>Written for NULL values.</FieldDescription>
            </Field>
          </DialogBody>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button>Choose file…</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog size="lg">
        <DialogTrigger render={<Button variant="ghost" />}>Keyboard shortcuts</DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Keyboard shortcuts</DialogTitle>
            <DialogDescription>Every action is also in the command palette.</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <dl className="grid grid-cols-2 gap-stack-sm">
              {shortcuts.map(([action, keys]) => (
                <div key={action} className="contents">
                  <dt className="text-body text-fg">{action}</dt>
                  <dd className="flex gap-inline-xs">
                    {keys.map((key) => (
                      <Kbd key={key}>{key}</Kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </DialogBody>
        </DialogContent>
      </Dialog>

      <Dialog size="xl">
        <DialogTrigger render={<Button variant="ghost" />}>Column details</DialogTrigger>
        <DialogContent showClose={false}>
          <DialogHeader>
            <DialogTitle>orders.created_at</DialogTitle>
            <DialogDescription>timestamp with time zone, not null, default now()</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="secondary" />}>Close</DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
