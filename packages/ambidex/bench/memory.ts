// Peak resident memory of another process, on Linux, macOS and Windows, without native code.
//
// - Linux: `VmHWM` in /proc/<pid>/status is the kernel's own high-water mark (exact).
// - Windows: `PeakWorkingSet64` of the process, read through PowerShell (exact).
// - macOS: no high-water mark is readable from outside, so `ps` is sampled while the run is in
//   progress and the largest sample wins (a lower bound; `method` says so).

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Rss {
  /** Resident set now, bytes. */
  readonly currentBytes: number;
  /** Highest resident set seen, bytes. */
  readonly peakBytes: number;
  readonly method: "VmHWM" | "PeakWorkingSet64" | "sampled ps";
}

async function linux(pid: number): Promise<Rss> {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const kb = (key: string): number => {
    const match = new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(status);
    if (match?.[1] === undefined) throw new Error(`no ${key} in /proc/${pid}/status`);
    return Number(match[1]) * 1024;
  };
  return { currentBytes: kb("VmRSS"), peakBytes: kb("VmHWM"), method: "VmHWM" };
}

async function windows(pid: number): Promise<Rss> {
  const command = `$p = Get-Process -Id ${pid}; "$($p.WorkingSet64) $($p.PeakWorkingSet64)"`;
  const { stdout } = await run("powershell", ["-NoProfile", "-NonInteractive", "-Command", command]);
  const [current, peak] = stdout.trim().split(/\s+/).map(Number);
  if (current === undefined || peak === undefined || Number.isNaN(current + peak)) {
    throw new Error(`unexpected PowerShell output: ${stdout}`);
  }
  return { currentBytes: current, peakBytes: peak, method: "PeakWorkingSet64" };
}

async function psSample(pid: number): Promise<number> {
  const { stdout } = await run("ps", ["-o", "rss=", "-p", String(pid)]);
  return Number(stdout.trim()) * 1024;
}

/** Watches one process's resident memory. */
export class RssMeter {
  readonly #pid: number;
  #peak = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor(pid: number) {
    this.#pid = pid;
  }

  /** Starts sampling where the OS has no high-water mark. */
  start(): void {
    if (process.platform === "linux" || process.platform === "win32") return;
    const sample = (): void => {
      psSample(this.#pid).then(
        (bytes) => {
          this.#peak = Math.max(this.#peak, bytes);
        },
        () => {},
      );
    };
    sample();
    this.#timer = setInterval(sample, 20);
  }

  async read(): Promise<Rss> {
    if (process.platform === "linux") return linux(this.#pid);
    if (process.platform === "win32") return windows(this.#pid);
    const current = await psSample(this.#pid);
    this.#peak = Math.max(this.#peak, current);
    return { currentBytes: current, peakBytes: this.#peak, method: "sampled ps" };
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }
}
