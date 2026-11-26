# The lab's connection routes (TSK-115, DOC-23 section 12): one image for the proxies, the jump
# hosts and the targets behind them, each service choosing its role (entrypoint.sh). squid is the
# HTTP CONNECT proxy (Basic auth, a plain port and a TLS port), Dante the SOCKS5 proxy (user and
# password), OpenSSH the jump hosts (user `lab` with the lab's keys; user `nofwd` with the same
# keys but no TCP forwarding), socat and httpd (busybox-extras) the targets on the internal
# network. The base is pinned by digest; the packages come from that Alpine release's
# repository. Alpine's sshd_config says `AllowTcpForwarding no` and sshd keeps the first value of
# a setting, so the lab's settings go in sshd_config.d (included before it); the Match block goes
# at the end of sshd_config, where it cannot capture the main settings. Lab only, never shipped.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
RUN apk add --no-cache squid dante-server socat busybox-extras openssh-server \
 && adduser -D -s /bin/sh lab && sed -i 's/^lab:!/lab:*/' /etc/shadow \
 && adduser -D -s /bin/sh nofwd && sed -i 's/^nofwd:!/nofwd:*/' /etc/shadow \
 && printf 'AllowTcpForwarding yes\nPasswordAuthentication no\n' > /etc/ssh/sshd_config.d/10-lab.conf \
 && printf 'Match User nofwd\n    AllowTcpForwarding no\n' >> /etc/ssh/sshd_config
COPY entrypoint.sh /lab/entrypoint.sh
ENTRYPOINT ["/bin/sh", "/lab/entrypoint.sh"]
