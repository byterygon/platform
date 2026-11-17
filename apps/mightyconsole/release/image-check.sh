#!/bin/sh
# Smoke check of a saved Mightyconsole image (TSK-87): it loads from the tarball alone, reports
# its version, starts with no network at all (making its certificate in /data as a non-root
# user), and, published on 127.0.0.1:7443 as the README says, serves the built-in UI with its
# session and CSP over TLS.
#
#   sh apps/mightyconsole/release/image-check.sh mightyconsole-<version>-image-linux-amd64.tar.gz <version>
set -eu
archive=$1
version=$2
image="byterygon/mightyconsole:$version"
offline="mightyconsole-check-offline-$$"
served="mightyconsole-check-served-$$"
volume="mightyconsole-check-data-$$"
cleanup() {
  docker rm -f "$offline" "$served" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
fail() { echo "image-check: $*" >&2; exit 1; }

docker image rm "$image" >/dev/null 2>&1 || true
docker load -i "$archive"
docker run --rm "$image" --version | tee /dev/stderr | grep -q "^mightyconsole-server $version " ||
  fail "--version does not say $version"
[ "$(docker image inspect -f '{{.Config.User}}' "$image")" = "65532:65532" ] || fail "the image does not run as 65532"

# No network at all: it still starts (nothing to fetch) and makes its certificate.
docker volume create "$volume" >/dev/null
docker run -d --name "$offline" --network none -v "$volume:/data" "$image" >/dev/null
for _ in $(seq 1 50); do
  docker logs "$offline" 2>&1 | grep -q "open https://localhost:7443/" && break
  sleep 0.2
done
docker logs "$offline" 2>&1
docker logs "$offline" 2>&1 | grep -q "UI built in" || fail "no built-in UI"
docker logs "$offline" 2>&1 | grep -q "made a self-signed certificate at /data/tls" || fail "no certificate in /data"
docker rm -f "$offline" >/dev/null

# Published on loopback, with the same volume: the certificate is reused, the page is served.
docker run -d --name "$served" -p 127.0.0.1:7443:7443 -v "$volume:/data" "$image" >/dev/null
for _ in $(seq 1 50); do
  curl -sk -o /dev/null https://localhost:7443/ && break
  sleep 0.2
done
docker logs "$served" 2>&1 | grep -q "made a self-signed certificate" && fail "the certificate was not reused"
headers=$(curl -sk -D - -o /tmp/mightyconsole-page.$$ https://localhost:7443/)
echo "$headers" | grep -qi "^content-security-policy: default-src 'self'" || fail "no CSP"
echo "$headers" | grep -qi "^set-cookie: __Host-ambidex_session=" || fail "no session cookie"
grep -q 'name="mightyconsole-csrf"' /tmp/mightyconsole-page.$$ || fail "no CSRF meta in the page"
asset=$(grep -o 'assets/[^"]*\.js' /tmp/mightyconsole-page.$$ | head -1)
rm -f /tmp/mightyconsole-page.$$
[ -n "$asset" ] || fail "the page names no script"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:7443/$asset")" = 200 ] || fail "$asset is not served"
echo "image-check: $image ok"
