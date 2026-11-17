// TSK-81, Docker over SSH (Mightyconsole spec section 18, against the lab). Not wired yet: TSK-81 adds the
// checks of each item (cargo tests with the lab-tests feature, UI tests, a browser walk with
// screenshots: see foundation.mts) before it closes, then runs
// `pnpm --filter @byterygon/mightyconsole acceptance docker --lab-up --strict`.
import type { Checklist } from "../checklist.mts";

export default {
  id: "docker",
  task: "TSK-81",
  title: "Docker over SSH",
  builtWhen: "apps/mightyconsole/server/src/tools/docker",
  lab: ["docker"],
  items: [
    {
      id: "host-key",
      text: "First connect shows the host key fingerprint and connects only after Trust; a changed key is refused until replaced; private key, key with passphrase, password and agent all work.",
      lab: true,
      checks: [],
    },
    {
      id: "containers",
      text: "Containers list grouped by Compose project and updated through events; start, stop, restart; remove with confirmation and options.",
      lab: true,
      checks: [],
    },
    {
      id: "logs-exec",
      text: "Logs with stdout and stderr separated (and the TTY container); live stats; exec terminal with resize and exit code.",
      lab: true,
      checks: [],
    },
    {
      id: "resources",
      text: "Images, volumes and networks: list, inspect, remove with the in-use refusal; the host info.",
      lab: true,
      checks: [],
    },
    {
      id: "errors",
      text: "A host without streamlocal forwarding gives the explained error; LogViewer and Terminal in packages/ui if this task lands first; CI green.",
      lab: true,
      checks: [],
    },
  ],
} satisfies Checklist;
