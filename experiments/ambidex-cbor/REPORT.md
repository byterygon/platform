# TSK-21 experimental findings

Lossless schema-directed JSON preserves integer and Decimal values that the existing TypeScript number boundary cannot preserve. This bounded prototype does **not** establish production readiness: recommend **Conditional Go for further lossless-JSON work**, **Conditional Go for bigint mapping**, and **No-Go for CBOR adoption**. CBOR saves bytes but regresses measured serialization latency; incomplete architecture and security evidence independently prevent adoption. These are research recommendations, not authorization to modify production.

## Evidence and reproducibility

All implementation and results are inside this experiment. The base is `fd3fc42`; the inspected TSK-8 runtime reference is `174b74aeb88aac05916b612e38d074f14042caf4`. No runtime branch was merged into this worktree. Rust serde_json preserves u64-max; the JavaScript baseline test demonstrates 9007199254740993 rounding to 9007199254740992. `results/environment.json` records actual macOS, Apple M3 arm64, Rust and Node versions. Standalone lockfiles pin dependencies. First-time downloads required network; subsequent Cargo tests and pnpm installation ran offline from populated caches. This is **not hard network isolation**. No Linux unshare, firewall changes, or GUI Tauri are required.

Run from `experiments/ambidex-cbor`:

```sh
cargo build --manifest-path rust/Cargo.toml --offline --locked
cargo test --manifest-path rust/Cargo.toml --offline --locked
cargo fmt --manifest-path rust/Cargo.toml --check
cargo clippy --manifest-path rust/Cargo.toml --offline --locked --all-targets -- -D warnings
cd ts
pnpm install --offline --frozen-lockfile --ignore-scripts
pnpm test
pnpm bench
pnpm bench:browser
node summarize.mjs
node bundle.mjs
```

Browser setup, done online once: `pnpm exec playwright install chromium webkit`. Browser execution needs permission to launch processes and bind a temporary loopback HTTP server. Raw timings, golden vectors, fingerprint model, fuzz count and bundle measurements are committed in `results/`. Rust parser timings: `cargo run --release --manifest-path rust/Cargo.toml --offline --locked --bin bench`. Fingerprints: `cargo run --manifest-path rust/Cargo.toml --offline --locked --bin fingerprint`.

## Stage A: scalar semantics and mappings

Exact integer wire JSON is canonical decimal text; CBOR uses native integers with schema-directed signedness. Both TS alternatives reject unsafe numbers: bigint supports the full range, while checked-number rejects outside ±9007199254740991. Branded exact types are declaration sketches, not a generated production client. Bigint is the preferred research mapping for full-range fields: mixed checked/exact fields add schema and UI complexity. Either choice is breaking; arithmetic, JSON.stringify, UI formatting and generated API contracts need migration. Neither may retain an unchanged v1 identity while changing client semantics.

Decimal is coefficient × 10^(-scale), at most 38 significant digits and absolute scale 1,000. Scale is significant in this fixture; 1.23 and 1.2300 have different digests. Negative scale uses exponent text without expanding unbounded zeros. CBOR tag 4 uses a native exponent and native mantissa across [-2^64, 2^64−1]; only larger coefficients use minimal tags 2/3. PostgreSQL larger numeric values, NaN and infinity are rejected rather than rounded. Negative zero normalizes to zero with scale retained.

Instants normalize offsets to UTC and retain 0–9 fractional digits; local datetime never receives an invented offset. Original zone/offset retention is unsupported. Years outside 0000–9999, invalid Gregorian dates, leap seconds, unknown offset -00:00 and excess fractional digits are rejected. Time and duration have conservative text profiles; duration supports signed decimal seconds only, not calendar intervals. Missing required fields, undefined, unknown fields and null for nonnullable fields fail. Dynamic values accept only safe integral numbers, no scalar tags; this intentionally restricted domain does not cover arbitrary JSON floats.

| Scalar | Arrow alignment | Limitation |
| --- | --- | --- |
| date | Date32 | Arithmetic conversion not implemented |
| time | Time64(ns) | Text profile; no Arrow edit adapter |
| instant | Timestamp(ns, UTC) | Original offset discarded by explicit profile |
| local datetime | Timestamp(ns, no timezone) | No timezone invented |
| Decimal | Decimal128(precision, scale) | 38 digits; Decimal256/large PostgreSQL numeric unsupported |
| duration | Duration(ns), where representable | Range conversion and calendar intervals unsupported |

## Stage B: simulated router and approval binding

