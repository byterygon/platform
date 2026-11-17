#!/bin/sh
# A throwaway CA and a server certificate for db.test, generated at first start inside the
# container. The private keys stay in the data directory (tmpfs); only the two certificates and
# the server certificate's SHA-256 fingerprint are copied out for the pinned policies.
set -eu
cd "$PGDATA"
umask 077
cat > ca.cnf <<'CNF'
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3
[dn]
CN = DBee acceptance CA
[v3]
basicConstraints = critical, CA:true
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
CNF
cat > server.cnf <<'CNF'
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = DNS:db.test
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 \
  -config ca.cnf -keyout ca.key -out ca.crt 2>/dev/null
openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
  -subj "/CN=db.test" -keyout server.key -out server.csr 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -set_serial 0x"$(openssl rand -hex 8)" \
  -days 7 -extfile server.cnf -out server.crt 2>/dev/null
rm -f ca.key server.csr ca.cnf server.cnf
chmod 600 server.key
cat >> postgresql.conf <<'CONF'
ssl = on
ssl_cert_file = 'server.crt'
ssl_key_file = 'server.key'
CONF
cp ca.crt /acceptance-out/ca.pem
cp server.crt /acceptance-out/server.pem
fp=$(openssl x509 -in server.crt -outform der | sha256sum | cut -d' ' -f1)
printf 'sha256:%s\n' "$fp" > /acceptance-out/fingerprint
