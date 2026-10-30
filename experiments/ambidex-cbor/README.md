# Ambidex codec and semantic-hash spike (TSK-21)

Isolated research only; no production registration, protocol/security changes or adoption.

- [REPORT.md](REPORT.md): findings, supported profile, limitations, migration/rollback and separate recommendations.
- [RESULTS.md](RESULTS.md): measured latency, allocation/CPU, size and adoption-gate evidence.
- [ACCEPTANCE.md](ACCEPTANCE.md): Stage A–E and B1–B9 evidence map.
- [FILES.txt](FILES.txt): every changed file.

Run `./verify.sh`, `node ts/check-generated.mjs`, then `./bench.sh` and `node ts/analyze.mjs`. The report explains one-time provisioning and cached-offline execution. Rust and pnpm have independent workspaces and lockfiles. Benchmark browser/loopback processes require local execution permissions.

Recommendations: Conditional Go for production lossless JSON follow-up; bigint preferred for full-range TS integers; No-Go for CBOR production adoption on this evidence. No merge is authorized.
