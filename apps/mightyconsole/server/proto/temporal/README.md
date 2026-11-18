# Vendored Temporal API protos

The Protobuf definitions of Temporal's gRPC API, copied unchanged from
[`temporalio/api`](https://github.com/temporalio/api) (MIT, see `LICENSE`).

| | |
| --- | --- |
| Release tag | `v1.64.3` |
| Commit | `7a01ad04a0220c824dca78b24896336aeb84622a` |
| Files | `temporal/api/**` and the `google/api` and `nexusannotations` files they import: the import closure of `temporal/api/workflowservice/v1/service.proto` (51 files), plus `temporal/api/operatorservice/v1/` (2 files, TSK-93: `ListSearchAttributes`), whose imports are in that closure already |

`google/api/*.proto` is Apache-2.0 (its own headers); the `google/protobuf` well-known types come
from `protox`.

## How it is built (offline)

`build.rs` compiles `temporal/api/workflowservice/v1/service.proto` and
`temporal/api/operatorservice/v1/service.proto` with
[`protox`](https://crates.io/crates/protox) (a pure Rust protobuf compiler: no `protoc`, no
network) and `tonic-prost-build` writes the `WorkflowService` and `OperatorService` clients and
the messages into `$OUT_DIR`; `src/tools/temporal/proto.rs` includes them. Nothing is generated into the repository.

## Updating

Pick a release tag that the lab's Temporal server (`lab/compose.yaml`) understands, then, from a
clone of `temporalio/api` at that tag, copy the import closure of the service file here (every
`import` of a file that is not `google/protobuf/*`, transitively), replace this table and the
`LICENSE`, and run `cargo test -p mightyconsole-server --features lab-tests temporal` with the lab up.
