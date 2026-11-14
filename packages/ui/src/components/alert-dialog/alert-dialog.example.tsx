import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/alert-dialog/alert-dialog";
import { Button } from "@/components/button/button";

/** The smallest useful AlertDialog: confirm deleting a connection. */
export function AlertDialogMinimal() {
  return (
    <AlertDialog size="sm">
      <AlertDialogTrigger render={<Button variant="danger" />}>Delete connection</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete “orders-prod”?</AlertDialogTitle>
          <AlertDialogDescription>Its grant and the password in the keychain are removed. Query tabs on it are closed.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogCancel variant="danger">Delete</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * DBee's two decisions: a destructive statement (the statement shown, a danger action) and the
 * access approval, whose action shows loading while the core creates the grant and then closes it.
 */
export function AlertDialogRealistic() {
  const [approving, setApproving] = useState(false);
  const [open, setOpen] = useState(false);
  const approve = () => {
    setApproving(true);
    setTimeout(() => {
      setApproving(false);
      setOpen(false);
    }, 600);
  };
  return (
    <div className="flex flex-wrap items-center gap-inline-sm">
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="secondary" />}>Run TRUNCATE</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>This statement can destroy data</AlertDialogTitle>
            <AlertDialogDescription>It removes every row of the table. Run it?</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <pre className="overflow-x-auto rounded-md bg-inset p-inset-sm font-mono text-code text-fg">truncate table orders;</pre>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogCancel variant="danger">Run it</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog size="lg" open={open} onOpenChange={setOpen}>
        <AlertDialogTrigger render={<Button />}>Approve access</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve access to orders-prod</AlertDialogTitle>
            <AlertDialogDescription>DBee may connect only to this target, with this policy.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogBody>
            <dl className="flex flex-col gap-stack-xs text-body">
              {[
                ["Driver", "PostgreSQL (built in, Byterygon, native)"],
                ["Target", "db.internal:5432, addresses 10.1.2.3"],
                ["TLS", "Required, verified against the deployment CA bundle"],
              ].map(([term, description]) => (
                <div key={term} className="flex flex-wrap gap-inline-md">
                  <dt className="text-fg-muted">{term}</dt>
                  <dd className="text-fg">{description}</dd>
                </div>
              ))}
            </dl>
          </AlertDialogBody>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approving}>Back</AlertDialogCancel>
            <AlertDialogAction loading={approving} onClick={approve}>
              Approve and save
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
