#!/bin/sh
# Pushes the two saved Mightyconsole images (TSK-88) to a registry as one multi-arch manifest.
#
#   sh publish-image.sh REPOSITORY VERSION REVISION AMD64.tar.gz ARM64.tar.gz
#
# REPOSITORY is ghcr.io/byterygon/mightyconsole for a publish (the workflow logs in first), or a
# throwaway registry (localhost:5000/byterygon/mightyconsole) for the check that every pull
# request and main run does. The images are the ones `release.mts image` built and
# image-check.sh checked: skopeo copies each saved tarball (any architecture, no emulation) to
# REPOSITORY:VERSION-amd64 / -arm64, and `docker buildx imagetools create` joins them under the
# tags below, so the pushed bytes are the checked bytes.
#
# Tags: the exact VERSION; `alpha` (floating) for 0.1.0-alpha.N and 0.1.0-alpha.N.R; `latest` only for a version with
# no pre-release part (0.1.0 on). It refuses to run when REPOSITORY:VERSION already exists: a
# version tag is never overwritten. DEST_TLS_VERIFY=false for the plain-HTTP local registry.
# Prints the manifest digest on its last line (and to $GITHUB_OUTPUT as `digest`).
set -eu
repo=$1
version=$2
revision=$3
amd64=$4
arm64=$5
verify=${DEST_TLS_VERIFY:-true}
source_url=https://github.com/byterygon/platform
fail() { echo "publish-image: $*" >&2; exit 1; }

case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) fail "not a version: $version" ;;
esac

tags="$version"
case "$version" in
  *-alpha.*) tags="$tags alpha" ;;
  *-*) ;;
  *) tags="$tags latest" ;;
esac

if docker buildx imagetools inspect "$repo:$version" >/dev/null 2>&1; then
  fail "$repo:$version already exists; a version tag is never overwritten (bump the version instead)"
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gunzip -c "$amd64" > "$work/amd64.tar"
skopeo copy --dest-tls-verify="$verify" "docker-archive:$work/amd64.tar" "docker://$repo:$version-amd64"
rm -f "$work/amd64.tar"
gunzip -c "$arm64" > "$work/arm64.tar"
skopeo copy --dest-tls-verify="$verify" "docker-archive:$work/arm64.tar" "docker://$repo:$version-arm64"
rm -f "$work/arm64.tar"

# The annotations on the index are what GitHub reads to link a multi-arch package to its repository.
set -- --annotation "index:org.opencontainers.image.source=$source_url" \
  --annotation "index:org.opencontainers.image.licenses=AGPL-3.0-only" \
  --annotation "index:org.opencontainers.image.title=Mightyconsole" \
  --annotation "index:org.opencontainers.image.version=$version" \
  --annotation "index:org.opencontainers.image.revision=$revision" \
  --annotation "index:org.opencontainers.image.description=Offline web console for NATS, Kafka, Kubernetes, Temporal, Docker over SSH and LangGraph. No login: publish it on 127.0.0.1 only."
for tag in $tags; do set -- "$@" -t "$repo:$tag"; done
docker buildx imagetools create "$@" "$repo:$version-amd64" "$repo:$version-arm64"

raw=$(docker buildx imagetools inspect --raw "$repo:$version")
echo "$raw" | grep -q '"architecture": *"amd64"' || fail "the manifest has no linux/amd64"
echo "$raw" | grep -q '"architecture": *"arm64"' || fail "the manifest has no linux/arm64"
digest=$(docker buildx imagetools inspect "$repo:$version" --format '{{.Manifest.Digest}}')
echo "publish-image: $repo ($tags) -> $digest"
if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "digest=$digest" >> "$GITHUB_OUTPUT"; fi
echo "$digest"
