#!/bin/sh
# Smoke test of the CI image, run inside it with the options ci.yml gives its jobs:
#
#   docker run --rm --user 1001 --cap-add SYS_ADMIN --cap-add NET_ADMIN --shm-size 2g \
#     -v "$PWD/.github/ci-image/verify.sh:/verify.sh:ro" IMAGE sh /verify.sh
#
# Checks what the Rust and DBee desktop budget jobs need from it: the user and sudo, the network
# namespace step exactly as ci.yml writes it (loopback only, back to the runner user, cargo still
# found), PostgreSQL started from initdb as that user, Xvfb, Chrome under Xvfb with no network,
# and the Rust toolchain with the WebKitGTK development files.
set -eu

step() { printf '\n== %s\n' "$*"; }

step "user and sudo"
id
[ "$(id -u)" = 1001 ] || { echo "expected uid 1001"; exit 1; }
sudo -n true

step "Rust toolchain and WebKitGTK"
rustc --version
cargo --version
cargo clippy --version
rustfmt --version
pkg-config --modversion webkit2gtk-4.1 gtk+-3.0

step "network namespace (as ci.yml runs it)"
sudo unshare --net -- sh -c '
  set -e
  ip link set lo up
  if timeout 3 bash -c "exec 3<>/dev/tcp/1.1.1.1/443" 2>/dev/null; then
    echo "network is reachable"; exit 1
  fi
  setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups \
    env PATH="$1" HOME="$2" sh -c "id -u; cargo --version"
' sh "$PATH" "$HOME"

step "PostgreSQL from initdb, as the runner user"
bin=$(ls -d /usr/lib/postgresql/*/bin | sort -V | tail -1)
pg=$(mktemp -d)
"$bin/initdb" -D "$pg/data" -U postgres --auth=trust --no-sync >/dev/null
"$bin/pg_ctl" -D "$pg/data" -o "-c listen_addresses=127.0.0.1 -c port=55439 -c unix_socket_directories=''" -l "$pg/log" -w start >/dev/null
"$bin/psql" -X -q -h 127.0.0.1 -p 55439 -U postgres -d postgres -tAc 'select version()'
"$bin/pg_ctl" -D "$pg/data" -m fast stop >/dev/null
rm -rf "$pg"

step "Chrome under Xvfb, no network"
google-chrome --version
profile=$(mktemp -d)
sudo unshare --net -- sh -c '
  set -e
  ip link set lo up
  setpriv --reuid="$SUDO_UID" --regid="$SUDO_GID" --init-groups env PATH="$1" HOME="$2" \
    timeout 60 xvfb-run -a google-chrome --no-sandbox --disable-gpu --headless=new \
      --user-data-dir="$3" --dump-dom "data:text/html,<p id=ok>ci-image-ok</p>" 2>/dev/null
' sh "$PATH" "$HOME" "$profile" > "$profile.dom"
grep -q ci-image-ok "$profile.dom" || { echo "Chrome did not render the page"; exit 1; }
rm -rf "$profile" "$profile.dom"
echo "ok"

printf '\nCI image: all checks passed\n'
