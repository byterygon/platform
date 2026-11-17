// About and Keyboard shortcuts (Mightyconsole spec §3.4, §3.6).
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import { CodeBlock } from "@/components/ui/code-block";
import { DescriptionList, DescriptionListDetails, DescriptionListItem, DescriptionListTerm } from "@/components/ui/description-list";
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import * as api from "@/gen/api";
import type { AppInfo } from "@/gen/api";
import { ACTIONS, LOCAL_KEYS, displayKeys } from "../shortcuts";

export interface AboutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  info: AppInfo | null;
  /** Correlation ids and messages of errors this session, newest first (at most 100). */
  diagnostics: readonly string[];
}

export function AboutDialog({ open, onOpenChange, info, diagnostics }: AboutDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>About Mightyconsole</DialogTitle>
          <DialogDescription>One offline console for the systems engineers operate, in the Byterygon look.</DialogDescription>
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
              <DescriptionListTerm>Server</DescriptionListTerm>
              <DescriptionListDetails>
                {info ? `${info.publicOrigin} (listening on ${info.listen}, ${info.os})` : "…"}
                {info ? (
                  <div>
                    Certificate SHA-256 <Code>{info.certificateFingerprint}</Code>
                  </div>
                ) : null}
              </DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Tools</DescriptionListTerm>
              <DescriptionListDetails>{info ? info.tools.map((t) => `${t.id} ${t.version}`).join(", ") : "…"}</DescriptionListDetails>
            </DescriptionListItem>
            <DescriptionListItem>
              <DescriptionListTerm>Licence</DescriptionListTerm>
              <DescriptionListDetails>
                AGPL-3.0-only (<Code>apps/mightyconsole/LICENSE</Code>); the libraries it is built on are MIT OR Apache-2.0.
              </DescriptionListDetails>
            </DescriptionListItem>
          </DescriptionList>
          <div>
            <h3 className="text-body-1-strong text-fg">Diagnostics</h3>
            <p className="text-caption-1 text-fg-muted">Correlation ids of this session's errors, newest first; the server log has the matching lines. No secrets.</p>
            <CodeBlock code={diagnostics.length ? diagnostics.join("\n") : "No errors this session."} language="text" aria-label="Diagnostics" className="max-h-panel-sm" />
          </div>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button appearance="primary" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Keys({ binding }: { binding: string }) {
  return (
    <KbdGroup>
      {displayKeys(binding).map((k, i) => (
        <span key={i} className="contents">
          {i > 0 ? "+" : null}
          <Kbd>{k}</Kbd>
        </span>
      ))}
    </KbdGroup>
  );
}

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} size="lg">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Keys the browser owns use Alt+Shift instead. Every action is also in the command palette.</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <Table aria-label="Shortcuts">
            <TableHeader>
              <TableRow>
                <TableHead>Action</TableHead>
                <TableHead>Keys</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ACTIONS.filter((a) => a.keys.length > 0).map((a) => (
                <TableRow key={a.id}>
                  <TableCell wrap>{a.label}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-inline-sm">
                      {a.keys.map((b) => (
                        <Keys key={b} binding={b} />
                      ))}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
              {LOCAL_KEYS.map((e) => (
                <TableRow key={e.label}>
                  <TableCell wrap>{e.label}</TableCell>
                  <TableCell>
                    <span className="flex flex-wrap gap-inline-sm">
                      {e.keys.map((b) => (
                        <Keys key={b} binding={b} />
                      ))}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button appearance="primary" />}>Close</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
