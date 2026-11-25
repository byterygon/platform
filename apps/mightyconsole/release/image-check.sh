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
# A first argument that is not a file is an image reference (the manifest the workflow pushed to
# its throwaway registry): it is pulled for this runner's architecture instead of loaded.
if [ ! -f "$archive" ]; then
  image=$archive
  archive=
fi
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
if [ -n "$archive" ]; then docker load -i "$archive"; else docker pull "$image"; fi
docker run --rm "$image" --version | tee /dev/stderr | grep -q "^mightyconsole-server $version " ||
  fail "--version does not say $version"
[ "$(docker image inspect -f '{{.Config.User}}' "$image")" = "65532:65532" ] || fail "the image does not run as 65532"
[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.source"}}' "$image")" = "https://github.com/byterygon/platform" ] || fail "no source label"
[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.licenses"}}' "$image")" = "AGPL-3.0-only" ] || fail "no licenses label"
[ "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$image")" = "$version" ] || fail "no version label"
[ -n "$(docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" ] || fail "no revision label"

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
# The default administrator (DOC-25 §3.2.7): its password in the volume, the log names the file.
docker logs "$offline" 2>&1 | grep -q "its password is in /data/admin-password" || fail "the log does not name /data/admin-password"
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
# Everyone signs in (DOC-25 §3.2.5, §3.2.6): the signed-out page with its pre-session token.
echo "$headers" | grep -qi "^set-cookie: __Host-mc_pre=" || fail "no pre-session cookie"
grep -q '<meta name="mightyconsole-auth" content="signed-out">' /tmp/mightyconsole-page.$$ || fail "not the signed-out page"
grep -q 'name="mightyconsole-pre"' /tmp/mightyconsole-page.$$ || fail "no pre-session token in the page"
asset=$(grep -o 'assets/[^"]*\.js' /tmp/mightyconsole-page.$$ | head -1)
rm -f /tmp/mightyconsole-page.$$
[ -n "$asset" ] || fail "the page names no script"
[ "$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:7443/$asset")" = 200 ] || fail "$asset is not served"
# The README's way in: read the password with docker cp (no shell in the image), and reset it
# with docker exec while the server runs (reset-admin asks it through DATA/reset-admin.request).
first=$(docker cp "$served:/data/admin-password" - | tar -xO)
[ "${#first}" -ge 24 ] || fail "docker cp of /data/admin-password gave no password"
docker logs "$served" 2>&1 | grep -qF "$first" && fail "the log holds the administrator's password"
second=$(docker exec "$served" /mightyconsole-server reset-admin --print | tail -n 1)
[ "${#second}" -eq 24 ] && [ "$second" != "$(printf %s "$first" | tr -d '\n')" ] || fail "reset-admin --print in the container gave no new password"
[ "$(docker cp "$served:/data/admin-password" - | tar -xO | tr -d '\n')" = "$second" ] || fail "reset-admin did not write /data/admin-password"
echo "image-check: $image ok"
