// TSK-81, Docker over SSH (Mightyconsole spec section 18, against the lab's docker-host). The
// server's checks: tests/docker.rs against a stand-in SSH server, tests/docker_lab.rs (feature
// lab-tests) against the lab's sshd and Docker. The UI's: test/docker.test.tsx (jsdom). Batch 1
// wires host-key and errors; the other items come with their batches. Run
// `pnpm --filter @byterygon/mightyconsole acceptance docker --lab-up --strict`.
import { type Checklist, cargo, command, manual, vitest } from "../checklist.mts";

const lab = (filter: string) => cargo(filter, { features: ["lab-tests"] });

/** The ssh-agent login against the lab: an agent of its own (a short socket path), holding the lab key only. */
const AGENT = [
  "set -e",
  'sock="/tmp/mc-agent-$$.sock"',
  'eval "$(ssh-agent -a "$sock" -s)" >/dev/null',
  'trap \'kill "$SSH_AGENT_PID"\' EXIT',
  'test "$SSH_AUTH_SOCK" = "$sock"',
  "ssh-add apps/mightyconsole/lab/.generated/ssh/lab_ed25519",
  "MIGHTYCONSOLE_LAB_DOCKER_AGENT=1 cargo test -p mightyconsole-server --features lab-tests --test docker_lab -- lab_trust_on_first_use_then_every_login_method",
].join("\n");

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
      checks: [
        cargo("an_unknown_host_key_stops_the_connection_before_any_login"),
        cargo("passwords_and_keys_are_checked_and_never_echoed"),
        command("lab: trust on first use, a changed key, key, key with passphrase, password and ssh-agent", ["sh", "-c", AGENT], { requires: ["ssh-agent", "ssh-add"] }),
        vitest("test/docker.test.tsx", "trust on first use in the shell"),
        vitest("test/docker.test.tsx", "host key dialog"),
      ],
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
      checks: [
        cargo("a_host_that_does_not_forward_the_socket_is_explained"),
        cargo("a_session_the_host_ends_turns_the_connection_failed"),
        lab("lab_a_user_without_socket_forwarding_gets_the_explained_error"),
        manual("LogViewer and Terminal in packages/ui (TSK-81 batch 2) and CI green on every TSK-81 PR"),
      ],
    },
  ],
} satisfies Checklist;
