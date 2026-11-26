#!/bin/sh
# Builds, without running anything, the cargo targets that the lab workflow's acceptance
# checklists and net-route's lab test build (TSK-148). The "Lab cache" workflow
# (.github/workflows/lab-cache.yml) runs it on main and saves the rust-cache that the lab job
# restores, so a lab run compiles the workspace's own crates only, not their dependencies.
#
#   apps/mightyconsole/acceptance/prebuild.sh
#
# Each line is one package selection with its features, as the checklists call cargo
# (checklists/*.mts and acceptance.mts): cargo resolves features per selection, so a combined
# `-p a -p b` would build other variants of the dependencies than the lab uses. When a checklist
# calls cargo with another package or feature set, add it here; a line missing here only costs
# that build's time in the lab, it fails nothing.
set -eu
cd "$(dirname "$0")/../../.."

run() {
  echo "== $*"
  "$@"
}

# acceptance.mts: the server the browser checks start, and every `cargo` check of the
# mightyconsole-server tests (with the lab-tests feature for the tools' lab tests).
run cargo build -p mightyconsole-server --locked
run cargo test -p mightyconsole-server --locked --tests --no-run
run cargo test -p mightyconsole-server --locked --tests --features lab-tests --no-run
# checklists/messaging.mts
run cargo test -p message-codecs --locked --no-run
# checklists/security.mts
run cargo test -p ambidex-conformance --locked --no-default-features --features ws --no-run
run cargo test -p ambidex --locked --no-run
run cargo test -p audit-jsonl --locked --no-run
run cargo test -p security-types --locked --no-run
# mightyconsole-lab.yml: net-route through the lab's proxies (TSK-115)
run cargo test -p net-route --locked --features lab-tests --test lab --no-run
