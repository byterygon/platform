// TSK-82, Kubernetes (Mightyconsole spec section 18, against the lab). Not wired yet: TSK-82 adds the
// checks of each item (cargo tests with the lab-tests feature, UI tests, a browser walk with
// screenshots: see foundation.mts) before it closes, then runs
// `pnpm --filter @byterygon/mightyconsole acceptance k8s --lab-up --strict`.
import type { Checklist } from "../checklist.mts";

export default {
  id: "k8s",
  task: "TSK-82",
  title: "Kubernetes",
  builtWhen: "apps/mightyconsole/server/src/tools/k8s",
  lab: ["k8s"],
  items: [
    {
      id: "kubeconfig",
      text: "A pasted kubeconfig lists its contexts; an exec plugin is refused with the program named while the profile switch is off.",
      checks: [],
    },
    {
      id: "discovery",
      text: "Discovery includes the lab CRD; built-in and custom resources list with the server's printer columns and update live through the watch; a forced 410 leads to a RESYNC.",
      lab: true,
      checks: [],
    },
    {
      id: "yaml",
      text: "YAML view without managed fields; edit with dry run and diff, apply, a field-manager conflict and Force; multi-document apply from the Apply tab.",
      lab: true,
      checks: [],
    },
    {
      id: "actions",
      text: "Delete with propagation and the typed name for namespaces; scale; restart; events for an object.",
      lab: true,
      checks: [],
    },
    {
      id: "secrets",
      text: "Secrets are redacted in list and get and shown only after Reveal.",
      lab: true,
      checks: [],
    },
    {
      id: "logs-exec",
      text: "Pod logs follow, previous (the crash-looping pod), tail and timestamps, with ANSI colours in the LogViewer; exec gives an interactive shell in the Terminal that resizes and reports the exit code.",
      lab: true,
      checks: [],
    },
    {
      id: "components",
      text: "LogViewer and Terminal (and the terminal.* tokens) are in packages/ui if this task lands first; CI green.",
      checks: [],
    },
  ],
} satisfies Checklist;
