// The AlertDialogs of the app: a destructive statement (Decision 12), deleting a connection
// (spec §4), a password for this session (spec §8, no keychain).
import { useState } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { CodeBlock } from "@/components/ui/code-block";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { PasswordInput } from "@/components/ui/password-input";

export function ConfirmDestructiveDialog({ sql, statementKind, onCancel, onRun }: { sql: string; statementKind: string; onCancel: () => void; onRun: () => void }) {
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()} size="md">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>This statement can destroy data: {statementKind}. Run it?</AlertDialogTitle>
          <AlertDialogDescription>The server classifies and authorizes it on its own; this confirmation is yours.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody>
          <CodeBlock code={sql} language="sql" aria-label="Statement" className="max-h-panel-sm" copyable={false} />
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction appearance="danger" onClick={onRun}>
            Run it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function DeleteConnectionDialog({ name, busy, onCancel, onDelete }: { name: string; busy: boolean; onCancel: () => void; onDelete: () => void }) {
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()} size="sm">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
          <AlertDialogDescription>The grant is revoked, open sessions are closed and the password is removed from the keychain. Query tabs bound to it stay open without a connection.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction appearance="danger" loading={busy} onClick={onDelete}>
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function PasswordDialog({ name, busy, onCancel, onSubmit }: { name: string; busy: boolean; onCancel: () => void; onSubmit: (password: string) => void }) {
  const [password, setPassword] = useState("");
  return (
    <AlertDialog open onOpenChange={(o) => !o && onCancel()} size="sm">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Password for {name}</AlertDialogTitle>
          <AlertDialogDescription>No password is stored for this connection. It is kept for this session only and never written anywhere.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody>
          <Field>
            <FieldLabel>Password</FieldLabel>
            <PasswordInput value={password} onValueChange={setPassword} autoComplete="current-password" autoFocus />
            <FieldDescription>Zeroized when the session ends.</FieldDescription>
          </Field>
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction loading={busy} disabled={password === ""} onClick={() => onSubmit(password)}>
            Connect
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
