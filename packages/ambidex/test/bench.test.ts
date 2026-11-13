// The benchmark harness (bench/run.ts, crates/ambidex-bench) on a small table: PostgreSQL through
// the native driver, ArrowSink and the WebSocket transport to the client with the decoder in a
// worker, and the report both sides produce. The 1,000,000-row run is `pnpm bench`.
//
// Needs `initdb`/`postgres` and a non-root user, like the PostgreSQL driver's tests; without them
// the test skips, unless BYTERYGON_REQUIRE_POSTGRES=1 (set in CI's Rust job).

import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { serverUnavailable, workspaceRoot } from "./support/rust-server.js";

const skip = serverUnavailable();
const here = dirname(fileURLToPath(import.meta.url));

describe("benchmark harness", { skip }, () => {
  it("streams a generated table end to end and reports time and memory on both sides", async (t) => {
    const root = workspaceRoot();
    const args = ["build", "-p", "ambidex-bench", "--bin", "bench-server", "--locked"];
    if (process.env["AMBIDEX_CARGO_OFFLINE"] === "1") args.push("--offline");
    execFileSync("cargo", args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
    const target = process.env["CARGO_TARGET_DIR"] ?? join(root, "target");
    const binary = resolve(target, "debug", `bench-server${process.platform === "win32" ? ".exe" : ""}`);

    const run = promisify(execFile)(
      process.execPath,
      [join(here, "..", "bench", "run.js"), "--rows", "20000", "--no-build", "--server", binary, "--quiet"],
      { maxBuffer: 1 << 24 },
    );
    let stdout: string;
    try {
      ({ stdout } = await run);
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      const noPostgres = /no initdb\/postgres binaries|initdb failed/.test(stderr);
      if (noPostgres && process.env["BYTERYGON_REQUIRE_POSTGRES"] === undefined) {
        t.skip("no usable PostgreSQL server binaries");
        return;
      }
      throw error;
    }

    const report = JSON.parse(stdout) as {
      config: { rows: number; columns: number };
      runs: Array<{
        client: { rows: number; time_to_first_rows_ms: number; total_ms: number; peak_rss_mib: number };
        server: { chunks: number; ipc_mib: number; peak_rss_mib: number; time_to_first_chunk_ms: number };
      }>;
    };
    assert.equal(report.config.rows, 20000);
    assert.equal(report.config.columns, 10);
    const [first] = report.runs;
    assert.ok(first !== undefined);
    assert.equal(first.client.rows, 20000);
    assert.ok(first.client.time_to_first_rows_ms > 0);
    assert.ok(first.client.time_to_first_rows_ms <= first.client.total_ms);
    assert.ok(first.client.peak_rss_mib > 0);
    assert.ok(first.server.chunks > 1);
    assert.ok(first.server.ipc_mib > 0);
    assert.ok(first.server.peak_rss_mib > 0);
  });
});
