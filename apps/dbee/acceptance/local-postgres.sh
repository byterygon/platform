#!/bin/sh
# A throwaway PostgreSQL from the local initdb/postgres binaries with the acceptance data
# (initdb/20-bench-rows.sql, initdb/30-wide-schema.sql), for CI's Linux run of the desktop
# budget, where the databases come from the distribution's packages, not Docker.
#
#   local-postgres.sh start DIR PORT    initdb in DIR, listen on 127.0.0.1:PORT, load the data
#   local-postgres.sh stop DIR
#
# Trust authentication on loopback only; plaintext (the driver connects with the plaintext policy).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
bin=${BYTERYGON_PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
[ -x "$bin/initdb" ] || bin=$(dirname "$(command -v initdb)")

case "${1:-}" in
  start)
    dir=$2 port=$3
    "$bin/initdb" -D "$dir" -U postgres --auth=trust --no-sync -E UTF8 --locale=C >/dev/null
    printf "listen_addresses = '127.0.0.1'\nport = %s\nunix_socket_directories = ''\nfsync = off\nsynchronous_commit = off\n" "$port" >> "$dir/postgresql.conf"
    printf 'host all postgres 127.0.0.1/32 trust\n' > "$dir/pg_hba.conf"
    "$bin/pg_ctl" -D "$dir" -l "$dir.log" -w start >/dev/null
    for f in "$here/initdb/20-bench-rows.sql" "$here/initdb/30-wide-schema.sql"; do
      "$bin/psql" -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -p "$port" -U postgres -d postgres -f "$f"
    done
    echo "PostgreSQL on 127.0.0.1:$port with bench_rows and schema wide"
    ;;
  stop)
    "$bin/pg_ctl" -D "$2" -m fast stop >/dev/null
    rm -rf "$2" "$2.log"
    ;;
  *)
    sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
