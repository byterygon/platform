# Acceptance evidence

Research completion is separate from production adoption. The report records every unsupported profile/measurement criterion and its impact; no performance win is required to complete the spike.

| Stage / amendment | Evidence | Result / limit |
| --- | --- | --- |
| A / B1: JSON boundary and lossless-first comparison | Rust baseline; integers.test.mjs; typed.test.mjs; three-profile raw benchmarks | Full i64/u64 exact in JSON strings; v1 unsafe number loss reproduced |
| A / B7: both TS mappings | Rust MappingInput; generated.d.ts; client.types.ts; checked mapping tests | Bigint and checked-safe-plus-branded-exact profiles tested; contract IDs differ |
| B / B1: router boundary | rust/src/router.rs; ts/router.mjs; Rust/JS router tests | Bounded syntax, two-phase access/approval, typed Rust Result handler, redaction/logging |
| B / B2: input digest and approval binding | golden.json; semantic-fuzz.json; relay.test.mjs | Cross-codec digest equality; scale-significant inequality; version/principal/procedure/target/context/contract/policy scope tests |
| C / B3: semantic source of truth | semantic-derive; model.rs; fingerprint tool; generated artifacts | Generic supported serde subset; existing directional checker reused; recursion/enum order/exact bounds/defaults tested; unsupported attributes fail closed |
| C / B3: separate contract and policy identity | generated_ids.rs; generated.mjs; semantic hash/policy mutation tests | Code-generation-time Rust identities; separate TS mapping identities; v1 unchanged |
| A–C / B4: bounded Decimal | scalar.rs; semantic.mjs; D01/D02 and negative vectors | 38-digit profile, ±1000 scale, native/bignum minimality; extended PostgreSQL numeric/nonfinite values rejected |
| A–C / B5: temporal and Arrow alignment | scalar tests; arrow.mjs round-trip tests | UTC instant/local/date/time/duration separation; nanoseconds and scale retained; physical Arrow IPC/Decimal256/calendar intervals outside profile |
| C / B6: deterministic CBOR and strict decoding | frozen I01–I05/D01/D02/T01/T02/N01; ciborium cross-check; Rust/JS tests | Preferred-only and strict deterministic policies tested separately; tags/keys/UTF-8/trailing/minimality rejected as specified |
| D / B6: pre-materialization security and resource limits | json.rs; codec parsers; resource.test.mjs; resources.json | Payload/field/depth/node/map/array ±1 boundaries; accounted budget test; actual memory measurements separate from budget accounting |
| D / B6: structure-aware differential fuzzing | fuzz.json; semantic-fuzz.json; fuzz-extended-smoke.json | 2,011 + 4,006 + 12,000 cases per language; zero current disagreements/panics; no instrumented coverage or 10^7 campaign claim |
| D: findings retained and fixed | precision-regression.json; fuzz-harness-regression.json; regression tests | Rust float-roundtrip configuration and negative bignum endpoint fixed; raw-vs-typed harness mismatch corrected and documented |
| D: old/new protocol and M5 simulation | real unchanged-engine legacy.rs; pinned actual TS runtime test; relay tests | Additive JSON capability candidate, safe-only fallback, fixed codec, digest-stable transcode, opaque Arrow bytes, mutation outcome-unknown/no replay |
| D / B8: fair representative scenarios | Rust-defined workloads; all raw benchmark files; RESULTS.md | Four named primary scenarios + supplemental 256 KiB–near 1 MiB; same validation/hydration; five trials; codec/mock/real browser WS/Node WS/byte-pipe separated |
| D / B8: CPU/allocations/heap/GC/bundle/uncertainty | Rust allocator/getrusage; Node perf_hooks and memory samples; browser metadata; bundle.json; summary.json | Actual requested allocations and sampled memory; exploratory intervals; WebKit heap/GC unavailable, so heap adoption gate not established |
| D / B9: macOS/offline/dependencies | standalone lockfiles; environment.json; dependency/license/audit artifacts | Mac arm64 execution, cached offline install/tests, no unshare/systemwide changes; not hard isolation or actual WKWebView; ws advisory remediated |
| E: recommendation, migration and rollback | REPORT.md; RESULTS.md; analysis.json | Separate JSON/TS/CBOR decisions; CBOR adoption No-Go; human decisions identified |
| Isolation/workflow | branch tsk-21-ambidex-cbor-spike; PR #14; FILES.txt | One worktree/branch/PR; all changed files under experiment; no production/root manifest/generated API/CI changes; no merge |

The production adoption gates remain unestablished: the shared Chromium/WebKit ≥15% latency gain was not demonstrated, WebKit heap/GC is unavailable, and fixture/loopback evidence is not production authentication, relay or WKWebView validation. These are explicit negative/limited research findings, not an authorization to ship the prototype.
