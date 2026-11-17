#!/bin/sh
# Roles and client authentication for the acceptance servers (runs once, at first start).
# - postgres: trust over TCP, as in the test clusters of dbee-core and the driver (the ports are
#   published on 127.0.0.1 only and the data lives in tmpfs);
# - dbee: SCRAM with the password ./acceptance.sh generated (.state/env), for the keychain flows.
set -eu
psql -v ON_ERROR_STOP=1 -v pw="$DBEE_ACC_PASSWORD" --username postgres --dbname postgres <<'SQL'
SET password_encryption = 'scram-sha-256';
CREATE ROLE dbee LOGIN PASSWORD :'pw';
GRANT pg_read_all_data TO dbee;
SQL
cat > "$PGDATA/pg_hba.conf" <<'HBA'
local all all trust
host all postgres all trust
host all all all scram-sha-256
HBA
