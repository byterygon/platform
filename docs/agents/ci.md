# CI

Moved from the repository's CLAUDE.md (TSK-126), unchanged. CLAUDE.md points here.

CI (`.github/workflows/ci.yml`) runs all of the above (the `rpc-gen --check` as the drift test in
`crates/ambidex-conformance/tests/codegen.rs`) plus a gitleaks scan of the full history. The Rust
job builds the affected crates' tests once and runs them once, offline, inside a network namespace
with only loopback (TSK-124; spec §12: the conformance suite must pass network-disconnected; `sudo`
clears the environment, so the cargo settings the step needs are passed in). Protocol behaviour that must hold
on every transport goes in `crates/ambidex-conformance/src/cases.rs`, not in one transport's tests.
The Rust toolchain is pinned in `rust-toolchain.toml`; pnpm is pinned via `packageManager`.

On pull requests CI runs only what the change affects (TSK-89): `node scripts/affected.mjs --pretty`
prints it for your working tree against `origin/main` (crates, packages, jobs, `cargo -p` and
`pnpm --filter` arguments); `node --test scripts/affected.test.mjs` tests it. A new cross-language
dependency (Rust reading or embedding a JS package's files, or the reverse) needs a line in
`scripts/affected-rules.mjs`. Pushes to main run everything; "CI result" sums up the run. The
Linux Rust jobs run in the CI image (`.github/ci-image/`, see its README).

Merging goes through GitHub's merge queue (TSK-150; the protect-main ruleset requires it instead of
branches being up to date). `gh pr merge <n>` adds a green pull request to the queue (the queue
squashes; before the required checks pass it turns on auto-merge instead, which enqueues it once
they do; never `--admin`, which bypasses the queue); the queue tests its change on top of main and
the pull requests ahead of it (`merge_group`: ci.yml runs everything there, as on a push to main;
the lab does not run, its result on the pull request stands; "Lab decision" passes), then merges
it. A pull request behind main is not rebased for that reason, only for a conflict. A failing queue
run takes the pull request out of the queue: fix it on the branch and add it again.

Before a push (TSK-128): `node scripts/pre-pr.mjs` runs on your machine the steps CI will run for
the change, with the same `cargo -p` and `pnpm --filter` arguments (`--dry-run` lists them,
`--keep-going` runs past a failure), and names what only CI runs: the network namespace, the
browser checks, the lab, the Windows and macOS jobs. `node --test scripts/pre-pr.test.mjs` tests
its plan; CI's Affected job runs that test.

The Mightyconsole lab on pull requests (TSK-129) runs only with a label, read by
`scripts/lab-labels.mjs`: `lab` (the scope `scripts/affected.mjs` gives as `lab_tools`),
`lab:<tool>` (several add up; `lab:all` for every tool) or `lab:none` (no run). Adding the label
starts it; later pushes run it again while the label stays, and a newer push cancels the run in
progress (job-level concurrency, so a label that is not a lab label never cancels one). The "Lab
decision" workflow (`lab-decision.yml`, seconds, separate from ci.yml so a label change does not
re-run CI) fails a pull request whose change needs the lab and that has no lab label. Pushes to
main, the weekly run and manual runs bring up every tool.

The lab's Rust cache (TSK-148) is saved by the "Lab cache" workflow (`lab-cache.yml`), not by the
lab job: on main (pushes that change Rust or Cargo files), daily and by hand it runs
`apps/mightyconsole/acceptance/prebuild.sh`, which builds the cargo targets of the acceptance
checklists and net-route's lab test without bringing the lab up; the lab job restores that key
and saves nothing. The lab job also runs `prebuild.sh` for its run's checklists in the background
while the lab comes up (TSK-149, under `nice`), and waits for it before the checklists start, so
their `cargo` calls find everything built. A checklist that calls cargo with another package or
feature set gets a line in `prebuild.sh`.
