# The lab's Docker host reached over SSH (TSK-81): Docker in Docker with an OpenSSH server.
# User `lab` logs in with the generated keys and is in the docker group; user `labpw` logs in
# with the generated password; user `nofwd` logs in with the same keys but sshd refuses to
# forward Unix sockets for it (the explained error of spec §10.3). The base is pinned by digest;
# openssh comes from that Alpine release's repository. sshd keeps the first value of a setting,
# and Alpine's sshd_config says `AllowTcpForwarding no` (which also stops socket forwarding), so
# the lab's settings go in sshd_config.d, included before it. Lab only, never shipped.
FROM docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac
RUN apk add --no-cache openssh-server \
 && (getent group docker >/dev/null || addgroup -S docker) \
 && adduser -D -s /bin/sh lab && adduser lab docker \
 && sed -i 's/^lab:!/lab:*/' /etc/shadow \
 && adduser -D -s /bin/sh labpw && adduser labpw docker \
 && adduser -D -s /bin/sh nofwd && adduser nofwd docker \
 && sed -i 's/^nofwd:!/nofwd:*/' /etc/shadow \
 && printf 'AllowStreamLocalForwarding yes\nAllowTcpForwarding yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/10-lab.conf \
 && printf 'Match User nofwd\n    AllowStreamLocalForwarding no\n' >> /etc/ssh/sshd_config
COPY entrypoint.sh seed.sh shop.yaml /lab/
ENTRYPOINT ["/bin/sh", "/lab/entrypoint.sh"]
