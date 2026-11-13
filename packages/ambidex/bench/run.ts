// The benchmark (TSK-36): 1,000,000 rows x 10 mixed columns from PostgreSQL through the native
// driver, ArrowSink and the Ambidex WebSocket transport to this client, which decodes the Arrow
// IPC chunks in a worker thread. One command:
//
//   pnpm bench [--rows N] [--runs N] [--out file.json] [--pg-port P ...]   (see README.md)
//
// It builds and starts `bench-server` (crates/ambidex-bench), which creates the table in a
// throwaway PostgreSQL cluster (or in the server `--pg-port` names), then calls `bench.rows` and
// reports time to first rows, total time and peak memory on both sides as JSON on stdout (a
// summary goes to stderr). Everything stays on loopback; nothing is fetched.

import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";

import { type ArrowDecoderPort } from "../src/arrow.js";
import { decodeArrow } from "../src/arrow.js";
import { WebSocketTransport, type WebSocketLike, createClient } from "../src/index.js";
import * as api from "./generated/api.js";
import { RssMeter } from "./memory.js";

const here = dirname(fileURLToPath(import.meta.url));

interface Options {
  rows: number;
  runs: number;
  out: string | undefined;
  server: string | undefined;
  build: boolean;
  /** Passed to bench-server unchanged. */
  serverArgs: string[];
  batchRows: number | undefined;
  quiet: boolean;
  /** An untimed small run first: the worker thread loads apache-arrow on its first message. */
  warmup: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    rows: 1_000_000,
    runs: 1,
    out: undefined,
    server: undefined,
    build: true,
    serverArgs: [],
    batchRows: undefined,
    quiet: false,
    warmup: true,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i] ?? "";
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${flag} needs a value`);
      return value;
    };
    switch (flag) {
      case "--rows":
        options.rows = Number(next());
        break;
      case "--runs":
        options.runs = Number(next());
        break;
      case "--out":
        options.out = next();
        break;
      case "--server":
        options.server = next();
        break;
      case "--no-build":
        options.build = false;
        break;
      case "--batch-rows":
        options.batchRows = Number(next());
        break;
      case "--no-warmup":
        options.warmup = false;
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--pg-port":
      case "--pg-user":
      case "--pg-database":
      case "--frame-bytes":
      case "--initial-credits":
      case "--max-credits":
        options.serverArgs.push(flag, next());
        break;
      default:
        throw new Error(`unknown option ${flag}`);
    }
  }
  for (const [name, value] of [["--rows", options.rows], ["--runs", options.runs]] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  return options;
}

/** The repository root: the first ancestor with a Cargo.lock. */
function workspaceRoot(): string {
  let dir = here;
  while (!existsSync(join(dir, "Cargo.lock"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("workspace root not found");
    dir = parent;
  }
  return dir;
}

/** Builds the release binary: debug builds say nothing about throughput. */
function serverBinary(options: Options): string {
  if (options.server !== undefined) return resolve(options.server);
  const root = workspaceRoot();
  if (options.build) {
    const args = ["build", "--release", "-p", "ambidex-bench", "--bin", "bench-server", "--locked"];
    if (process.env["AMBIDEX_CARGO_OFFLINE"] === "1") args.push("--offline");
    execFileSync("cargo", args, { cwd: root, stdio: ["ignore", "inherit", "inherit"] });
  }
  const target = process.env["CARGO_TARGET_DIR"] ?? join(root, "target");
  return resolve(target, "release", `bench-server${process.platform === "win32" ? ".exe" : ""}`);
}

interface ServerInfo {
  readonly url: string;
  readonly origin: string;
  readonly ca_pem: string;
  readonly cookie_name: string;
  readonly schema_hash: string;
  readonly rows: number;
  readonly load_ms: number;
  readonly frame_bytes: number;
  readonly initial_credits: number;
  readonly max_credits: number;
}

class Server {
  readonly info: ServerInfo;
  readonly pid: number;
  readonly #child: ChildProcessByStdio<Writable, Readable, null>;
  readonly #lines: AsyncIterator<string>;

  private constructor(
    child: ChildProcessByStdio<Writable, Readable, null>,
    info: ServerInfo,
    lines: AsyncIterator<string>,
  ) {
    this.#child = child;
    this.info = info;
    this.#lines = lines;
    this.pid = child.pid ?? 0;
  }

  static async start(binary: string, args: string[]): Promise<Server> {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const first = await lines.next();
    if (first.done === true) throw new Error("bench-server exited before it was ready");
    const info = JSON.parse(first.value) as ServerInfo;
    // Trust the per-run certificate for this process only.
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), info.ca_pem]);
    return new Server(child, info, lines);
  }

  async session(): Promise<{ cookie: string; csrf: string }> {
    this.#child.stdin.write("session\n");
    const line = await this.#lines.next();
    if (line.done === true) throw new Error("bench-server exited");
    return JSON.parse(line.value) as { cookie: string; csrf: string };
  }

  /** A browser-like socket factory: sends the session cookie and the page origin. */
  socketFactory(session: { cookie: string }): (url: string) => WebSocketLike {
    const cookie = `${this.info.cookie_name}=${session.cookie}`;
    return (url) =>
      // Node's WebSocket (undici) accepts headers, which a browser sets itself.
      new (WebSocket as unknown as new (url: string, init: unknown) => WebSocketLike)(url, {
        headers: { Origin: this.info.origin, Cookie: cookie },
      });
  }

  async stop(): Promise<void> {
    if (this.#child.exitCode !== null) return;
    const exited = new Promise((r) => this.#child.once("exit", r));
    this.#child.stdin.end();
    await exited;
  }
}

/** The decoder worker, adapted to the Web `Worker` shape `decodeArrow` takes. */
function startDecoder(): { port: ArrowDecoderPort; stop(): Promise<number> } {
  type Listener = (event: { readonly data?: unknown }) => void;
  const worker = new Worker(new URL("./arrow-worker.js", import.meta.url));
  const wrapped = new Map<Listener, (data: unknown) => void>();
  return {
    port: {
      postMessage: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
      addEventListener: (type, listener) => {
        const on = (data: unknown): void => listener({ data });
        wrapped.set(listener, on);
        worker.on(type, on);
      },
      removeEventListener: (type, listener) => {
        const on = wrapped.get(listener);
        if (on !== undefined) worker.off(type, on);
      },
    },
    stop: () => worker.terminate(),
  };
}

const MiB = 1024 * 1024;
const round = (n: number, digits = 1): number => Number(n.toFixed(digits));

interface RunReport {
  readonly client: {
    readonly time_to_schema_ms: number;
    readonly time_to_first_rows_ms: number;
    readonly total_ms: number;
    readonly rows: number;
    readonly batches: number;
    readonly rows_per_second: number;
    readonly mib_per_second: number;
    readonly rss_before_mib: number;
    /** Whole Node process, main thread and decoder worker (getrusage maxRSS; lifetime peak). */
    readonly peak_rss_mib: number;
  };
  readonly server: {
    readonly connect_ms: number;
    readonly time_to_first_chunk_ms: number;
    readonly query_ms: number;
    readonly total_ms: number;
    readonly chunks: number;
    readonly ipc_mib: number;
    readonly rss_before_mib: number;
    /** The bench-server process (not the PostgreSQL server); lifetime peak. */
    readonly peak_rss_mib: number;
    readonly rss_method: string;
  };
}

async function oneRun(
  server: Server,
  options: Options,
  rowCount: number,
  decoder: ReturnType<typeof startDecoder>,
): Promise<RunReport> {
  const session = await server.session();
  const client = createClient(
    api,
    new WebSocketTransport({
      url: server.info.url,
      auth: () => ({ csrf: session.csrf }),
      createSocket: server.socketFactory(session),
    }),
  );
  // The handshake is not part of the measurement.
  await client.$connect();

  const meter = new RssMeter(server.pid);
  meter.start();
  const serverBefore = await meter.read();
  const clientBefore = process.memoryUsage.rss();

  const input =
    options.batchRows === undefined
      ? { rows: rowCount }
      : { rows: rowCount, batch_rows: options.batchRows };
  const t0 = performance.now();
  const arrow = decodeArrow(client.bench.rows(input), decoder.port);
  await arrow.schema;
  const tSchema = performance.now() - t0;

  let tFirst = Number.NaN;
  let rows = 0;
  let batches = 0;
  let firstId: bigint | undefined;
  let lastId: bigint | undefined;
  for await (const batch of arrow.batches()) {
    if (batch.numRows === 0) continue;
    if (batches === 0) tFirst = performance.now() - t0;
    batches += 1;
    rows += batch.numRows;
    // Column 0 is the int8 id: row n has id n, so the ends tell whether rows were lost or reordered.
    const ids = batch.columns[0]?.values as BigInt64Array | undefined;
    if (ids === undefined) throw new Error("column 0 has no values");
    firstId ??= ids[0];
    lastId = ids[batch.numRows - 1];
  }
  const summary = await arrow.result;
  const tTotal = performance.now() - t0;

  if (rows !== rowCount || summary.rows !== rowCount) {
    throw new Error(`expected ${rowCount} rows, got ${rows} (server says ${summary.rows})`);
  }
  if (firstId !== 0n || lastId !== BigInt(rowCount - 1)) {
    throw new Error(`ids run from ${firstId} to ${lastId}, expected 0 to ${rowCount - 1}`);
  }

  const serverAfter = await meter.read();
  meter.stop();
  const clientPeak = process.resourceUsage().maxRSS * 1024; // kilobytes on every platform
  client.$close();

  return {
    client: {
      time_to_schema_ms: round(tSchema),
      time_to_first_rows_ms: round(tFirst),
      total_ms: round(tTotal),
      rows,
      batches,
      rows_per_second: Math.round(rows / (tTotal / 1000)),
      mib_per_second: round(summary.bytes / MiB / (tTotal / 1000)),
      rss_before_mib: round(clientBefore / MiB),
      peak_rss_mib: round(clientPeak / MiB),
    },
    server: {
      connect_ms: summary.connect_ms,
      time_to_first_chunk_ms: summary.first_chunk_ms,
      query_ms: summary.query_ms,
      total_ms: summary.total_ms,
      chunks: summary.chunks,
      ipc_mib: round(summary.bytes / MiB),
      rss_before_mib: round(serverBefore.currentBytes / MiB),
      peak_rss_mib: round(serverAfter.peakBytes / MiB),
      rss_method: serverAfter.method,
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const binary = serverBinary(options);
  const log = (message: string): void => {
    if (!options.quiet) process.stderr.write(`${message}\n`);
  };

  log(`starting ${binary}`);
  const server = await Server.start(binary, ["--rows", String(options.rows), ...options.serverArgs]);
  const decoder = startDecoder();
  const reports: RunReport[] = [];
  try {
    if (server.info.schema_hash !== api.SCHEMA_HASH) {
      throw new Error("generated api.ts is stale: run `cargo run -p ambidex-bench --bin bench-gen`");
    }
    if (options.warmup) await oneRun(server, options, Math.min(1000, options.rows), decoder);
    for (let i = 0; i < options.runs; i++) {
      const report = await oneRun(server, options, options.rows, decoder);
      reports.push(report);
      log(
        `run ${i + 1}/${options.runs}: first rows ${report.client.time_to_first_rows_ms} ms, total ` +
          `${report.client.total_ms} ms (${report.client.rows_per_second} rows/s), peak RSS client ` +
          `${report.client.peak_rss_mib} MiB, server ${report.server.peak_rss_mib} MiB`,
      );
    }
  } finally {
    await decoder.stop();
    await server.stop();
  }

  const cpus = os.cpus();
  const result = {
    benchmark: "ambidex-postgres-arrow-1m",
    date: new Date().toISOString(),
    platform: {
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpu: cpus[0]?.model ?? "unknown",
      cpus: cpus.length,
      memory_gib: round(os.totalmem() / 1024 ** 3),
      node: process.version,
    },
    config: {
      rows: options.rows,
      columns: 10,
      batch_rows: options.batchRows ?? "driver default",
      frame_bytes: server.info.frame_bytes,
      initial_credits: server.info.initial_credits,
      max_credits: server.info.max_credits,
      table_load_ms: server.info.load_ms,
    },
    runs: reports,
  };
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out !== undefined) writeFileSync(options.out, json);
  else process.stdout.write(json);
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    process.stderr.write(`bench: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
