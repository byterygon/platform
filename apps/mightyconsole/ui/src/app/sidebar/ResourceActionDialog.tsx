// The question a resource node's context-menu item asks before it acts (TSK-95): a name in a
// dialog (a saved query's Rename) or a confirmation (its Delete). Errors stay in the dialog.
import { useEffect, useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { ResourceAction } from "@/tools/types";

export interface ResourceActionDialogProps {
  /** The item being asked about; `null` closes the dialog. */
  action: ResourceAction | null;
  onClose(): void;
  /** Runs the item with the answer (the name, or "" after a confirmation). */
  onRun(action: ResourceAction, value: string): Promise<void>;
}

export function ResourceActionDialog({ action, onClose, onRun }: ResourceActionDialogProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!action) return;
    setValue(action.prompt?.value ?? "");
    setFailed(null);
  }, [action]);
  const prompt = action?.prompt;
  const confirm = action?.confirm;
  const invalid = prompt?.validate?.(value.trim()) ?? null;
  const run = async () => {
    if (!action) return;
    setBusy(true);
    setFailed(null);
    try {
      await onRun(action, value.trim());
      onClose();
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog open={prompt !== undefined} onOpenChange={(open) => !open && onClose()} size="sm">
        <DialogContent>
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim() !== "" && invalid === null) void run();
            }}
          >
            <DialogHeader>
              <DialogTitle>{prompt?.title}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <Field invalid={invalid !== null || failed !== null}>
                <FieldLabel>{prompt?.label}</FieldLabel>
                <Input value={value} onValueChange={setValue} autoComplete="off" autoFocus />
                {invalid ?? failed ? <FieldError match>{invalid ?? failed}</FieldError> : null}
              </Field>
            </DialogBody>
            <DialogFooter>
              <Button onClick={onClose}>Cancel</Button>
              <Button type="submit" appearance="primary" loading={busy} disabled={value.trim() === "" || invalid !== null}>
                {prompt?.submit}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirm !== undefined} onOpenChange={(open) => !open && onClose()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{failed ?? confirm?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction appearance={action?.danger ? "danger" : "primary"} loading={busy} onClick={() => void run()}>
              {confirm?.submit}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
