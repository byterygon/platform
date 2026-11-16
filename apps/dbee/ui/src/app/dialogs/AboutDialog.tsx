// About and diagnostics (DBee spec §3.10): version, API version and schema hash, mode, drivers,
// licence, the correlation ids of recent errors (the core log stays on the machine: About shows
// the path; the web shell shows correlation ids only).
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { CodeBlock } from "@/components/ui/code-block";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import * as api from "@/gen/api";
import type { AppInfo } from "@/gen/api";

export interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: AppInfo | null;
  /** Correlation ids and messages of errors this session, newest first. */
  diagnostics: readonly string[];
}

export function AboutDialog({ open, onOpenChange, info, diagnostics }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>About DBee</DialogTitle>
          <DialogDescription>A keyboard-first PostgreSQL client for air-gapped and self-hosted environments.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          <DescriptionList divided>
            <DescriptionListItem>
              <DescriptionListTerm>Version</DescriptionListTerm>
              <DescriptionListDetails>{info?.version ?? "…"}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>API</DescriptionListTerm>
              <DescriptionListDetails>
                {api.API} {api.API_VERSION}, protocol {api.PROTOCOL}
                <div>
                  <Code>{api.SCHEMA_HASH}</Code>
                </div>
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Mode</DescriptionListTerm>
              <DescriptionListDetails>{info ? (info.mode === "standalone" ? `Standalone desktop (${info.platform})` : `Self-hosted web (${info.platform})`) : "…"}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Drivers</DescriptionListTerm>
              <DescriptionListDetails>
                {info?.drivers.map((d) => (
                  <div key={d.id}>
                    {d.name} {d.version} {d.firstParty ? "(first-party, native)" : ""} <Code>{d.digest}</Code>
                  </div>
                ))}
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Licence</DescriptionListTerm>
              <DescriptionListDetails>
                AGPL-3.0-only. The text ships with the app (<Code>apps/dbee/LICENSE</Code>); the libraries it is built on are MIT OR Apache-2.0.
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Core log</DescriptionListTerm>
              <DescriptionListDetails>{info?.mode === "standalone" ? <Code>{info.workspacePath}</Code> : "On the server; quote a correlation id to the operator."}</DescriptionListDetails>
            </DescriptionListItem>
          </DescriptionList>
          <div>
            <h3 className="text-body-strong text-fg">Diagnostics</h3>
            <p className="text-caption text-fg-muted">Correlation ids of this session's errors, newest first; match them with the audit log. No SQL, no secrets.</p>
            <CodeBlock code={diagnostics.length ? diagnostics.join("\n") : "No errors this session."} language="text" aria-label="Diagnostics" className="max-h-panel-sm" />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="primary" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
