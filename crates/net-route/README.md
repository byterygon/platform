# net-route

Dials `host:port` directly or through a **route** (an ordered list of hops) and hands back a byte
stream; the caller runs its own protocol and TLS over it. DOC-23 "Connection routes" sections 4
and 5, TSK-115. Licence: MIT OR Apache-2.0, so DBee and Mightyconsole both use it; it never
depends on `apps/`.

The crate takes **resolved** hops (DOC-23 (ab)): addresses, logins and keys as values. SSH hosts,
proxies, links and the network map live in the tools' stores, which resolve a path into a `Route`.

## What is in it

| Item | What |
| --- | --- |
| `Dialer` | `direct()`, `through(route)` (checks the route: 1 to 8 hops, every field, each SSH hop's private key decoded), `with_connector`, `with_host_keys`, `with_pool`, `with_budget`; `dial(host, port)` opens the stream, `test(host, port)` reports each hop then the target, up to the first failure, with each SSH hop's host key. |
| `Route`, `Hop` | `httpConnect` (`HttpConnectHop`: `http://` or `https://` proxy, Basic login, pinned CA), `socks5` (`Socks5Hop`: no auth or user and password) and `ssh` (`SshHop`: the SSH host's resolved values and name, a private key with passphrase, a password or the ssh-agent, the trusted host key, keepalive). |
| `SshSession` | A logged-in SSH session over any stream (moved from Mightyconsole's `tools/docker/ssh.rs`): `connect(dialer, hop)`, `open_direct_tcpip`, `open_streamlocal` (Docker's socket), `exec_output`, `lost`, `close`. Streams opened on it keep it alive. |
| `HostKeyCheck`, `TrustedKey`, `fingerprint` | The host key of every SSH hop is decided in the handshake, before any login; `TrustedKey` (the default) trusts exactly the hop's `trusted` key. |
| `SessionPool` | SSH sessions shared by the hops up to and including the SSH hop (by value), one channel per dial, let go 60 s after the last user or when lost. |
| `RouteError`, `HopRef`, `RouteErrorKind` | Every failure names a hop (index, kind, `host:port`) or the target, with the kinds the UI shows: Invalid (with the field), Connect, Timeout, Auth, Forbidden, HostKey (with `HostKeyProblem`: unknown or changed, the key presented, the trusted one, the SSH host's name). |
| `TcpConnect`, `SystemTcp` | The one TCP connection the dialer opens itself (to the first hop, or the target). Mightyconsole puts its outbound policy here. |
| `Secret` | Passwords: wiped on drop, `<redacted>` in `Debug`, never in an error. |
| `is_valid_host`, `format_address` | Hosts are an address or a DNS name, nothing else, so a host never adds a header or an argument. |

## Behaviour

- **Nothing is contacted that the route does not name.** The dialer opens one TCP connection
  (first hop or target); every further address is reached through the hop before it, which also
  resolves the name: CONNECT carries the name, SOCKS5 sends it as a name (ATYP 3).
- **Errors name the right node.** A hop that refuses (407, 403, a SOCKS5 login or ruleset
  refusal, a bad answer, TLS to the proxy) is named; a hop that says it could not reach the next
  address (HTTP 502, 503, 504; SOCKS5 replies 1, 3 to 6) names that next hop or the target.
- **HTTP CONNECT**: any 2xx opens the tunnel, bytes the target sent with the proxy's answer are
  kept; 407 is Auth (only Basic is spoken), 403 Forbidden, other statuses Connect with the status
  line. The answer head is read up to 16 KiB.
- **SSH**: `direct-tcpip` to the next address; two SSH hops in a row run the second session over
  the first one's channel (`ssh -J a,b`). The host key is checked on every hop with no way to
  skip it: unknown or changed stops the handshake before any password, signature or agent request,
  and the `HostKey` error names the hop and the SSH host whose Trust saves the key. sshd's refusal
  to forward (`AllowTcpForwarding no`, `PermitOpen`) is Forbidden and says so; a host that cannot
  reach the next address names that address.
- **Pool**: with `with_pool`, a dial starts at the deepest SSH hop with a live pooled session and
  opens a channel there; Test never uses the pool (it logs in to every hop itself).
- **Timeouts**: a budget for the whole route (20 s by default, `with_budget`), and caps per step:
  10 s for the TCP connection, 10 s for a proxy hop to let the client in and 10 s again to open
  the next stream, 20 s for an SSH login, 10 s for an SSH channel. A timeout says whether the cap
  or the budget ran out.
- **Cancellation**: dropping the `dial` future closes every half-open connection.

Still to come (TSK-115 batch 3): `sshCommand`, local `command` hops and the opt-in system proxy.

## Tests

- `cargo test -p net-route`: unit tests and `tests/conformance.rs` against in-process fakes (an
  echo target that speaks first, an HTTP CONNECT proxy with TLS, a login, forced statuses and
  silence, a SOCKS5 proxy with a login and forced replies), and `tests/ssh.rs` against stand-in
  sshds (russh servers that forward to the names of their own table, refuse forwarding for one
  user, and log logins and closed sessions). The fakes resolve names from their own table only, so
  reaching `echo.internal` proves the name went to the proxy or the jump host.
- `cargo test -p net-route --features lab-tests --test lab`: against the Mightyconsole lab's
  `routes` profile (`node apps/mightyconsole/lab/lab.mts up routes`): squid with Basic auth on a
  plain and a TLS port, Dante with a login, two OpenSSH jump hosts (the second reached only through
  the first or a proxy; a user that may not forward), a SOCKS5 → squid chain, and targets on a
  Docker network that only the proxies and jump hosts reach. The lab workflow runs it whenever the `routes` profile is up.
