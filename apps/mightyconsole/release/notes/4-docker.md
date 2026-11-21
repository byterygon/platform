## Docker over SSH (TSK-81)

- Reach a Docker host through SSH, with no agent installed on it: Mightyconsole opens an SSH
  session and forwards Docker's Unix socket (`/var/run/docker.sock` by default) over it. Log in with
  a private key in the profile (with its passphrase) or your ssh-agent (Linux and macOS). Nothing
  but the SSH hosts in your profiles is contacted.
- **Host keys**: the first connection shows the key's SHA256 fingerprint to trust; a key that has
  changed stops the connection with a warning, and there is no "connect once anyway". **Test
  connection** in the profile sheet tries the profile before you save it. When sshd refuses to
  forward the socket, the error says whether sshd's settings, the docker group or a missing socket
  is the cause.
- **Host**: the engine's facts, disk usage per kind with what is reclaimable, and the host's live
  events.
- **Containers**: grouped by Compose project and kept live through Docker's events; start, stop,
  restart and remove (confirmed) on one or many. A container's tab has an Overview (environment
  values hidden until shown), Logs followed live with ANSI colours, search, stdout and stderr apart
  and Resume, Stats (CPU, memory, network and block I/O charts with a table view, and the
  processes), a Terminal (`docker exec` with a TTY, resize and the exit code), a read-only Files
  browser (folders listed from the container's archive, a preview of text files, download as .tar;
  stopped containers too) and Inspect.
- **Compose projects**: a project's tab merges its containers' logs by time, a service column in
  its own colour and a chip per service to hide it; containers that start later join, and those
  that stop leave a line with their exit code.
- **Images, volumes and networks**: list with what uses each one, inspect, and remove with a
  confirmation; removal is turned off, with the reason, while a running container needs the item,
  and a volume is removed only after its name is typed.
- Every place has its own URL, for example `/docker/<profile>/containers/web/logs`, with the
  breadcrumb and back and forward per tab.
- New generic components in `packages/ui` (MIT OR Apache-2.0): `LogViewer` and `Terminal` (on
  xterm.js), with `terminal.*` design tokens for the ANSI colours in every theme.
