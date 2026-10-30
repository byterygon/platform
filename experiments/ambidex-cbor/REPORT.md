# TSK-21: lossless JSON, semantic identities and CBOR spike

The isolated PoC completes Stages A–E with reproducible correctness, security, compatibility and performance evidence. Recommend **Conditional Go for production lossless JSON v2**, **Go for bigint as the preferred full-range TS integer mapping**, and **No-Go for production CBOR adoption on this evidence**. These are research recommendations: production contracts, authorization changes, migration and merging still require separate human decisions.

## What was built and verified

All source, generated artifacts, manifests, lockfiles and results are under this directory. No production crate/package source, root manifest/lockfile, generated production API, schema hash v1, Hello/HelloAck, frame flags, security policy or CI was changed. The experiment links production Ambidex read-only to reuse its agreement checker and test legacy handshake behavior. The original base is `fd3fc42`; the inspected TS runtime is pinned at `174b74aeb88aac05916b612e38d074f14042caf4`.

`verify.sh` builds the standalone Cargo workspace, runs Rust tests/fmt/clippy with warnings denied, checks generated TS types, checks formatting, runs JS tests and runs seeded differential fuzz smoke. `node ts/check-generated.mjs` checks Rust metadata and all experimental generated clients/identifiers for drift. There are 15 Rust tests and 30 JS tests; these include a typed Rust router, real unchanged-engine handshake integration, the actual pinned TS runtime, frozen golden bytes, scalar/Arrow alignment and resource boundaries. The production CI remains unchanged and therefore does not discover the standalone spike tests; the committed logs document their local execution separately.

Golden I01–I05, D01, D02, T01, T02 and nested N01 are frozen in `fixtures/golden.json`, matched by independent Rust/JS encoders and cross-checked with pinned ciborium. D01 is `c4822319300c`. Rust and JS both validate/hydrate JSON v2 and CBOR and compare canonical logical values and digests. The structured syntax smoke has 2,011 cases per language; extended smoke adds 12,000; semantic differential testing adds 4,006. Current runs have no panics or unresolved disagreements. Coverage is not instrumented and these counts are not a production parser-safety proof.

## A–C: semantic model, codecs and router boundary

The experimental `Semantic` trait and derive read the same Rust/serde declarations that derive TS and JsonSchema. They export directional nominal graphs, record exact numeric bounds as decimal text, preserve untagged-union order, sort named fields/tagged variants and support recursive references, flattening, optional/default fields and declared scalar metadata. `model::checked` calls the existing Ambidex directional ts-rs/schemars checker before exporting the semantic extension. Unsupported serde attributes/custom default functions fail compilation instead of being omitted silently; this is a prototype for the supported declaration subset, not a complete serde replacement.

Rust computes contract and policy fingerprints in the code-generation step. The frozen contract canonical grammar has UTF-8-sorted object keys, ordered arrays and exact string-encoded numeric metadata, with no floating JSON metadata. Derive ignores doc comments and filesystem paths. The contract includes API/procedure/kind, input/output/error graphs and TS mapping profile. Bigint and checked-plus-exact profiles publish different contract IDs. Policy includes permission, risk, agent exposure, deprecation and timeout metadata. Tests cover integer-domain, Decimal/time precision, requiredness, enum-order and policy drift. Generated Rust constants and TS identifiers are compared/consumed at runtime; TS does not reimplement Rust schema hashing. Hash v1 and its policy drift checks remain untouched.

The separate input digest is SHA-256 over `ambidex.input-digest.v2` + NUL + canonical logical-value encoding. The logical encoding uses the restricted deterministic CBOR scalar representation, regardless of the selected wire codec. Equal hydrated JSON/CBOR values have equal digests; scale-significant Decimal twins differ. The contract-fingerprint encoding and input-digest encoding are distinct algorithms with separate domains.

Both Rust and JS simulated routers run bounded syntax validation → trusted authenticated session context → access gate → semantic hydration → canonical input digest → digest-bound authorization → redacted logging → typed handler. Rust dispatches `EditInput` to a typed Result-returning handler with a checked domain-error contract. Access denial precedes sensitive semantic validation. The opaque approval-store simulator compares digest version, contract/policy, procedure, principal, target and context; changes to any bound scope fail, and v1 approvals are not reused. Logging/redaction never changes the logical input digest. No production approval storage, policy or Authorizer interface is replaced.

