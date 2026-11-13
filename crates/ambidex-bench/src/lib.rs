//! The benchmark's server side (TSK-36): a PostgreSQL table of 1,000,000 rows x 10 mixed columns
//! streamed through the native driver, `ArrowSink` and the Ambidex WebSocket transport to the
//! TypeScript client, which decodes it in a worker (`packages/ambidex/bench`).
//!
//! Everything runs on loopback and nothing is fetched: the server starts a throwaway PostgreSQL
//! cluster from locally installed `initdb`/`postgres` binaries (or uses a server the caller
//! already runs), and the self-signed TLS certificate is generated in memory.

pub mod api;
pub mod pg;

pub use api::{BenchApi, api_info, generated_dir, router, schema_hash, server_config};
