// Approve access (DBee spec §3.4): the grant. Everything shown comes from the GrantPreview the
// core returned, never from the form. "Approve and save" calls connections.create bound to the
// preview digest; PreviewStale re-prepares and shows the fresh preview; SecretStoreUnavailable
// offers to continue without saving the password (spec §8).
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import type { ConnectionDraft, ConnectionSummary, GrantPreview } from "@/gen/api";
import { useClient } from "../client";
import { type Described, describeError, tlsName } from "../messages";

export interface Approval {
  preview: GrantPreview;
  draft: ConnectionDraft;
  password: string | null;
  replaces: string | null;
}

export interface ApproveDialogProps {
  approval: Approval | null;
  onBack: () => void;
  onApproved: (connection: ConnectionSummary) => void;
}

const when = (ms: number | null) => (ms === null ? "Never (personal connection)" : new Date(ms).toLocaleString());

export function ApproveDialog({ approval, onBack, onApproved }: ApproveDialogProps) {
  const client = useClient();
  const [current, setCurrent] = useState<Approval | null>(null);
  const [error, setError] = useState<Described | null>(null);
  const [busy, setBusy] = useState(false);
  const [withoutPassword, setWithoutPassword] = useState(false);
  const shown = current && approval && current.preview.previewDigest !== approval.preview.previewDigest && current.draft === approval.draft ? current : approval;
  if (approval === null) return null;
  const { preview } = shown ?? approval;
  const plaintext = preview.tls.kind === "plaintext";

  const approve = async (skipPassword = withoutPassword) => {
    setBusy(true);
    setError(null);
    try {
      const a = shown ?? approval;
      // Without a keychain the password is not saved: the draft binds no secret (spec Open question 2).
      const draft = skipPassword ? { ...a.draft, hasSecret: false } : a.draft;
      const created = await client.connections.create({
        draft,
        previewDigest: a.preview.previewDigest,
        secret: a.password !== null && !skipPassword ? { password: a.password } : null,
        replaces: a.replaces,
      });
      setCurrent(null);
      onApproved(created);
    } catch (e) {
      const d = describeError(e, "approve");
      if (d.code === "FailedPrecondition" || d.title === "The preview changed") {
        try {
          const fresh = await client.connections.prepare(approval.draft);
          setCurrent({ ...approval, preview: fresh });
        } catch (e2) {
          setError(describeError(e2, "approve"));
        }
      }
      setError(d);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog open onOpenChange={(open) => !open && onBack()} size="lg">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Approve access for {preview.host}</AlertDialogTitle>
          <AlertDialogDescription>This grant lets the built-in driver reach exactly what is listed here, nothing else. Approving saves the connection.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="flex flex-col gap-stack-md">
          <DescriptionList divided>
            <DescriptionListItem>
              <DescriptionListTerm>Driver</DescriptionListTerm>
              <DescriptionListDetails>
                {preview.driver.name} (built in, Byterygon, version {preview.driver.version}, native) {preview.driver.firstParty ? <Badge variant="accent">first-party</Badge> : null}
                <div>
                  <Code>{preview.driver.digest}</Code>
                </div>
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Target</DescriptionListTerm>
              <DescriptionListDetails>
                {preview.host}:{preview.port} over {preview.template}
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Resolved now</DescriptionListTerm>
              <DescriptionListDetails>{preview.resolvedAddresses.length ? preview.resolvedAddresses.join(", ") : "no address"}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Allowed addresses</DescriptionListTerm>
              <DescriptionListDetails>
                {preview.proposedAddresses.join(", ")}
                <div className="text-caption text-fg-muted">Only these may be connected to; a different address later needs a new approval.</div>
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>TLS</DescriptionListTerm>
              <DescriptionListDetails>
                {plaintext ? <Badge variant="danger">PLAINTEXT</Badge> : null} {tlsName(preview.tls.kind)}
                {preview.tls.serverName ? <div>Server name: {preview.tls.serverName}</div> : null}
                {preview.tls.pinned.map((p) => (
                  <div key={p}>
                    <Code>{p}</Code>
                  </div>
                ))}
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Cancel connection</DescriptionListTerm>
              <DescriptionListDetails>{preview.allowCancelConnection ? "May be opened under this grant" : "Not allowed; Cancel waits for the statement"}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Expires</DescriptionListTerm>
              <DescriptionListDetails>{when(preview.expiresAt)}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Credential</DescriptionListTerm>
              <DescriptionListDetails>{preview.secretBinding && !withoutPassword ? "A password will be stored in the OS keychain and released only to this connection" : "No credential"}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Approver</DescriptionListTerm>
              <DescriptionListDetails>
                <Code>{preview.approver}</Code>
              </DescriptionListDetails>
            </DescriptionListItem>
          </DescriptionList>
          {error ? (
            <Alert variant={error.title === "The preview changed" ? "warning" : "danger"}>
              <AlertTitle>{error.title}</AlertTitle>
              {error.description ? <AlertDescription>{error.description}</AlertDescription> : null}
              {error.correlationId ? (
                <AlertDescription>
                  Correlation id <Code>{error.correlationId}</Code>
                </AlertDescription>
              ) : null}
            </Alert>
          ) : null}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onBack}>Back</AlertDialogCancel>
          {error?.remedy === "continueWithoutPassword" ? (
            <AlertDialogAction
              appearance="secondary"
              loading={busy}
              onClick={() => {
                setWithoutPassword(true);
                void approve(true);
              }}
            >
              {error.remedyLabel}
            </AlertDialogAction>
          ) : null}
          <AlertDialogAction variant={plaintext ? "danger" : "primary"} loading={busy} onClick={() => void approve()}>
            {plaintext ? "Approve plaintext and save" : "Approve and save"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