The two-phase authorization gate was explicitly selected for this experiment. A production proposal must define how that gate fits the existing Authorizer, whose request currently requires an input digest, without issuing approvals from an unvalidated placeholder digest. Trusted session inputs in the simulator do not prove tenant/delegation/revocation correctness; the production principal chain, target/risk rechecks and authenticated transport still have to be preserved in any later integration.

The direct schema-guided serde path and codec-neutral logical-tree path are both implemented and benchmarked in Rust. The direct path avoids intermediate trees but still needs canonical digest and audit integration in production. Its parsing/hydration microbenchmark is not an end-to-end approval or RPC speed claim. Detailed measurements are in [RESULTS.md](RESULTS.md).

### Exact scalar profile

| Logical type | Lossless JSON | CBOR | Semantics / bounds |
| --- | --- | --- | --- |
| i64 / u64 | Canonical decimal string | Native integer | Schema enforces signedness/full range; no unsafe Number intermediate |
| Decimal | Exact decimal/exponent text | Tag 4, native exponent, minimal native/bignum coefficient | Precision ≤38, absolute scale ≤1,000, stricter field metadata supported |
| Instant | Exact UTC text | Tag 0 + text | Offset normalized; 0–9 fractional digits and value precision retained |
| Local datetime | Text without zone | Schema-directed text | Never invent an offset |
| Date | Gregorian date text | Tag 1004 + text | Years 0000–9999 |
| Time / duration | Exact text | Schema-directed text | Time-of-day or signed decimal seconds; no calendar intervals |
| Bytes | Canonical padded base64 | Byte string | Explicit logical scalar; dynamic JSON does not infer it |

Decimal scale is significant for the core fixture; a declared scale-insignificant profile canonicalizes trailing zeros. Negative scale is supported without unbounded zero expansion. NaN, infinities, PostgreSQL special values and larger PostgreSQL numeric/Decimal256 profiles are typed errors, not rounded values. Leap seconds, invalid Gregorian dates, unknown offset -00:00, excess precision and unsupported years fail explicitly. Original timezone/offset retention needs a separate declared type.

TS decoding produces native bigint and exact Decimal/temporal wrappers. The second generated profile uses checked numbers only on explicitly bounded safe fields, plus validated ExactI64/ExactU64 factories for full-range fields. Compile-time negative tests prevent number substitution and unvalidated bigint branding. Both mappings change generated client/UI contracts and need a migration decision.

Dynamic JSON has an explicit conservative domain: null, booleans, strings, arrays/objects and safe integral binary64 numeric values. Scalar tags/bytes and nonintegral values are rejected, not implicitly hydrated. Numeric spelling is not preserved (`1.0` and `1e0` normalize to 1). Exact Decimal intent must use a declared Decimal field. A regression exposed Rust's default float parse disagreeing with JS for `9007199254740991.0`; the standalone experiment now enables `serde_json/float_roundtrip`. Full-range integers still travel as strings in JSON v2. The regression and resolution are recorded in `precision-regression.json`.

`arrow.mjs` tests scalar alignment and edited-value round trips: Date32, Time64(ns), Timestamp(ns,UTC), Timestamp(ns,no timezone) and Decimal128 with declared scale. Negative epochs, nanoseconds and trailing zeros are preserved. These are scalar alignment adapters, not an Arrow IPC encoder or stream-throughput benchmark. Decimal256, calendar intervals and source-zone retention remain outside the declared supported profile.

## D: security, compatibility and dependency evidence

Both raw parsers reject duplicate keys before container materialization, invalid UTF-8/Unicode, trailing data and out-of-profile values. CBOR also rejects non-string map keys, indefinite containers, undefined, unapproved tag placement and nonminimal integers/bignums. Produced map order is RFC 8949 core deterministic bytewise encoded-key order. Preferred-serialization decoding may accept alternate map order; strict deterministic decoding rejects it. Neither mode is mislabeled as the other. Both profiles use safe object construction; prototype keys are tested.

Resource tests exercise minus-one/exact/plus-one boundaries for 1 MiB payloads, 256 KiB fields, depth 64, 100k nodes, 4,096 map entries and 65,536 array elements. Accounted allocation checks run before the relevant materialization, and a reduced configurable budget demonstrates the rejection boundary. The default accounted budget is 8 MiB. It is **not a hard allocator/JS-engine heap cap**: actual Rust requested allocation calls/live bytes and process RSS, plus Node sampled heap/RSS/GC, are measured separately. Browser memory limits below prevent certifying the production heap gate.