The JavaScript simulator runs bounded syntax validation → authenticated session context → access gate → schema hydration → logical input digest → digest-bound authorization → redacted log → typed JavaScript handler. Access denial precedes sensitive semantic errors. The selected two-phase gate is a **proposed experimental interface**, not the production Authorizer. The session principal is supplied by the harness, never parsed from request input. No real authentication or transport trust is established by this simulator.

Input digest uses SHA-256 with `ambidex.input-digest.v2` plus NUL and deterministic canonical logical CBOR, independent of transport bytes. Rust independently parses/re-encodes the logical CBOR and matches all fixture digests. Binding includes version, procedure, target, principal and session context. Production approval storage, token validation, cross-version token rejection and a Rust typed router are not implemented; no production approval can be consumed by this code. Redaction and log_input remain simulated and do not constitute audit integration.

A production follow-up would need: replace the router's serde_json::Value-only boundary; attach semantic descriptors to ProcedureTypes and macro registrations; maintain directional ts-rs/schemars agreement; hydrate before canonical digest-bound approval checks without leaking validation through denied access; adapt redaction to logical scalars; and explicitly keep MCP JSON with schema-directed exact-value conversion. Direct deserialization versus logical-tree performance has not been compared. This prototype uses the logical-tree route only.

## Stage C: deterministic CBOR and identifiers

I01–I05, D01, D02, T01, T02 and nested N01 include exact bytes and logical digests in `golden.json`; D01 is `c4822319300c`. Rust and JS independently produce identical bytes after parsing. Encoders order map keys by bytewise lexicographic order of deterministic encoded keys (RFC 8949 core deterministic, not length-first ordering). Preferred-only decoding permits varied map order; strict decoding rejects it. Both reject indefinite containers, duplicate/non-string keys, nonminimal integers/bignums, invalid UTF-8, trailing bytes, undefined and unapproved tags. This is an intentionally restricted no-float CBOR profile, not a general-purpose CBOR implementation.

The Rust fingerprint tool derives a fixture schema through serde/schemars and overlays explicit logical metadata. It emits separate domain-separated contract and policy identities, with exact bounds as decimal strings. Its frozen research canonical grammar is compact JSON with UTF-8-key ordering, documentation keys removed and numeric schema values normalized to strings. It is distinct from the input-digest algorithm. TS consumes identifiers; it does not duplicate Rust schema canonicalization.

**This is not the requested generic semantic derive.** It does not extend the existing ts-rs/schemars checker, support nominal recursive graphs, preserve untagged union precedence in a generic model, or generate the runtime descriptor. The descriptor and metadata are fixture-specific. This is a material B3 acceptance gap and prevents production Go. Schemars 0.8.22 was cached and used experimentally; production uses 1.2.3. No equivalence between these schema versions is claimed. Existing v1 policy drift checks remain untouched.

## Stage D: security and compatibility

The smoke corpus has 2,011 deterministic cases per Rust/JS decoder (seed 21): structured scalar/container generation, byte mutations and malformed regressions. Zero acceptance/canonical-value disagreements were found. Coverage is not instrumented; this is not an exhaustive campaign or proof of parser safety. Rust/JS raw CBOR paths enforce 1 MiB input, depth 64, 100k nodes, 4,096 map keys, 65,536 array elements, 256 KiB fields and an 8 MiB **accounted** budget. Accounting is conservative instrumentation, not a measured allocator cap; real object/allocator overhead and peak heap remain unverified. Boundary tests cover declared oversized lengths before allocation and depth rejection. Full threshold ±1 matrices and CPU exhaustion campaigns remain unsupported.

JSON gets duplicate-key/depth/length prevalidation before JSON.parse, null-prototype construction and unsafe-number rejection. Rust has no equivalent lossless-JSON raw validator or typed temporal/Decimal hydration. Struct flattening, tagged/untagged enum semantics and recursive duplicate-key tests are not implemented. The Rust CBOR parser treats allowed temporal tag text syntactically; semantic temporal validation is currently JS-only. Therefore cross-language **syntax and canonical bytes** are demonstrated, not complete Rust↔TS typed semantic equivalence. This distinction independently blocks adoption.

Pinned cbor-x 1.6.4 with records disabled produces u64-max correctly but silently collapses duplicate keys in the comparator test. It cannot replace the raw validator. Ciborium was not evaluated: no claims about its defaults, speed or security are supported. Custom parser maintenance, plus two language implementations and a shared adversarial corpus, is a substantial ongoing cost. No recommendation to ship these research parsers is made.

