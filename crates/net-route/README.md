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
| `Dialer` | `direct()`, `through(route)` (checks the route: 1 to 8 hops, every field), `with_connector`, `with_budget`; `dial(host, port)` opens the stream, `test(host, port)` reports each hop then the target, up to the first failure. |
| `Route`, `Hop` | `httpConnect` (`HttpConnectHop`: `http://` or `https://` proxy, Basic login, pinned CA) and `socks5` (`Socks5Hop`: no auth or user and password). |
| `RouteError`, `HopRef`, `RouteErrorKind` | Every failure names a hop (index, kind, `host:port`) or the target, with the kinds the UI shows: Invalid, Connect, Timeout, Auth, Forbidden. |
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
- **Timeouts**: a budget for the whole route (20 s by default, `with_budget`), and caps per step:
  10 s for the TCP connection, 10 s for a proxy hop. A timeout says whether the cap or the budget
  ran out.
- **Cancellation**: dropping the `dial` future closes every half-open connection.

Still to come (TSK-115 batches 2 and 3): SSH jump hosts with the session pool and the host-key
callback (moved from Mightyconsole's `tools/docker/ssh.rs`), `sshCommand`, local `command` hops
and the opt-in system proxy.

## Tests

- `cargo test -p net-route`: unit tests and `tests/conformance.rs` against in-process fakes (an
  echo target that speaks first, an HTTP CONNECT proxy with TLS, a login, forced statuses and
  silence, a SOCKS5 proxy with a login and forced replies). The fakes resolve names from their own
  table only, so reaching `echo.internal` proves the name went to the proxy.
- `cargo test -p net-route --features lab-tests --test lab`: against the Mightyconsole lab's
  `routes` profile (`node apps/mightyconsole/lab/lab.mts up routes`): squid with Basic auth on a
  plain and a TLS port, Dante with a login, a SOCKS5 → squid chain, and targets on a Docker network
  that only the proxies reach. The lab workflow runs it whenever the `routes` profile is up.
