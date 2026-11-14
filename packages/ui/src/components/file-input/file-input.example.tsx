import { useState } from "react";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { FileInput } from "@/components/file-input/file-input";

/** The smallest useful FileInput: a labelled file picker. */
export function FileInputMinimal() {
  return (
    <Field>
      <FieldLabel>CA certificate</FieldLabel>
      <FileInput accept=".pem,.crt" />
    </Field>
  );
}

/**
 * TLS files of a connection and an SQL import: a certificate with a hint, a required key that is
 * missing, a disabled picker, the small and large sizes, and a dropzone for several scripts that
 * lists what was dropped.
 */
export function FileInputRealistic() {
  const [scripts, setScripts] = useState<File[]>([]);
  return (
    <div className="flex flex-col gap-stack-md">
      <Field name="cert">
        <FieldLabel>Client certificate</FieldLabel>
        <FileInput accept=".pem,.crt" />
        <FieldDescription>PEM or DER. Read on this machine, never uploaded.</FieldDescription>
      </Field>
      <Field name="key" invalid>
        <FieldLabel>Client key</FieldLabel>
        <FileInput accept=".pem,.key" size="sm" />
        <FieldError>Choose the key that matches the certificate.</FieldError>
      </Field>
      <Field name="root" disabled>
        <FieldLabel>Root certificate</FieldLabel>
        <FileInput />
        <FieldDescription>Provided by the workspace.</FieldDescription>
      </Field>
      <Field name="ssh">
        <FieldLabel>SSH identity</FieldLabel>
        <FileInput size="lg" />
      </Field>
      <Field name="scripts">
        <FieldLabel>SQL scripts</FieldLabel>
        <FileInput variant="dropzone" accept=".sql" multiple chooseLabel="Choose files" emptyLabel="No scripts yet" onFilesChange={setScripts} />
        <FieldDescription role="status">
          {scripts.length === 0 ? "Scripts run in the order you add them." : `${scripts.length} script${scripts.length === 1 ? "" : "s"} ready to run.`}
        </FieldDescription>
      </Field>
    </div>
  );
}
