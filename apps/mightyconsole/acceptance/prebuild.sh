#!/bin/sh
# Builds, without running anything, the cargo targets that the lab workflow's acceptance
# checklists and net-route's lab test build (TSK-148). The "Lab cache" workflow
# (.github/workflows/lab-cache.yml) runs it for everything on main and saves the rust-cache that
# the lab job restores, so a lab run compiles the workspace's own crates only, not their
# dependencies. The lab job runs it in the background while the lab comes up (TSK-149), for the
# checklists of that run, so those crates are built by the time the checklists start.
#
#   apps/mightyconsole/acceptance/prebuild.sh all
#   apps/mightyconsole/acceptance/prebuild.sh CHECKLIST... [routes]
#
# Every checklist (foundation, langgraph, messaging, temporal, security, nats, ...) needs the
# server and its tests; messaging and security add what only they build. `routes` is net-route's
# lab test alone (no server), `all` is everything.
#
# Each line is one package selection with its features, as the checklists call cargo
# (checklists/*.mts and acceptance.mts): cargo resolves features per selection, so a combined
# `-p a -p b` would build other variants of the dependencies than the lab uses. When a checklist
# calls cargo with another package or feature set, add it here; a line missing here only costs
# that build's time in the lab, it fails nothing.
set -eu
cd "$(dirname "$0")/../../.."

if [ $# -eq 0 ]; then
  echo "usage: prebuild.sh all | CHECKLIST... [routes]" >&2
  exit 2
fi
server=""
messaging=""
security=""
routes=""
for word in "$@"; do
  case "$word" in
    all) server=1 messaging=1 security=1 routes=1 ;;
    routes) routes=1 ;;
    messaging) server=1 messaging=1 ;;
    security) server=1 security=1 ;;
    *) server=1 ;;
  esac
done

run() {
  echo "== $*"
  "$@"
}

# acceptance.mts: the server the browser checks start, and every `cargo` check of the
# mightyconsole-server tests (with the lab-tests feature for the tools' lab tests). Both feature
# sets are kept side by side in target/ (cargo names each variant by its own hash).
if [ -n "$server" ]; then
  run cargo build -p mightyconsole-server --locked
  run cargo test -p mightyconsole-server --locked --tests --no-run
  run cargo test -p mightyconsole-server --locked --tests --features lab-tests --no-run
fi
# checklists/messaging.mts
if [ -n "$messaging" ]; then
  run cargo test -p message-codecs --locked --no-run
fi
# checklists/security.mts
if [ -n "$security" ]; then
  run cargo test -p ambidex-conformance --locked --no-default-features --features ws --no-run
  run cargo test -p ambidex --locked --no-run
  run cargo test -p audit-jsonl --locked --no-run
  run cargo test -p security-types --locked --no-run
fi
# mightyconsole-lab.yml: net-route through the lab's proxies (TSK-115)
if [ -n "$routes" ]; then
  run cargo test -p net-route --locked --features lab-tests --test lab --no-run
fi
