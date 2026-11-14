import { Input } from "@/components/input/input";

/** The smallest useful Input: a labelled text field. */
export function InputMinimal() {
  return <Input aria-label="Table name" placeholder="customers" />;
}

/** A connection form: labels, a hint, an invalid field with its message, and a disabled field. */
export function InputRealistic() {
  return (
    <form className="flex flex-col gap-stack-md">
      <label className="flex flex-col gap-stack-xs text-label text-fg">
        Host
        <Input name="host" defaultValue="db.internal" aria-describedby="host-hint" />
        <span id="host-hint" className="text-caption text-fg-muted">
          A name or address on your network.
        </span>
      </label>
      <label className="flex flex-col gap-stack-xs text-label text-fg">
        Port
        <Input name="port" size="sm" defaultValue="99999" aria-invalid="true" aria-describedby="port-error" />
        <span id="port-error" className="text-caption text-danger-fg">
          The port must be between 1 and 65535.
        </span>
      </label>
      <label className="flex flex-col gap-stack-xs text-label text-fg">
        Driver
        <Input name="driver" defaultValue="postgres" disabled />
      </label>
    </form>
  );
}
