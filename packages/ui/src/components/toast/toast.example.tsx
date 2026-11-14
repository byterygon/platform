import { useEffect, useRef } from "react";
import { Button } from "@/components/button/button";
import { Toast, useToast } from "@/components/toast/toast";

function SaveButton() {
  const toast = useToast();
  return (
    <Button variant="secondary" onClick={() => toast.add({ title: "Query saved", description: "orders-by-region.sql", type: "success" })}>
      Save query
    </Button>
  );
}

/** The smallest useful Toast: the region near the app root, and a button that adds a toast to it. */
export function ToastMinimal() {
  return (
    <Toast>
      <SaveButton />
    </Toast>
  );
}

function DbeeNotices() {
  const toast = useToast();
  const added = useRef(false);
  useEffect(() => {
    if (added.current) return;
    added.current = true;
    toast.add({
      title: "Access to orders-prod expires in 15 min",
      description: "Sessions drop at 14:02.",
      type: "warning",
      timeout: 0,
      priority: "high",
      actionProps: { children: "Renew access" },
    });
    toast.add({ title: "Exported 1,000,000 rows", description: "orders.csv, 84 MB", type: "success", timeout: 0 });
    toast.add({ title: "Connection lost", description: "orders-prod stopped answering.", type: "danger", timeout: 0, actionProps: { children: "Reconnect" } });
  }, [toast]);
  return (
    <Button variant="ghost" onClick={() => toast.add({ title: "Copied 12 cells", type: "info" })}>
      Copy cells
    </Button>
  );
}

/**
 * DBee's notices in the page flow (placement static): the expiry warning, sticky and announced at
 * once with a Renew action; an export that finished; a lost connection with Reconnect; and a
 * short info toast from the Copy button.
 */
export function ToastRealistic() {
  return (
    <Toast placement="static" limit={4}>
      <DbeeNotices />
    </Toast>
  );
}
