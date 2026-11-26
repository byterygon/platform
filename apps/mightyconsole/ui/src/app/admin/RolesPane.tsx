// Roles (DOC-25 §3.3.2; TSK-135 "A role: tools × risks, then everything else"): the built-in
// roles are read-only, a role made here is editable cell by cell, "Copy as a new role" starts
// one from any. The matrix is drawn from the server's catalogue: a dash is a permission the tool
// does not have. A role with Exec also gets `term.write`. Where a role applies is not here: it
// belongs to an assignment, on a person or a group.
import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
import type { RoleInfo } from "@/gen/api";
import { Add, Copy, Delete } from "@/lib/icons";
import { TOOLS } from "@/tools/registry";
import type { MightyClient } from "../client";
import { describeError } from "../messages";
import { COLUMNS, copyId, idFromName, matrixOf, permLabel, toggled, validRoleId } from "./admin";
import { Failure, useLoad } from "./parts";

const TOOL_LABELS: Record<string, string> = { ...Object.fromEntries(TOOLS.map((t) => [t.id, t.label])), k8s: "Kubernetes", kafka: "Kafka" };
const toolLabel = (id: string) => TOOL_LABELS[id] ?? id.charAt(0).toUpperCase() + id.slice(1);

export function RolesPane({ client }: { client: MightyClient }) {
  const toast = useToast();
  const roles = useLoad(() => client.admin.roles.list({}), [client]);
  const [selected, setSelected] = useState<string>("operator");
  const [draft, setDraft] = useState<string[] | null>(null);
  const [dialog, setDialog] = useState<"new" | "copy" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  const list = roles.data?.roles ?? [];
  const role: RoleInfo | undefined = list.find((r) => r.id === selected) ?? list[0];
  const matrix = useMemo(() => matrixOf(roles.data?.catalogue ?? []), [roles.data]);
  useEffect(() => setDraft(null), [role?.id]);
  const permissions = draft ?? role?.permissions ?? [];
  const editable = role !== undefined && !role.builtIn;
  const dirty = draft !== null && role !== undefined && draft.join("|") !== [...role.permissions].sort().join("|");
  const taken = list.map((r) => r.id);

  const run = async (what: string, call: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setProblem(null);
    try {
      await call();
      toast.add({ title: done, type: "success" });
      roles.reload();
      return true;
    } catch (error) {
      setProblem(error);
      toast.add({ title: `${what} failed`, description: describeError(error).title, type: "danger" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const cell = (perm: string | null, label: string) =>
    perm === null ? (
      <span aria-label={`${label}: the tool has no such permission`} className="text-fg-subtle">
        —
      </span>
    ) : (
      <Checkbox checked={permissions.includes(perm)} disabled={!editable} onCheckedChange={(on) => setDraft(toggled(permissions, perm, on === true))} aria-label={`${role?.name ?? ""}, ${label}`} />
    );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-md" data-testid="admin-roles">
      {roles.error ? <Failure error={roles.error} onRetry={roles.reload} /> : null}
      <div className="flex min-h-0 flex-1 gap-inline-lg overflow-hidden">
        <nav aria-label="Roles" className="flex min-h-0 w-1/5 shrink-0 flex-col gap-stack-xs overflow-auto">
          {[
            ["Built in", list.filter((r) => r.builtIn)],
            ["Made here", list.filter((r) => !r.builtIn)],
          ].map(([heading, items]) => (
            <div key={heading as string} className="flex flex-col gap-stack-xs">
              <span className="px-inline-md pt-stack-sm text-caption-1-strong text-fg-muted">{heading as string}</span>
              {(items as RoleInfo[]).map((r) => (
                <button key={r.id} type="button" aria-current={r.id === role?.id ? "true" : undefined} data-role={r.id} onClick={() => setSelected(r.id)} className="rounded-md px-inline-md py-inset-xs text-start text-body-1 hover:bg-hover aria-[current=true]:bg-pressed aria-[current=true]:text-body-1-strong">
                  {r.name}
                </button>
              ))}
              {(items as RoleInfo[]).length === 0 ? <span className="px-inline-md text-caption-1 text-fg-muted">None yet</span> : null}
            </div>
          ))}
          <div className="pt-stack-sm">
            <Button size="small" onClick={() => setDialog("new")}>
              <Icon icon={Add} /> New role
            </Button>
          </div>
        </nav>
        <section aria-label="Role" className="min-h-0 min-w-0 flex-1 overflow-auto">
          {role === undefined ? null : (
            <div className="flex flex-col gap-stack-lg">
              <div className="flex flex-wrap items-center gap-inline-md">
                <h3 className="text-subtitle-2">{role.name}</h3>
                <Badge variant="neutral">{role.builtIn ? "built in, read-only" : "made here"}</Badge>
                <span className="min-w-0 flex-1 text-caption-1 text-fg-muted">{role.description} Where it applies is set when it is given, on a person or a group.</span>
                <Button onClick={() => setDialog("copy")}>
                  <Icon icon={Copy} /> Copy as a new role
                </Button>
                {editable ? (
                  <>
                    <Button appearance="primary" disabled={!dirty} loading={busy} onClick={() => void run("Saving the role", () => client.admin.roles.update({ id: role.id, name: role.name, description: role.description, permissions: draft ?? role.permissions }), "Role saved").then((ok) => ok && setDraft(null))}>
                      Save
                    </Button>
                    <Button appearance="subtle" onClick={() => setDialog("delete")}>
                      <Icon icon={Delete} /> Delete role…
                    </Button>
                  </>
                ) : null}
              </div>
              {problem ? <Failure error={problem} /> : null}
              <table className="w-full border-collapse text-body-1" aria-label={`${role.name}: tools by risk`}>
                <thead>
                  <tr className="text-start text-caption-1 text-fg-muted">
                    <th scope="col" className="px-inset-sm py-inset-xs text-start">
                      Tool
                    </th>
                    {COLUMNS.map((c) => (
                      <th key={c.id} scope="col" className="px-inset-sm py-inset-xs text-start">
                        {c.label}
                        <span className="block font-mono text-caption-2 font-normal text-fg-subtle">{c.id === "files" ? "docker.files.read" : c.id === "secrets" ? "k8s.secrets.read" : `<tool>.${c.id}`}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {matrix.rows.map((row) => (
                    <tr key={row.tool} className="border-t border-border-subtle" data-tool={row.tool}>
                      <th scope="row" className="px-inset-sm py-inset-xs text-start font-normal">
                        {toolLabel(row.tool)}
                      </th>
                      {COLUMNS.map((c) => (
                        <td key={c.id} className="px-inset-sm py-inset-xs">
                          {cell(row.cells[c.id], `${toolLabel(row.tool)}, ${c.label}`)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <section aria-label="Everywhere" className="flex flex-col gap-stack-sm">
                <h4 className="text-body-1-strong">Everywhere</h4>
                <div className="grid grid-cols-2 gap-x-inline-lg gap-y-stack-xs">
                  {matrix.everywhere.map((perm) => (
                    <label key={perm} className="flex items-center gap-inline-sm text-caption-1 text-fg-muted">
                      <Checkbox checked={permissions.includes(perm)} disabled={!editable} onCheckedChange={(on) => setDraft(toggled(permissions, perm, on === true))} aria-label={`${role.name}, ${permLabel(perm)}`} />
                      <span className="font-mono text-fg">{perm}</span>
                    </label>
                  ))}
                </div>
              </section>
            </div>
          )}
        </section>
      </div>
      <NameDialog
        key={dialog ?? "none"}
        open={dialog === "new" || dialog === "copy"}
        title={dialog === "copy" ? `Copy ${role?.name ?? "the role"} as a new role` : "New role"}
        initial={dialog === "copy" && role ? `${role.name} copy` : ""}
        taken={taken}
        onClose={() => setDialog(null)}
        onCreate={async (name, description) => {
          const id = dialog === "copy" && role ? copyId(role.id, taken) : idFromName(name);
          const base = dialog === "copy" && role ? role.permissions : ["app.read", "messaging.read", "profiles.personal"];
          const ok = await run("Creating the role", () => client.admin.roles.create({ id, name, description: description || null, permissions: base }), "Role created");
          if (ok) {
            setDialog(null);
            setSelected(id);
          }
        }}
      />
      {role && editable ? (
        <Dialog open={dialog === "delete"} onOpenChange={(o) => !o && setDialog(null)} size="sm">
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete {role.name}?</DialogTitle>
              <DialogDescription>Everyone who has it loses it, and is signed out. The server asks you to type the role id to confirm.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                appearance="danger"
                onClick={() => {
                  setDialog(null);
                  void run("Deleting the role", () => client.admin.roles.delete({ roleId: role.id }), "Role deleted").then(() => setSelected("operator"));
                }}
              >
                Delete role
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}

function NameDialog({ open, title, initial, taken, onClose, onCreate }: { open: boolean; title: string; initial: string; taken: readonly string[]; onClose(): void; onCreate(name: string, description: string): Promise<void> }) {
  const [name, setName] = useState(initial);
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const id = idFromName(name);
  const problem = name.trim() === "" ? null : !validRoleId(id) ? "Use letters, digits and dashes (2 to 32 characters)." : taken.includes(id) && title === "New role" ? `A role with the id ${id} exists.` : null;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} size="md">
      <DialogContent data-testid="role-name">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>A role made here starts with {title === "New role" ? "what every person gets" : "the permissions it copies"}; tick what it adds.</DialogDescription>
        </DialogHeader>
        <DialogBody className="flex flex-col gap-stack-md">
          <Field invalid={problem !== null}>
            <FieldLabel>Name</FieldLabel>
            <Input value={name} onValueChange={setName} autoComplete="off" />
            <FieldDescription>{problem ?? (name.trim() ? `Its id is ${id}.` : "For example Release manager.")}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>What it is for (optional)</FieldLabel>
            <Input value={description} onValueChange={setDescription} autoComplete="off" />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            appearance="primary"
            disabled={name.trim() === "" || problem !== null}
            loading={busy}
            onClick={() =>
              void (async () => {
                setBusy(true);
                await onCreate(name.trim(), description.trim());
                setBusy(false);
              })()
            }
          >
            Create role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