The handshake simulator selects a codec once, keeps call-0 errors on JSON, defaults absent capabilities to json-v1, and refuses lossless-required downgrade. Mutation decode failure is local, nonretryable and reports outcome unknown. It never retries or replays. Full production Hello unknown-field integration, authenticated M5 relay/transcoding, Arrow byte-preservation, connection lifecycle and real old/new peers remain untested. In production, authenticated TLS/session identity, relay identity and principal delegation must survive any transcoding; transport integrity alone is insufficient. Existing flags and Hello/HelloAck are unchanged.

## Performance, dependencies and recommendation

Node, Chromium and Playwright WebKit run the same four named scenario shapes with validation and hydration for both codecs. These are **synthetic representative fixtures**, not production DBee captures. Five independent trials use fixed codec order; no randomized ordering or host-load control. Node samples are individual in-process encode/decode operations. Browser samples average ten operations to mitigate timer quantization; their percentiles are not individual RPC latency. Headless WebKit is a JavaScript-engine proxy, **not actual Tauri WKWebView**. Rust timings measure CBOR syntax parse/re-encode only and cannot be compared directly to typed JS or establish a server CPU advantage.

Final Node p95 (milliseconds): ExecuteSummary JSON 0.007167 vs CBOR 0.010125; metadata-500 0.939625 vs 1.537166; mutation-20 0.039792 vs 0.027875; edited-grid 0.674958 vs 0.970875. The mutation fixture improves in this run, while the other three regress. Fixed-order runs and host noise limit interpretation. CBOR payloads are respectively 43/12759/91/9378 bytes versus JSON 58/18278/201/11291. Raw browser results and regenerated summaries are authoritative for browser timings. Bytes saved do not overcome latency regressions or the architecture gaps.

JSON-v1 has an exactness baseline test but no fair three-profile performance campaign; unsafe values are incomparable. No WebSocket/Tauri RPC latency, GC attribution, per-workload peak heap/RSS, allocation counts or confidence intervals were measured. Trial ranges are explicitly not confidence intervals. The gzip measurement is ~3.5 KiB for the research codec module; its small apparent dual-profile delta is misleading because both typed entries retain codec switching. It does not measure incremental production bundle cost. Therefore the proposed ≥15% p95 improvement, ≤10% regression, ≤20% heap regression and ≤30 KiB incremental bundle gates are **not established**; performance adoption is No-Go even aside from security gaps.

Rust dependencies are pinned serde/serde_json, sha2 and schemars; JS runtime prototype has no package dependency except Node crypto in the simulator. cbor-x is a comparator. Playwright/esbuild are development tools. Optional native scripts were disabled for offline installation. SPDX/license metadata and resolved dependencies are captured by lockfiles; no full advisory audit or transitive legal review was performed. No CDN, telemetry, registry or online schema is contacted by codec execution; initial dependency/browser provisioning is online.

### Decisions

- **Lossless JSON: Conditional Go for follow-up implementation**, not production adoption. Exactness is demonstrated at the JS boundary; generic descriptor generation, Rust hydration and approval integration must precede adoption.
- **TS integers: Conditional Go for bigint in full-range fields.** Checked-number plus exact types remains viable but is more complex and must reject overflow. Human approval is needed for generated-client breaking changes and UI migration.
- **CBOR: No-Go for adoption on this evidence.** The handwritten implementation saves bytes but is slower in Node, with insufficient architecture/security/transport evidence. This does not prove optimized CBOR libraries can never help.

Future migration must separately approve scalar types and the two-phase authorization interface; introduce versioned JSON lossless semantics and dual identifiers; preserve v1 peers behind explicit safe-value checks; and only then reconsider negotiated CBOR. Policy-fingerprint placement in Hello remains a human ADR decision. Rollback must reconnect using an explicitly supported profile before a mutation is sent; it cannot silently coerce unsafe values, reuse cross-version approvals or replay outcome-unknown mutations. No production migration or merge is authorized by this report.

## Sources

- [DOC-13 amended RFC](https://app.notion.com/p/4087c4201bbd813b9998d8c6d156c809)
- [DOC-14 independent review](https://app.notion.com/p/4087c4201bbd81d3b824d78682045d98)
- [TSK-21](https://app.notion.com/p/4087c4201bbd81798256e1d26483c683)
- [Ambidex spec, OQ22/23](https://app.notion.com/p/4037c4201bbd81d99633f491d1dc367e)
- Repository router, procedure, codegen and conformance harness at the recorded base; TS runtime at the recorded branch commit.
