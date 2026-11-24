# audit-jsonl

The durable audit sink shared by DBee and Mightyconsole (Ambidex spec §8, DBee spec Decision 21,
Mightyconsole spec DOC-25 §3.5, TSK-137). Licence: MIT OR Apache-2.0.

It moved here from `apps/dbee/core/src/audit.rs` (our own code, AGPL app to a permissive crate;
approved by Uy Son on 2026-11-24, DOC-25 Open question 10) so that Mightyconsole and later
permissive users write the same log. DBee re-exports it unchanged.

## What is in it

| Item | What |
| --- | --- |
| `JsonlAuditSink` | Appends hash-chained `AuditRecord`s (the `security-types` v1 encoding) as JSON Lines, one `fsync` per entry; `open` verifies every existing record and resumes the chain; a failed write makes every later write fail. |
| `UnavailableAuditSink` | Refuses every entry: the sink a caller runs with when the log could not be opened, so calls that must be recorded do not run (fail closed). |
| `read_records`, `verify`, `VerifyReport` | Read a log, check its chain and list unfinished admissions. |
| `AuditLogError` | I/O, a line that is not a record, or the place the chain breaks. |

The record format and hash domain belong to `security-types` and do not change here: a log
written by DBee before this crate existed verifies unchanged.
