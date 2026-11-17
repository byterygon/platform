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
#   ./acceptance.sh perf [--port P] [--runs N] [--out DIR] [--no-build]
#                             the DOC-18 section 1 budget on the desktop app (release build):
#                             cold start of dbee-desktop, then the driver (examples/acceptance)
#                             against pg-plain, or any server with the data on 127.0.0.1:P
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

perf() {
  port="" runs=3 out="" build=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) port=$2; shift 2 ;;
      --runs) runs=$2; shift 2 ;;
      --out) out=$2; shift 2 ;;
      --no-build) build=0; shift ;;
      *) echo "perf: unknown option $1" >&2; exit 2 ;;
    esac
  done
  if [ -z "$port" ]; then load_env; port=$DBEE_ACC_PLAIN_PORT; fi
  root=$(cd "$here/../../.." && pwd)
  cd "$root"
  if [ "$build" = 1 ]; then
    cargo build --release --locked -p dbee-desktop --bin dbee-desktop --example acceptance
  fi
  target=${CARGO_TARGET_DIR:-$root/target}/release
  workspace=$(mktemp -d "${TMPDIR:-/tmp}/dbee-acceptance.XXXXXX")
  out=${out:-$workspace/reports}
  mkdir -p "$out"
  "$target/examples/acceptance" prepare --workspace "$workspace" --port "$port" > "$out/prepare.json"
  i=1
  while [ "$i" -le "$runs" ]; do
    echo "cold start $i:"
    DBEE_WORKSPACE="$workspace" DBEE_COLD_START_EXIT=1 "$target/dbee-desktop" 2>&1 | grep ' ms after process start' | tee -a "$out/cold-start.txt"
    i=$((i + 1))
  done
  i=1 failed=0
  while [ "$i" -le "$runs" ]; do
    echo "driver run $i:"
    # A failed run is reported and the next one still runs; perf fails at the end.
    "$target/examples/acceptance" perf --workspace "$workspace" --out "$out/run-$i.json" > /dev/null || failed=1
    node -e '
      const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (r.error) { console.log("  error:", r.error.slice(0, 2000)); process.exit(1); }
      const f = (x) => (typeof x === "number" ? x.toFixed(1) : String(x));
      const s = r.run.scroll;
      console.log(`  usable window ${r.usableWindowMs} ms; tree: first level ${f(r.tree.firstLevelMs)} ms, schema expand ${f(r.tree.schemaExpandMs)} ms, Tables group ${f(r.tree.tablesGroupExpandMs)} ms (${r.tree.tableCount} tables)`);
      const fp = (m) => (m.footprintMiB == null ? "" : `, footprint ${f(m.footprintMiB)} MiB`);
      console.log(`  idle RAM: rss ${f(r.idleMemory.totalMiB)} MiB${fp(r.idleMemory)} (${r.idleMemory.processes.map((p) => `${p.name} ${f(p.footprintMiB ?? p.rssMiB)}`).join(", ")}); first rows ${f(r.run.firstRowsMs)} ms; 1M rows in ${f(r.run.totalMs)} ms (${r.run.rows} rows, ${r.run.status})`);
      const w = s.whileStreaming;
      console.log(`  scroll ${s.seconds} s from the first rows: ${s.frames} frames, p50 ${f(s.p50)} p95 ${f(s.p95)} max ${f(s.max)} ms, over 32 ms ${s.over32}, work p95 ${f(s.workP95)} ms; rows ${s.rowsAtStart} -> ${s.rowsAtEnd} (${s.stateAtEnd}), refresh ${f(r.run.refreshMs)} ms`);
      console.log(`    of which while streaming: ${w.frames} frames, p50 ${f(w.p50)} p95 ${f(w.p95)} max ${f(w.max)} ms, over 32 ms ${w.over32}, work p95 ${f(w.workP95)} ms`);
      console.log(`  cancel at ${r.cancel.page.rowsAtClick} rows: cancel connection in the audit ${r.cancel.cancelConnectionAuditMs} ms after the click; "${r.cancel.page.status}"; RAM after 1M rss ${f(r.memoryAfter1M.totalMiB)} MiB${fp(r.memoryAfter1M)}; audit ${JSON.stringify(r.auditChain)}`);
    ' "$out/run-$i.json" || failed=1
    i=$((i + 1))
  done
  echo "reports in $out"
  return "$failed"
}

case "${1:-}" in
  up) up ;;
  perf) shift; perf "$@" ;;
  down)
    load_env
    compose down --volumes --remove-orphans
    rm -rf "$state"
    ;;
  status) status ;;
  env) env_exports ;;
  test) run_tests ;;
  *)
    sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
