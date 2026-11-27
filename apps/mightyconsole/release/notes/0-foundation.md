## The base (TSK-79)

- One server, `mightyconsole-server`, with the web UI built in, on `https://localhost:7443` (127.0.0.1
  only by default) over TLS with a self-signed certificate made on first start, or your own.
- The Fluent 2 shell shared with DBee: a tool rail, connections per tool, tabs restored after a
  reload, a command bar, a status bar, the command palette, Settings and About.
- Connection profiles on the server, personal or shared, their secrets encrypted with the server's
  key and write-only: no page, answer or log shows a secret again. Profiles an earlier version
  kept in the browser move once, with a backup first. Export saves settings, never secrets.
- Everyone signs in: built-in accounts (sign-up, optional TOTP) and OIDC; the default
  administrator's password is in `DATA/admin-password` (see README).
- Roles per tool and risk, with a screen for people, roles and OIDC group mappings; destroying
  needs a confirmation, and a person has every right on the profiles they add themselves.
- A durable, hash-chained audit log (sign-ins, writes, destroys, sensitive reads, refused calls)
  with a screen to filter, verify and export it, online backup and restore, key rotation, and
  start checks that refuse an unsafe configuration (README, "Run it securely").
- Routes: Settings > Routes and the network map describe how the server reaches a host (HTTP
  proxy, SOCKS5, SSH jump hosts, a local command); a profile's **Connect through** picks one and
  a failure names the hop.
