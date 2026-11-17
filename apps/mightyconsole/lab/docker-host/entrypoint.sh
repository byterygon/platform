#!/bin/sh
# Keys and the password from lab/.generated, then sshd and dockerd (docker.sock group docker).
set -e
install -d -m 700 -o lab -g lab /home/lab/.ssh
install -m 600 -o lab -g lab /generated/ssh/authorized_keys /home/lab/.ssh/authorized_keys
echo "labpw:$(cat /generated/ssh/labpw.password)" | chpasswd
ssh-keygen -A >/dev/null
/usr/sbin/sshd -e
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock --group docker
