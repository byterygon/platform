#!/bin/sh
# Keys (users lab and nofwd) and the password from lab/.generated, then sshd and dockerd (docker.sock group docker).
# TSK-116: dockerd also listens on 2376 with TLS and client certificates (lab/.generated/docker-tcp);
# socat serves the same socket on 2375 without TLS (dockerd puts TLS on every TCP listener) and as
# /run/lab-docker/docker.sock, a folder of lab/.generated that only the lab's user can open.
set -e
install -d -m 700 -o lab -g lab /home/lab/.ssh
install -m 600 -o lab -g lab /generated/ssh/authorized_keys /home/lab/.ssh/authorized_keys
install -d -m 700 -o nofwd -g nofwd /home/nofwd/.ssh
install -m 600 -o nofwd -g nofwd /generated/ssh/authorized_keys /home/nofwd/.ssh/authorized_keys
echo "labpw:$(cat /generated/ssh/labpw.password)" | chpasswd
ssh-keygen -A >/dev/null
/usr/sbin/sshd -e
socat TCP-LISTEN:2375,fork,reuseaddr UNIX-CONNECT:/var/run/docker.sock &
socat UNIX-LISTEN:/run/lab-docker/docker.sock,fork,unlink-early,mode=666 UNIX-CONNECT:/var/run/docker.sock &
TLS=/generated/docker-tcp
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --group docker \
  --host=tcp://0.0.0.0:2376 --tlsverify --tlscacert=$TLS/ca.pem --tlscert=$TLS/server.pem --tlskey=$TLS/server-key.pem
