import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/field/field";
import { PasswordInput } from "@/components/password-input/password-input";

/** The smallest useful PasswordInput: a labelled password with a show button. */
export function PasswordInputMinimal() {
  return (
    <Field>
      <FieldLabel>Password</FieldLabel>
      <PasswordInput />
    </Field>
  );
}

/**
 * Credentials of a connection: the saved password (shown), a new key passphrase that is too short,
 * a password the vault manages, and the small and large sizes.
 */
export function PasswordInputRealistic() {
  return (
    <div className="flex flex-col gap-stack-md">
      <Field name="password">
        <FieldLabel>Database password</FieldLabel>
        <PasswordInput defaultValue="correct horse battery" defaultVisible />
        <FieldDescription>Stored in the workspace keychain, never in the connection file.</FieldDescription>
      </Field>
      <Field name="passphrase" invalid>
        <FieldLabel>Key passphrase</FieldLabel>
        <PasswordInput autoComplete="new-password" defaultValue="abc" size="sm" />
        <FieldError>Use at least 12 characters.</FieldError>
      </Field>
      <Field name="vault" disabled>
        <FieldLabel>Vault password</FieldLabel>
        <PasswordInput defaultValue="managed-by-vault" />
        <FieldDescription>Managed by the vault; ask an administrator to rotate it.</FieldDescription>
      </Field>
      <Field name="admin">
        <FieldLabel>Administrator password</FieldLabel>
        <PasswordInput size="lg" />
      </Field>
    </div>
  );
}
