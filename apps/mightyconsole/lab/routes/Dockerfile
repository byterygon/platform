# The lab's connection routes (TSK-115, DOC-23 section 12): one image for the proxies and the
# targets behind them, each service choosing its role (entrypoint.sh). squid is the HTTP CONNECT
# proxy (Basic auth, a plain port and a TLS port), Dante the SOCKS5 proxy (user and password),
# socat and httpd (busybox-extras) the targets on the internal network. The base is pinned by digest; the
# packages come from that Alpine release's repository. Lab only, never shipped.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
RUN apk add --no-cache squid dante-server socat busybox-extras
COPY entrypoint.sh /lab/entrypoint.sh
ENTRYPOINT ["/bin/sh", "/lab/entrypoint.sh"]
