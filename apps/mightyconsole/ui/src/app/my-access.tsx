// "My access" (TSK-135 §3, the link every refusal carries): the roles in force on this session and
// how each reached the person, and the permissions those roles grant with where each holds. It
// reads `app.me`; nothing here changes anything, and the server decides every call.
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Me } from "@/gen/api";
import { scopeText, viaText } from "./session";

/** "everywhere", or the entries it holds in. */
function whereText(grant: Me["permissions"][number]): string {
  if (grant.everywhere) return "everywhere";
  return grant.scope.length === 0 ? "nowhere" : scopeText(grant.scope);
}

export function MyAccessDialog({ open, onOpenChange, me }: { open: boolean; onOpenChange(open: boolean): void; me: Me }) {
  const permissions = [...me.permissions].sort((a, b) => a.perm.localeCompare(b.perm));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="my-access" className="max-w-panel-md">
        <DialogHeader>
          <DialogTitle>My access</DialogTitle>
          <DialogDescription>What your roles let you do on this server. An administrator changes them in Users and roles; the server checks every call whatever this page says.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-lg">
          <section aria-labelledby="my-access-roles" className="flex flex-col gap-stack-sm">
            <h3 id="my-access-roles" className="text-body-1-strong">
              Roles
            </h3>
            {me.roles.length === 0 ? (
              <p className="text-body-1 text-fg-muted">None of your groups gives you a role yet.</p>
            ) : (
              <Table aria-label="Your roles">
                <TableHeader>
                  <TableRow>
                    <TableHead>Role</TableHead>
                    <TableHead>Where</TableHead>
                    <TableHead>How you have it</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {me.roles.map((grant) => (
                    <TableRow key={`${grant.role}|${grant.via}|${(grant.scope ?? []).join(",")}`}>
                      <TableCell>
                        <Badge variant={grant.role === "admin" ? "info" : "neutral"}>{grant.role}</Badge>
                      </TableCell>
                      <TableCell className="break-all">{scopeText(grant.scope)}</TableCell>
                      <TableCell>{viaText(grant.via)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
          <section aria-labelledby="my-access-perms" className="flex flex-col gap-stack-sm">
            <h3 id="my-access-perms" className="text-body-1-strong">
              Permissions
            </h3>
            <p className="text-caption-1 text-fg-muted">On your own personal profiles you hold every permission of the tool.</p>
            <Table aria-label="Your permissions">
              <TableHeader>
                <TableRow>
                  <TableHead>Permission</TableHead>
                  <TableHead>Where</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {permissions.map((grant) => (
                  <TableRow key={grant.perm}>
                    <TableCell className="font-mono">{grant.perm}</TableCell>
                    <TableCell className="break-all">{whereText(grant)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        </DialogBody>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
