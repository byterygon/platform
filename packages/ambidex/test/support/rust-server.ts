// Starts the Rust `conformance-server` (crates/ambidex-conformance): the fixture API served by
// the real engine, router and axum WebSocket transport over rustls on a loopback port.
//
// The binary is built with cargo on first use. Without cargo the integration tests skip, unless
// AMBIDEX_REQUIRE_RUST_SERVER=1 (set in CI), which turns a missing server into a failure.

import { type ChildProcessByStdio, execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import * as tls from "node:tls";
import { fileURLToPath } from "node:url";

import type { WebSocketLike } from "../../src/index.js";

const here = dirname(fileURLToPath(import.meta.url));

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

export interface ServerInfo {
  readonly url: string;
  readonly origin: string;
  readonly ca_pem: string;
  readonly cookie_name: string;
  readonly schema_hash: string;
}

export interface Session {
  readonly cookie: string;
  readonly csrf: string;
}

/** Why the server is unavailable, or `undefined` when it can be built. */
export function serverUnavailable(): string | undefined {
  if (process.env["AMBIDEX_REQUIRE_RUST_SERVER"] === "1") return undefined;
  try {
    execFileSync("cargo", ["--version"], { stdio: "ignore" });
    return undefined;
  } catch {
    return "cargo not found; set AMBIDEX_REQUIRE_RUST_SERVER=1 to require the Rust server";
  }
}

let built: string | undefined;

function binary(): string {
  if (built !== undefined) return built;
  const root = workspaceRoot();
  const args = [
    "build",
    "-p",
    "ambidex-conformance",
    "--no-default-features",
    "--features",
    "ws",
    "--bin",
    "conformance-server",
    "--locked",
    "--message-format",
    "short",
  ];
  if (process.env["AMBIDEX_CARGO_OFFLINE"] === "1") args.push("--offline");
  execFileSync("cargo", args, { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  const target = process.env["CARGO_TARGET_DIR"] ?? join(root, "target");
  built = resolve(target, "debug", "conformance-server");
  return built;
}

export class RustServer {
  readonly info: ServerInfo;
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
  }

  static async start(): Promise<RustServer> {
    const child = spawn(binary(), [], { stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const first = await lines.next();
    if (first.done === true) throw new Error("conformance-server exited before starting");
    const info = JSON.parse(first.value) as ServerInfo;
    // Trust the per-run certificate for this process only (and nothing else changes).
    tls.setDefaultCACertificates([...tls.getCACertificates("default"), info.ca_pem]);
    return new RustServer(child, info, lines);
  }

  async #command(command: string): Promise<unknown> {
    this.#child.stdin.write(`${command}\n`);
    const line = await this.#lines.next();
    if (line.done === true) throw new Error("conformance-server exited");
    return JSON.parse(line.value);
  }

  session(): Promise<Session> {
    return this.#command("session") as Promise<Session>;
  }

  /** Fixture handler events since the last call, e.g. `["Started:wait", "Cancelled:wait"]`. */
  async events(): Promise<string[]> {
    return ((await this.#command("events")) as { events: string[] }).events;
  }

  /** Polls `events()` until `expected` was seen, collecting everything seen on the way. */
  async waitForEvent(expected: string, timeoutMs = 5000): Promise<string[]> {
    const seen: string[] = [];
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      seen.push(...(await this.events()));
      if (seen.includes(expected)) return seen;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no ${expected} event; saw ${JSON.stringify(seen)}`);
  }

  /** A browser-like socket factory: sends the session cookie and the page origin. */
  socketFactory(session: Session, origin = this.info.origin): (url: string) => WebSocketLike {
    const cookie = `${this.info.cookie_name}=${session.cookie}`;
    return (url) =>
      // Node's WebSocket (undici) accepts headers, which a browser sets itself.
      new (WebSocket as unknown as new (url: string, init: unknown) => WebSocketLike)(url, {
        headers: { Origin: origin, Cookie: cookie },
      });
  }

  async stop(): Promise<void> {
    if (this.#child.exitCode !== null) return;
    const exited = new Promise((r) => this.#child.once("exit", r));
    this.#child.stdin.end();
    await exited;
  }
}
