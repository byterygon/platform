// The SSH host key dialog (Mightyconsole spec §10.2, TSK-81 mockup frames docker-hostkey and
// docker-hostkey-changed). A connect that fails with `HostKey` names the key the host presented;
// nothing was sent to the host. First use: the algorithm and the SHA-256 fingerprint to compare
// with the host owner's, then "Trust and connect". A changed key: a danger message, the trusted
// and the presented keys side by side, and "Replace the trusted key". There is no "connect once
// anyway": Cancel leaves the profile as it was and the connection closed.
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Code } from "@/components/ui/code";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Icon } from "@/components/ui/icon";
import type { HostKeyDetails, HostKeyFingerprint } from "@/gen/api";
import { LockClosed, Warning } from "@/lib/icons";
import { CopyButton } from "../page";

/** "ED25519", "ECDSA-P256", "RSA" for an SSH algorithm name. */
export function keyTypeLabel(algorithm: string): string {
  switch (algorithm) {
    case "ssh-ed25519":
      return "ED25519";
    case "ecdsa-sha2-nistp256":
      return "ECDSA-P256";
    case "ecdsa-sha2-nistp384":
      return "ECDSA-P384";
    case "ecdsa-sha2-nistp521":
      return "ECDSA-P521";
    case "ssh-rsa":
      return "RSA";
    default:
      return algorithm;
  }
}

/** The host key file `ssh-keygen -lf` reads on the host for this algorithm. */
export function hostKeyFile(algorithm: string): string {
  const type = algorithm === "ssh-ed25519" ? "ed25519" : algorithm.startsWith("ecdsa-") ? "ecdsa" : algorithm === "ssh-rsa" ? "rsa" : "*";
  return `/etc/ssh/ssh_host_${type}_key.pub`;
}

/** The key the profile stores when the person trusts what the host presented. */
export function presentedKey(details: HostKeyDetails): HostKeyFingerprint {
  return { algorithm: details.algorithm, fingerprintSha256: details.fingerprintSha256 };
}

export interface HostKeyDialogProps {
  open: boolean;
  /** The profile's name, "build-host". */
  name: string;
  /** `host:port` the key came from. */
  target: string;
  details: HostKeyDetails | null;
  onCancel: () => void;
  onTrust: (key: HostKeyFingerprint) => void;
}

export function HostKeyDialog({ open, name, target, details, onCancel, onTrust }: HostKeyDialogProps) {
  const changed = details?.state === "changed";
  const fingerprint = details?.fingerprintSha256 ?? "";
  const algorithm = details?.algorithm ?? "";
  return (
    <AlertDialog open={open && details !== null} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {changed ? (
              <span className="flex items-center gap-inline-sm">
                <Icon icon={Warning} className="text-danger-fg" /> The identity of {name} changed
              </span>
            ) : (
              `Trust ${name}?`
            )}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {changed
              ? `The key ${target} presented is not the one this profile trusts.`
              : `This is the first connection to ${target}. Compare the fingerprint with the one the host's owner gives you. Nothing has been sent to the host yet.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex flex-col gap-stack-md">
          {changed ? (
            <Alert intent="danger">
              <AlertDescription>The host may have been reinstalled, or someone may be in the middle of the connection. Nothing was sent to it.</AlertDescription>
            </Alert>
          ) : null}
          <DescriptionList>
            {changed && details?.expected ? (
              <DescriptionListItem>
                <DescriptionListTerm>Trusted</DescriptionListTerm>
                <DescriptionListDetails>
                  <Code>
                    {keyTypeLabel(details.expected.algorithm)} · {details.expected.fingerprintSha256}
                  </Code>
                </DescriptionListDetails>
              </DescriptionListItem>
            ) : (
              <DescriptionListItem>
                <DescriptionListTerm>Algorithm</DescriptionListTerm>
                <DescriptionListDetails>{keyTypeLabel(algorithm)}</DescriptionListDetails>
              </DescriptionListItem>
            )}
            <DescriptionListItem>
              <DescriptionListTerm>{changed ? "Presented" : "Fingerprint"}</DescriptionListTerm>
              <DescriptionListDetails>
                <span className="flex min-w-0 items-center gap-inline-xs">
                  <Code className={changed ? "break-all text-danger-fg" : "break-all"}>{changed ? `${keyTypeLabel(algorithm)} · ${fingerprint}` : fingerprint}</Code>
                  <CopyButton value={fingerprint} what="fingerprint" />
                </span>
              </DescriptionListDetails>
            </DescriptionListItem>
          </DescriptionList>
          <p className="text-body-1 text-fg-muted">
            {changed ? "Replace it only after checking the new fingerprint with the host's owner, for example " : "On the host, "}
            <Code>ssh-keygen -lf {hostKeyFile(algorithm)}</Code>
            {changed ? " on the host." : " prints it."} {changed ? "" : "Trusting stores the key in the profile; a different key later stops the connection."}
          </p>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {changed ? (
            <AlertDialogAction appearance="danger" onClick={() => details && onTrust(presentedKey(details))}>
              Replace the trusted key
            </AlertDialogAction>
          ) : (
            <AlertDialogAction appearance="primary" onClick={() => details && onTrust(presentedKey(details))}>
              <Icon icon={LockClosed} /> Trust and connect
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
