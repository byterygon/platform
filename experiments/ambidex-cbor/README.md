# Ambidex codec spike (TSK-21)

Experimental research only. No production registration, protocol changes or adoption.
See [REPORT.md](REPORT.md) for separate recommendations, acceptance gaps and reproduction commands.

- `rust/`: independent bounded CBOR parser/encoder, integer baseline, fixture fingerprint tool and parser benchmark; standalone workspace and lockfile.
- `ts/`: raw validators, schema-directed scalar codecs, simulated authorization/handshake, differential tests, benchmark scripts and standalone pnpm project.
- `results/`: exact golden fixtures, fuzz evidence, Rust/Node/browser raw measurements, summaries and environment.

The experiment intentionally reports **No-Go for production CBOR adoption**. The full generic semantic derive and Rust typed pipeline are not delivered; read the acceptance-gap discussion before interpreting passing fixture tests.