The extended corpus covers structured containers/scalars, byte mutations and JSON mutations. An initial differential-harness mismatch compared raw JSON syntax acceptance with typed dynamic-domain rejection; the harness was corrected and a regression test retained. No unresolved parser disagreement remains in the recorded smoke campaign. Large ≥10^7/target campaigns and instrumented coverage remain production-readiness work, as allowed by the amended RFC.

Pinned ciborium 0.2.2 preserves duplicate map entries in its Value representation; pinned cbor-x 1.6.4 with records disabled collapses duplicates in the comparator test. Neither default behavior substitutes for the profile validator. Library behavior was tested rather than presumed. Maintaining two wire formats entails two language implementations, schema-directed hydration, validators, golden vectors, fuzz corpora, negotiation, relay adapters and audit/approval migration—not just adding a serializer package.

The unchanged production Rust engine accepts an unknown Hello capability extension in a real in-memory connection. The actual pinned TS Connection accepts an extended HelloAck. The new simulator uses an additive, versioned JSON capability candidate, fixes codec per connection, defaults absent capability to json-v1, rejects malformed/unknown-only capabilities and refuses required-lossless downgrade. The safe-only old-peer adapter rejects unsafe values before send. Contract mismatches do not trigger fallback. Error/Goaway on call 0 stay JSON; existing flags and production messages are unchanged.

M5-oriented peers independently negotiate codecs, transcode JSON-lossless/CBOR with stable digests, enforce trusted principal/target/context equality, and forward opaque Arrow chunk bytes unchanged. A mutation executes once; a corrupt result produces a local nonretryable “outcome unknown” error without replay. These are isolated simulations plus read-only legacy integration, not an implemented production M5 relay. TLS, endpoint identity, session revocation, tenant/delegation chains and cross-server trust are assumptions to preserve, not properties established by loopback benchmarks.

Dependency/license snapshots are committed. All added manifests declare MIT OR Apache-2.0. Alternatives in dependency license expressions are not treated as mandatory LGPL use. The JS advisory check found two issues in the initial benchmark-only ws version; it was upgraded to 8.21.0 and the saved post-remediation audit reports zero advisories. Rust package licenses/versions and pinned parser behavior were assessed; cargo-audit/cargo-deny were not installed locally, so no complete Rust advisory scan is claimed. Production CI license/secret checks remain separate.

## Performance and environment

[RESULTS.md](RESULTS.md) and `results/summary.json` summarize the raw data. `bench.sh` runs the campaigns sequentially: Rust, Node, Chromium/WebKit, separate Node WebSocket/byte-pipe mocks, bundle analysis and summaries. Four primary workloads originate in Rust: ExecuteSummary (mirrors db-driver QuerySummary), 500-table metadata (TableInfo), a 20-scalar mixed mutation (~1.2 KiB), and a Decimal/DateTime grid-edit batch. Supplemental controls cover ~256 KiB, ~512 KiB and near 1 MiB. DBee is a placeholder, so these are representative declared scenarios, not captured production DBee traffic.

All three profiles are recorded. JSON-v1 is a historical contextual baseline without the extra v2 validation/hydration; unsafe-value comparisons are incomparable. Lossless JSON and CBOR pay equivalent semantic validation/hydration costs. Node and browsers record codec-only and in-process mock RPC separately; browsers also measure actual individual WebSocket round trips to a Node echo server. Separate Node runs measure WebSocket and Tauri-style byte-pipe mocks. No TLS or GUI Tauri is included. Arrow throughput is excluded.

Five trials record raw samples, p50/p95, trial ranges and seeded exploratory bootstrap intervals across trial p95 values. Browser codec/mock samples average batches to reduce timer quantization; only the WebSocket rows represent individual round trips. No p99 claims are made. Supplemental payloads have fewer samples and are excluded from adoption gates. Rust exposes requested-byte allocator instrumentation and getrusage CPU/RSS; Node exposes CPU, sampled heap/RSS and GC events. Chromium heap is nonstandard/sampled and WebKit exposes no heap/GC API here. Those are measurement limitations, not invented zero values.

The measured campaign did not establish ≥15% p95 improvement on two primary workflows **in both** Chromium and WebKit. WebKit quantization makes small differences unresolved. Experimental gzip growth is small, and Rust CPU/allocation benefits are independently interesting, but neither bytes saved nor server-only wins establish the proposed adoption gates. The ≤20% peak-heap gate is not established. Hence CBOR adoption is No-Go on this evidence, not a proof that an optimized CBOR implementation can never help.

