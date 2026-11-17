# The lab's Docker host reached over SSH (TSK-81): Docker in Docker with an OpenSSH server.
# User `lab` logs in with the generated keys and is in the docker group; user `labpw` logs in
# with the generated password. The base is pinned by digest; openssh comes from that Alpine
# release's repository. Lab only, never shipped.
FROM docker:28-dind@sha256:2a232a42256f70d78e3cc5d2b5d6b3276710a0de0596c145f627ecfae90282ac
RUN apk add --no-cache openssh-server \
 && (getent group docker >/dev/null || addgroup -S docker) \
 && adduser -D -s /bin/sh lab && adduser lab docker \
 && sed -i 's/^lab:!/lab:*/' /etc/shadow \
 && adduser -D -s /bin/sh labpw && adduser labpw docker \
 && printf 'AllowStreamLocalForwarding yes\nAllowTcpForwarding yes\nPasswordAuthentication yes\n' >> /etc/ssh/sshd_config
COPY entrypoint.sh seed.sh shop.yaml /lab/
ENTRYPOINT ["/bin/sh", "/lab/entrypoint.sh"]
