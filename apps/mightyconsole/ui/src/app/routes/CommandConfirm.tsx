// The command confirmation (DOC-23 11.3, (j), (s); mockup frames routes-command-confirm and
// routes-command-changed): a command that arrived by import, or whose program, arguments,
// variable names or line changed, cannot run until a person has read it in full: the program and
// where it runs, as whom, the environment with secrets hidden, every argument exactly as passed,
// and, after a change, what changed. The button says what it allows; Cancel leaves the route saved
// and unusable ("Not confirmed").
import { AlertDialog, AlertDialogBody, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Code } from "@/components/ui/code";
import type { HopView, RouteView } from "@/gen/api";
import { sshHostById } from "@/profiles/ssh-hosts";

export interface CommandConfirmProps {
  route: RouteView | null;
  /** The hops to confirm (those not confirmed yet). */
  hops: readonly HopView[];
  /** The same hops before a change, by position, for the diff. */
  before?: readonly (HopView | undefined)[];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

function argsDiff(now: readonly string[], was: readonly string[] | undefined) {
  if (!was) return now.map((a) => ({ text: a, change: "same" as const }));
  const out: { text: string; change: "same" | "added" | "removed" }[] = [];
  for (const a of was) if (!now.includes(a)) out.push({ text: a, change: "removed" });
  for (const a of now) out.push({ text: a, change: was.includes(a) ? "same" : "added" });
  return out;
}

export function CommandConfirm({ route, hops, before, busy = false, onConfirm, onCancel }: CommandConfirmProps) {
  const local = hops.some((h) => h.kind === "command");
  return (
    <AlertDialog open={route !== null && hops.length > 0} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Read the commands of {route?.name} before they run</AlertDialogTitle>
          <AlertDialogDescription>
            This route runs {hops.length === 1 ? "a command" : `${hops.length} commands`} that nobody confirmed yet{before?.some(Boolean) ? " since they changed" : ""}. Until you confirm, the route cannot be tested, chosen or used.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogBody className="flex flex-col gap-stack-md">
          {hops.map((h) => {
            const index = route?.hops.findIndex((x) => x.linkId === h.linkId) ?? -1;
            const was = index >= 0 ? before?.[index] : undefined;
            if (h.kind === "sshCommand") {
              const host = sshHostById(h.sshHostId);
              return (
                <section key={h.linkId} aria-label={`Hop ${index + 1}, SSH command`} className="flex flex-col gap-stack-xs">
                  <h4 className="text-body-1-strong">
                    Hop {index + 1}: a command on {host?.name ?? h.label}
                  </h4>
                  <p className="text-body-1 text-fg-muted">
                    Runs on <b>{h.label}</b> as <b>{host?.fields.username ?? "the host's user"}</b>, read by that user's login shell.
                  </p>
                  {was?.command && was.command !== h.command ? (
                    <Code className="break-all line-through" aria-label="Before">
                      {was.command}
                    </Code>
                  ) : null}
                  <Code className="break-all">{h.command}</Code>
                </section>
              );
            }
            const diff = argsDiff(h.args, was?.args);
            return (
              <section key={h.linkId} aria-label={`Hop ${index + 1}, local command`} className="flex flex-col gap-stack-xs">
                <h4 className="text-body-1-strong">Hop {index + 1}: a program on this server</h4>
                <p className="text-body-1 text-fg-muted">
                  Runs <Code>{h.program}</Code> (an absolute path, or found on the server's PATH) on the server's own machine, as the user running mightyconsole-server, without a shell.
                </p>
                <div>
                  <span className="text-caption-1-strong">Arguments, exactly as passed</span>
                  <ol className="flex flex-col gap-stack-xs" aria-label="Arguments">
                    {diff.length === 0 ? <li className="text-caption-1 text-fg-muted">none</li> : null}
                    {diff.map((a, i) => (
                      <li key={`${a.change}-${i}`} className={a.change === "removed" ? "text-danger-fg line-through" : a.change === "added" ? "text-warning-fg" : ""}>
                        <Code className="break-all">{a.text === "" ? '""' : a.text}</Code>
                        {a.change !== "same" ? <span className="ms-inline-xs text-caption-1">{a.change}</span> : null}
                        {/^--?(proxy|exec|command|config|o)\b/i.test(a.text) ? <span className="ms-inline-xs text-caption-1 text-warning-fg">can make it run something else</span> : null}
                      </li>
                    ))}
                  </ol>
                </div>
                <div>
                  <span className="text-caption-1-strong">Environment</span>
                  <ul className="flex flex-col gap-stack-xs" aria-label="Environment">
                    <li className="text-caption-1 text-fg-muted">a clean one: PATH, HOME, USER, LANG, TMPDIR, plus:</li>
                    {h.env.map((v) => (
                      <li key={v.name}>
                        <Code>{v.name}</Code> = {v.secret ? <span className="text-fg-muted">a secret ({v.set ? "set" : "not set"})</span> : <Code>{v.value ?? ""}</Code>}
                      </li>
                    ))}
                  </ul>
                </div>
                {h.cwd ? (
                  <p className="text-body-1">
                    Working directory <Code>{h.cwd}</Code>
                  </p>
                ) : null}
              </section>
            );
          })}
          {local ? <p className="text-caption-1 text-fg-muted">Confirming a local command needs profiles.hostAccess (admin only by default).</p> : null}
        </AlertDialogBody>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <Button appearance="primary" loading={busy} onClick={onConfirm}>
            Let this route run {hops.length === 1 ? "it" : "them"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
