#!/bin/sh
# DBee acceptance databases (TSK-61): two throwaway PostgreSQL servers in Docker, ports on
# 127.0.0.1 only, data in tmpfs. See README.md.
#
#   ./acceptance.sh up        start both servers (fresh), wait until the data is loaded
#   ./acceptance.sh down      stop and remove everything, including .state/
#   ./acceptance.sh status    containers, ports and the TLS fingerprint
#   ./acceptance.sh env       shell exports for the tests and the desktop driver
#   ./acceptance.sh test      recreate pg-tls, then run dbee-core's PostgreSQL tests and
#                             dbee-server's end-to-end test against it
set -eu

here=$(cd "$(dirname "$0")" && pwd)
state="$here/.state"
# Docker Compose v2, as the CLI plugin or the standalone binary.
if docker compose version >/dev/null 2>&1; then
  compose() { docker compose --project-directory "$here" -f "$here/compose.yaml" "$@"; }
else
  compose() { docker-compose --project-directory "$here" -f "$here/compose.yaml" "$@"; }
fi

load_env() {
  if [ ! -f "$state/env" ]; then
    mkdir -p "$state/tls"
    umask 077
    {
      printf 'DBEE_ACC_SUPERUSER_PASSWORD=%s\n' "$(openssl rand -hex 16)"
      printf 'DBEE_ACC_PASSWORD=%s\n' "$(openssl rand -hex 16)"
    } > "$state/env"
  fi
  set -a
  . "$state/env"
  set +a
  DBEE_ACC_PLAIN_PORT=${DBEE_ACC_PLAIN_PORT:-55432}
  DBEE_ACC_TLS_PORT=${DBEE_ACC_TLS_PORT:-55433}
  export DBEE_ACC_PLAIN_PORT DBEE_ACC_TLS_PORT
}

wait_tls() {
  i=0
  until [ -s "$state/tls/fingerprint" ]; do
    i=$((i + 1))
    [ "$i" -gt 120 ] && { echo "pg-tls wrote no certificate" >&2; exit 1; }
    sleep 1
  done
  printf '%s\n' "$DBEE_ACC_TLS_PORT" > "$state/tls/port"
}

up() {
  load_env
  rm -f "$state/tls/"*
  started=$(date +%s)
  compose up --detach --force-recreate --wait --wait-timeout 900
  wait_tls
  echo "ready in $(( $(date +%s) - started )) s"
  status
}

status() {
  load_env
  compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}'
  [ -s "$state/tls/fingerprint" ] && echo "pg-tls certificate: $(cat "$state/tls/fingerprint") (name db.test, CA in $state/tls/ca.pem)"
  return 0
}

env_exports() {
  load_env
  cat <<EOF
export DBEE_ACC_PLAIN_PORT=$DBEE_ACC_PLAIN_PORT
export DBEE_ACC_TLS_PORT=$DBEE_ACC_TLS_PORT
export DBEE_ACC_PASSWORD=$DBEE_ACC_PASSWORD
export DBEE_ACC_TLS_DIR=$state/tls
export BYTERYGON_PG_EXTERNAL=$state/tls
EOF
}

run_tests() {
  load_env
  rm -f "$state/tls/"*
  # The tests create roles, so each run gets a fresh server.
  compose up --detach --force-recreate --wait --wait-timeout 300 pg-tls
  wait_tls
  root=$(cd "$here/../../.." && pwd)
  cd "$root"
  BYTERYGON_PG_EXTERNAL="$state/tls" BYTERYGON_REQUIRE_POSTGRES=1 \
    cargo test --locked -p dbee-core --test postgres
  compose up --detach --force-recreate --wait --wait-timeout 300 pg-tls
  wait_tls
  BYTERYGON_PG_EXTERNAL="$state/tls" BYTERYGON_REQUIRE_POSTGRES=1 \
    cargo test --locked -p dbee-server --test e2e
}

case "${1:-}" in
  up) up ;;
  down)
    load_env
    compose down --volumes --remove-orphans
    rm -rf "$state"
    ;;
  status) status ;;
  env) env_exports ;;
  test) run_tests ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
