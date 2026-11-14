import { Button } from "@/components/button/button";

/** The smallest useful Button. */
export function ButtonMinimal() {
  return <Button>Save</Button>;
}

/** A dialog footer: one primary action, a quiet cancel, a destructive action and a running one. */
export function ButtonRealistic() {
  return (
    <div className="flex flex-wrap items-center gap-inline-sm">
      <Button variant="ghost">Cancel</Button>
      <Button variant="secondary">Duplicate</Button>
      <Button variant="danger">Delete table</Button>
      <Button loading>Running query</Button>
      <Button size="sm" disabled>
        Disabled
      </Button>
    </div>
  );
}
