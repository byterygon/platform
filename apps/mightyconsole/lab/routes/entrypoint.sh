#!/bin/sh
# The roles of the routes lab image (TSK-115). The logins come from /generated/routes/env and the
# squid TLS certificate from /generated/routes/, both written by `lab up` (generate).
#
#   squid   HTTP CONNECT proxy: 3128 plain, 3129 TLS; Basic auth required (PROXY_USER, and
#           DECOY_USER for the tests of a wrong password); CONNECT to port 25 refused (403), every
#           other port allowed
#   socks   Dante SOCKS5 on 1080: user and password (a system user of this container)
#   echo    targets: 7 says "HELLO routes-echo" and echoes, 8080 serves an HTTP page
#   jump    sshd on 22: users lab and nofwd log in with the lab's keys (/generated/ssh); nofwd may
#           not forward TCP; host keys made at start
set -eu
role="${1:?usage: entrypoint.sh squid|socks|echo|jump}"
# shellcheck disable=SC1091
[ -f /generated/routes/env ] && . /generated/routes/env

case "$role" in
squid)
  install -d -o squid -g squid /run/squid /var/log/squid /var/cache/squid
  install -m 0640 -o root -g squid /generated/routes/squid.pem /etc/squid/lab.pem
  install -m 0640 -o root -g squid /generated/routes/squid-key.pem /etc/squid/lab-key.pem
  {
    printf '%s:%s\n' "$PROXY_USER" "$(cryptpw -m sha512 "$PROXY_PASSWORD")"
    # A second login, so a test of a wrong password never shares squid's per-user auth record
    # with the user the other tests log in with (TSK-147).
    printf '%s:%s\n' "$DECOY_USER" "$(cryptpw -m sha512 "$DECOY_PASSWORD")"
  } > /etc/squid/passwd
  chown root:squid /etc/squid/passwd && chmod 0640 /etc/squid/passwd
  cat > /etc/squid/lab.conf <<'EOF'
http_port 3128
https_port 3129 tls-cert=/etc/squid/lab.pem tls-key=/etc/squid/lab-key.pem
visible_hostname routes-squid
cache_effective_user squid
pid_filename /run/squid/squid.pid
coredump_dir /var/cache/squid
cache_log /var/log/squid/cache.log
access_log stdio:/var/log/squid/access.log
cache deny all
auth_param basic program /usr/lib/squid/basic_ncsa_auth /etc/squid/passwd
auth_param basic realm routes-lab
acl authed proxy_auth REQUIRED
acl smtp port 25
http_access deny CONNECT smtp
http_access allow authed
http_access deny all
EOF
  # A restarted container keeps /run: a PID file naming PID 1 would stop squid as "already running".
  rm -f /run/squid/squid.pid
  exec squid -N -f /etc/squid/lab.conf
  ;;
socks)
  id "$SOCKS_USER" >/dev/null 2>&1 || adduser -D -H -s /sbin/nologin "$SOCKS_USER"
  printf '%s:%s\n' "$SOCKS_USER" "$SOCKS_PASSWORD" | chpasswd >/dev/null
  {
    echo "logoutput: stderr"
    echo "internal: 0.0.0.0 port = 1080"
    # Out through whichever network reaches the address (the internal one for the targets).
    for i in $(ls /sys/class/net); do [ "$i" = lo ] || echo "external: $i"; done
    echo "external.rotation: route"
    echo "socksmethod: username"
    echo "clientmethod: none"
    echo "user.privileged: root"
    echo "user.unprivileged: nobody"
    echo "client pass { from: 0.0.0.0/0 to: 0.0.0.0/0 }"
    echo "socks pass { from: 0.0.0.0/0 to: 0.0.0.0/0 command: connect }"
  } > /etc/sockd.conf
  exec sockd -f /etc/sockd.conf
  ;;
echo)
  mkdir -p /www && echo "routes-echo" > /www/index.html
  httpd -p 8080 -h /www
  exec socat TCP-LISTEN:7,fork,reuseaddr SYSTEM:'echo HELLO routes-echo; exec cat'
  ;;
jump)
  ssh-keygen -A >/dev/null
  for user in lab nofwd; do
    install -d -m 0700 -o "$user" -g "$user" "/home/$user/.ssh"
    install -m 0600 -o "$user" -g "$user" /generated/ssh/authorized_keys "/home/$user/.ssh/authorized_keys"
  done
  exec /usr/sbin/sshd -D -e
  ;;
*)
  echo "entrypoint.sh: unknown role $role" >&2
  exit 2
  ;;
esac
