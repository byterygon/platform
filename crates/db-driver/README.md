# db-driver v0.1

Runtime-independent native Rust facade and equivalent Component Model contract
in `wit/db-driver.wit`. The Rust traits use boxed Send futures and erased owned
resources so a registry can store `Box<dyn Driver>` without a Rust dynamic ABI.
WIT calls are synchronous at the ABI boundary; runtime adapters must suspend or
offload blocking calls. This crate supplies no Wasmtime runtime or DB driver.

The broker is pre-bound to the host's authorization context. Logical connections
are guest-owned; transports are host-owned, opaque and non-transferable across
instances/grants. The host must check ownership, quotas and current grants on
every call; revocation closes data, stream and cancel handles. No principal or
digest is serialized by this contract, so it does not duplicate security-types.
Networking, TLS and credentials follow Plugin Host §2–3 exactly; no ambient WASI
imports or grant implementation is added here.

Stream implementations yield whole Arrow IPC messages (including framing,
metadata, body and padding), with the schema first, even for an empty result.
Concatenating chunks yields one Arrow IPC stream. A batch hint is advisory,
backpressure comes from polling only with downstream credit. Dictionary messages
are allowed; messages must never be split across chunks. Successful streams emit
exactly one Finished summary then EOF (`None`); failed streams emit an error then
EOF, without a success summary. `truncated` denotes results cut short by max_rows,
not ordinary EOF. Drivers must respect limits without collecting all rows.
Dropping a stream must schedule backend cancellation/drain and release resources;
Rust Drop cannot await. WIT resource destruction has the same requirement.

## Provisional semantics needing human confirmation

Plugin Host Open question 12 records these proposals, not an approved decision:

- Caller allocates an opaque operation ID before execute, unique for the entire
  logical connection lifetime. Never reuse IDs, so delayed cancel cannot hit a
  later query. Execute registers the ID before starting backend work.
- Cancel is idempotent; unknown/completed IDs on the same connection are no-ops.
  A cancellation request acknowledges dispatch only, not backend termination.
  Completion can win and yield Finished; observed backend cancellation yields
  Cancelled. Each operation has a single terminal outcome. Retain enough state
  to reject ID reuse; do not retain completed query payloads.
- deadline_ms is a relative duration from execute admission; a zero deadline is
  immediately expired. batch_size_hint is optional rows per batch, zero invalid.
- Error position is a one-based Unicode scalar offset in the submitted SQL;
  adapters normalize vendor byte/character positions. SQLSTATE and vendor codes
  remain separate optional strings. Diagnostics must exclude credentials.

TSK-13 cannot meet its “semantics decided” acceptance criterion until confirmed.
Contract tests parse/resolve the WIT and exercise a reference stream lifecycle;
concrete drivers/adapters must additionally test backend cancellation, Arrow
validity and host ownership enforcement. This crate does not claim to enforce
those implementation duties merely by declaring a trait.