`environment.json` records macOS 26.6.2, Apple M3 arm64, Rust 1.99.1 and Node 24.18.0; package/tool/browser versions are pinned or recorded in the raw results. The host was not a dedicated isolated performance machine. Playwright WebKit is a JavaScript-engine proxy, **never actual Tauri WKWebView performance**. Cargo tests and pnpm installation ran offline after caches were populated; initial downloads needed network. Cached offline execution and local loopback are **not hard network isolation**. Linux unshare and systemwide firewall changes were not used.

## E: recommendations, integration and rollback

- **Lossless JSON v2 — Conditional Go for a production follow-up.** Supported-profile exactness and cross-language behavior are demonstrated. Adoption still requires complete application type coverage, explicit scalar/descriptor contracts, a reviewed router/approval integration and a versioned client migration. It can be adopted independently of CBOR.
- **TS integer mapping — Go for bigint as the preferred full-range profile.** Checked-number plus explicit exact types also works, but requires field bounds and adds mixed UI/arithmetic semantics. Human approval is required for the generated-client breaking change. Neither profile may masquerade behind the existing v1 contract identity.
- **CBOR v1 — No-Go for production adoption on this evidence.** Cross-browser latency and heap gates are not established, despite size and Rust CPU/allocation benefits. An optimized implementation or Rust-only relay use case could justify a later separate investigation; this spike does not authorize it.

The production integration proposal is a codec-neutral boundary before typed dispatch; semantic type references attached to ProcedureTypes and the router macro; the existing directional agreement checks extended with logical metadata; generated runtime descriptors and profile-specific TS clients; and distinct contract/policy identities. router.rs, procedure.rs, macro descriptors, codegen and audit/log_input integration would need coordinated changes. MCP remains JSON with explicit schema-directed exact values. No changes to those production files are part of this PR.

Migration would first approve scalar domains/TS mapping and the two-phase authorization design, introduce opt-in versioned lossless JSON, and publish v1/v2 identities without silently replacing either. Policy-fingerprint participation in Hello remains an ADR question. Only after separate adoption approval should any CBOR capability be considered. Approval migration must preserve version, principal/context, target, procedure and policy binding; old approvals cannot be reused implicitly.

Rollback must select an explicitly supported profile on a new connection before a mutation is sent. Legacy fallback requires safe-value checks and a compatible contract. It must not round unsafe values, retry an outcome-unknown mutation or replay a mutation after reconnect. Production security policy modifications, protocol migration, release and PR merge remain human decisions. Completing this research with a No-Go result does not authorize a production implementation.

## Reproduction and limitations

From this directory, after first-time dependency/browser provisioning:

```sh
(cd ts && pnpm install --offline --frozen-lockfile --ignore-scripts)
./verify.sh
node ts/check-generated.mjs
./bench.sh
node ts/analyze.mjs
```

Online provisioning once: `(cd ts && pnpm install --ignore-scripts && pnpm exec playwright install chromium webkit)` plus `cargo fetch --manifest-path rust/Cargo.toml --locked`. Browser/socket benchmarks need permission to launch child processes and bind temporary loopback listeners. There is no runtime CDN, telemetry or schema registry dependency. Optional native package scripts were disabled; cbor-x uses its JS fallback in this experiment.

The remaining limits are explicit profile or measurement boundaries: unsupported serde constructs fail closed; dynamic nonintegral numbers, extended PostgreSQL numeric/temporal variants and physical Arrow IPC are outside the selected scalar profile; WebKit heap/GC and actual WKWebView are unmeasured; full production transport/tenant/delegation behavior and extended fuzz campaigns are not claimed. Each prevents extrapolating these fixture results into a production guarantee; none is silently recorded as a passing adoption criterion.

Sources: [DOC-13 amended RFC](https://app.notion.com/p/4087c4201bbd813b9998d8c6d156c809), [DOC-14 review](https://app.notion.com/p/4087c4201bbd81d3b824d78682045d98), [TSK-21](https://app.notion.com/p/4087c4201bbd81798256e1d26483c683), [Ambidex spec OQ22/23](https://app.notion.com/p/4037c4201bbd81d99633f491d1dc367e), recorded repository/runtime revisions and the committed tool outputs.
