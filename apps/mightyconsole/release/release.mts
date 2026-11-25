#!/usr/bin/env node
// Mightyconsole release (TSK-87): the version, the release notes, one archive per platform, the
// container image and the checksums. The workflow `.github/workflows/mightyconsole-release.yml`
// runs it; every step also runs by hand. Node only (and Docker for `image`); nothing is fetched.
//
//   node apps/mightyconsole/release/release.mts version
//   node apps/mightyconsole/release/release.mts check
//   node apps/mightyconsole/release/release.mts notes [--out FILE]
//   node apps/mightyconsole/release/release.mts package --name linux-x64 --binary PATH --notices FILE [--out DIR]
//   node apps/mightyconsole/release/release.mts image --arch amd64|arm64 --binary PATH --notices FILE [--out DIR] [--revision SHA]
//   node apps/mightyconsole/release/release.mts docs --notices FILE [--out DIR]
//   node apps/mightyconsole/release/release.mts smoke --binary PATH [--version V]
//   node apps/mightyconsole/release/release.mts checksums DIR
//
// Versions (Uy Son, 2026-11-17): each tool ships when it is done. A finished tool adds
// `notes/<N>-<tool>.md` (its "Release after this tool" notes), N counting from 1 in the order the
// tools finish; the version is `0.1.0-alpha.<N>` for the highest N, and `0.1.0` once all six are
// in. `notes/0-foundation.md` is the base every release starts from (`0.1.0-alpha.0` is a build
// of the foundation alone). A fix release of the same tools is `0.1.0-alpha.<N>.<R>`, set by the
// one-line file `FIX` (`<N>.<R>`, e.g. `2.1`; Uy Son, 2026-11-19; stale once a tool is added).
// `check` refuses gaps, duplicates, unknown tools and a tool note without the tool's server module.
//
// Nothing here tags or publishes: `package` and `image` write files, the workflow uploads them as
// artifacts, and only a tag a person pushes leads to a draft release. The same trigger (or a
// manual run with publish on) pushes the image to ghcr.io through `publish-image.sh` (TSK-88).
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(RELEASE_DIR, "..");
export const BASE_VERSION = "0.1.0";

/** The six tools of v0.1 (DOC-20), in the spec's order, with their build tasks. */
export const TOOLS = [
  { id: "nats", name: "NATS", task: "TSK-85" },
  { id: "kafka", name: "Kafka and Schema Registry", task: "TSK-86" },
  { id: "k8s", name: "Kubernetes", task: "TSK-82" },
  { id: "temporal", name: "Temporal", task: "TSK-83" },
  { id: "docker", name: "Docker over SSH", task: "TSK-81" },
  { id: "langgraph", name: "LangGraph", task: "TSK-84" },
] as const;

export interface Note {
  n: number;
  id: string;
  file: string;
  text: string;
}

/** The notes in `dir` (`<N>-<id>.md`), sorted by N; throws on anything `check` refuses. */
export function readNotes(dir = join(RELEASE_DIR, "notes"), toolsDir = join(APP_DIR, "server", "src", "tools")): Note[] {
  const notes: Note[] = [];
  const problems: string[] = [];
  for (const file of readdirSync(dir).sort()) {
    const match = /^(\d+)-([a-z0-9]+)\.md$/.exec(file);
    if (!match) {
      problems.push(`${file}: not <N>-<tool>.md`);
      continue;
    }
    const n = Number(match[1]);
    const id = match[2]!;
    const text = readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trim();
    if (text.length === 0) problems.push(`${file}: empty`);
    if (n === 0 && id !== "foundation") problems.push(`${file}: 0 is the foundation's note`);
    if (n > 0 && !TOOLS.some((t) => t.id === id)) problems.push(`${file}: "${id}" is not one of ${TOOLS.map((t) => t.id).join(", ")}`);
    if (n > 0 && !existsSync(join(toolsDir, id))) problems.push(`${file}: the server has no tool module src/tools/${id}`);
    notes.push({ n, id, file, text });
  }
  notes.sort((a, b) => a.n - b.n);
  if (notes[0]?.id !== "foundation") problems.push("0-foundation.md is missing");
  notes.forEach((note, i) => {
    if (note.n !== i) problems.push(`${note.file}: expected number ${i} (numbers run 0, 1, 2, … without gaps or duplicates)`);
  });
  const ids = notes.map((n) => n.id);
  for (const id of new Set(ids)) if (ids.filter((x) => x === id).length > 1) problems.push(`${id}: more than one note`);
  if (problems.length > 0) throw new Error(`release notes:\n  ${problems.join("\n  ")}`);
  return notes;
}

/**
 * The fix number of the release in `file` (`FIX`: `<tools>.<fix>`, e.g. `2.1`): a rebuild of the same
 * finished tools with bug fixes (Uy Son, 2026-11-19). It counts only while `tools` is the number of
 * finished tools: the next tool's note makes the file stale and the version goes back to
 * `0.1.0-alpha.<tools>`, so nothing needs resetting by hand. No file means 0.
 */
export function readFix(tools: number, file = join(RELEASE_DIR, "FIX")): number {
  if (!existsSync(file)) return 0;
  const text = readFileSync(file, "utf8").trim();
  const match = /^(\d+)\.([1-9]\d*)$/.exec(text);
  if (!match) throw new Error(`FIX: "${text}" is not <tools>.<fix> with a fix of 1 or more (for example 2.1)`);
  return Number(match[1]) === tools ? Number(match[2]) : 0;
}

/**
 * `0.1.0-alpha.N` for N finished tools, `0.1.0-alpha.N.R` for the R-th fix release of the same N tools
 * (`FIX`), `0.1.0` with all six. Fixes after `0.1.0` are `0.1.x` releases, not handled here.
 */
export function versionFor(notes: readonly Note[], fix = readFix(notes.length - 1)): string {
  const tools = notes.length - 1;
  if (tools >= TOOLS.length) {
    if (fix > 0) throw new Error("FIX: fix releases are for alpha versions; a fix to 0.1.0 is 0.1.1 (change BASE_VERSION)");
    return BASE_VERSION;
  }
  return fix > 0 ? `${BASE_VERSION}-alpha.${tools}.${fix}` : `${BASE_VERSION}-alpha.${tools}`;
}

/** RELEASE-NOTES.md: the newest tool first, then the earlier ones, the base, and what is still to come. */
export function releaseNotes(notes: readonly Note[], fix = readFix(notes.length - 1)): string {
  const version = versionFor(notes, fix);
  const tools = notes.filter((n) => n.n > 0);
  const toolName = (id: string) => TOOLS.find((t) => t.id === id)!.name;
  const shipped = new Set(tools.map((t) => t.id));
  const pending = TOOLS.filter((t) => !shipped.has(t.id));
  const lines = [`# Mightyconsole ${version}`, ""];
  if (version === BASE_VERSION) lines.push("All six tools are in: the first complete web version.", "");
  else lines.push(`Alpha ${tools.length} of 6: ${tools.length === 0 ? "the base alone, no tool yet" : `tools in so far: ${tools.map((t) => toolName(t.id)).join(", ")}`}.`, "");
  if (fix > 0) lines.push(`Fix release ${fix} of alpha ${tools.length}: the same tools, with bug fixes.`, "");
  lines.push(
    "Unsigned builds for Linux (x64, arm64; static), macOS (Apple silicon, Intel) and Windows (x64), and a",
    "container image per Linux architecture. They work offline. See README.md to start it; check the",
    "files against SHA256SUMS first.",
    "",
  );
  const newest = tools.at(-1);
  if (newest) lines.push(`## New in this release: ${toolName(newest.id)}`, "", demote(newest.text), "");
  const earlier = tools.slice(0, -1).reverse();
  if (earlier.length > 0) {
    lines.push("## Earlier in 0.1", "");
    for (const t of earlier) lines.push(`### ${toolName(t.id)} (alpha ${t.n})`, "", demote(t.text, 4), "");
  }
  lines.push(demote(notes[0]!.text, 2), "");
  if (pending.length > 0) lines.push("## Not in this release yet", "", ...pending.map((t) => `- ${t.name} (${t.task})`), "");
  lines.push(
    "## Known limits",
    "",
    "- Everyone signs in: built-in accounts (sign-up open by default) and OIDC; the default administrator's password is in DATA/admin-password (README.md). Roles are not in this version: every signed-in person may do everything.",
    "- Not code-signed; no updater (install a new release by replacing the file or loading the new image).",
    "",
  );
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/** Shifts headings one level down, so a note's own `##` sits under the release's `##`. */
function demote(text: string, minimum = 3): string {
  const headings = [...text.matchAll(/^(#+) /gm)].map((m) => m[1]!.length);
  const shift = headings.length === 0 ? 0 : Math.max(0, minimum - Math.min(...headings));
  return shift === 0 ? text : text.replace(/^(#+) /gm, (_, hashes: string) => `${"#".repeat(hashes.length + shift)} `);
}

// ---------------------------------------------------------------------------------------------
// Files

const PLATFORMS: Record<string, { exe: string; archive: "tar.gz" | "zip" }> = {
  "linux-x64": { exe: "mightyconsole-server", archive: "tar.gz" },
  "linux-arm64": { exe: "mightyconsole-server", archive: "tar.gz" },
  "macos-arm64": { exe: "mightyconsole-server", archive: "tar.gz" },
  "macos-x64": { exe: "mightyconsole-server", archive: "tar.gz" },
  "windows-x64": { exe: "mightyconsole-server.exe", archive: "zip" },
};

/** Copies the files every artifact carries next to the binary. */
function stageDocs(dir: string, notices: string, notes: readonly Note[]): void {
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(APP_DIR, "LICENSE"), join(dir, "LICENSE"));
  writeFileSync(join(dir, "README.md"), readFileSync(join(RELEASE_DIR, "README.md"), "utf8").replaceAll("<version>", versionFor(notes)));
  copyFileSync(notices, join(dir, "THIRD-PARTY-NOTICES.txt"));
  writeFileSync(join(dir, "RELEASE-NOTES.md"), releaseNotes(notes));
}

/** `mightyconsole-<version>-<name>.tar.gz` (or `.zip` on Windows) with one folder inside. */
export function packageArchive(options: { name: string; binary: string; notices: string; out: string; notes?: Note[] }): string {
  const platform = PLATFORMS[options.name];
  if (!platform) throw new Error(`--name: one of ${Object.keys(PLATFORMS).join(", ")}`);
  const notes = options.notes ?? readNotes();
  const folder = `mightyconsole-${versionFor(notes)}-${options.name}`;
  const work = join(options.out, ".stage");
  rmSync(work, { recursive: true, force: true });
  const stage = join(work, folder);
  stageDocs(stage, options.notices, notes);
  copyFileSync(options.binary, join(stage, platform.exe));
  chmodSync(join(stage, platform.exe), 0o755);
  const archive = resolve(options.out, `${folder}.${platform.archive}`);
  rmSync(archive, { force: true });
  if (platform.archive === "tar.gz") {
    execFileSync("tar", ["-czf", archive, "-C", work, folder], { stdio: "inherit" });
  } else {
    // Windows' own bsdtar writes zip files (Git Bash's GNU tar first on PATH does not).
    const tar = process.platform === "win32" ? join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe") : "tar";
    execFileSync(tar, ["-a", "-cf", archive, "-C", work, folder], { stdio: "inherit" });
  }
  rmSync(work, { recursive: true, force: true });
  return archive;
}

/** Builds `byterygon/mightyconsole:<version>` for one architecture and saves it, gzipped. */
export function buildImage(options: { arch: string; binary: string; notices: string; out: string; revision?: string; notes?: Note[] }): string {
  if (options.arch !== "amd64" && options.arch !== "arm64") throw new Error("--arch: amd64 or arm64");
  const notes = options.notes ?? readNotes();
  const version = versionFor(notes);
  const context = join(options.out, `.image-${options.arch}`);
  rmSync(context, { recursive: true, force: true });
  stageDocs(context, options.notices, notes);
  copyFileSync(options.binary, join(context, "mightyconsole-server"));
  chmodSync(join(context, "mightyconsole-server"), 0o755);
  mkdirSync(join(context, "data"));
  writeFileSync(join(context, "data", ".keep"), "");
  const tag = `byterygon/mightyconsole:${version}`;
  // The commit the image was built from (label org.opencontainers.image.revision, TSK-88).
  const revision = options.revision ?? process.env["GITHUB_SHA"] ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync(
    "docker",
    ["buildx", "build", "--platform", `linux/${options.arch}`, "--build-arg", `VERSION=${version}`, "--build-arg", `REVISION=${revision}`, "--provenance=false", "-f", join(RELEASE_DIR, "Dockerfile"), "-t", tag, "--load", context],
    { stdio: "inherit" },
  );
  const archive = resolve(options.out, `mightyconsole-${version}-image-linux-${options.arch}.tar.gz`);
  execFileSync("sh", ["-c", `docker save "$1" | gzip -9 > "$2"`, "sh", tag, archive], { stdio: "inherit" });
  rmSync(context, { recursive: true, force: true });
  return archive;
}

/** LICENSE, README.md, THIRD-PARTY-NOTICES.txt and RELEASE-NOTES.md, for the release's top level. */
export function writeDocs(options: { notices: string; out: string }): void {
  stageDocs(options.out, options.notices, readNotes());
}

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** GET over TLS to 127.0.0.1 with the Host the browser would send; the certificate is the
 * server's own self-signed one, so it is not verified here. */
function get(port: number, path: string): Promise<Answer> {
  return new Promise((resolvePromise, reject) => {
    const req = request({ host: "127.0.0.1", port, path, servername: "localhost", headers: { host: `localhost:${port}` }, rejectUnauthorized: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** Starts a release binary as a user would (no --ui, a fresh data directory) and checks that it
 * says its version, serves the built-in UI with its session, CSRF meta and CSP, serves the
 * page's script, and stops. Runs on every platform the workflow builds natively. */
export async function smoke(options: { binary: string; version?: string }): Promise<void> {
  const problems: string[] = [];
  const versionLine = execFileSync(options.binary, ["--version"], { encoding: "utf8" }).trim();
  console.log(versionLine);
  if (options.version && !versionLine.startsWith(`mightyconsole-server ${options.version} `)) problems.push(`--version does not say ${options.version}`);
  const port = await new Promise<number>((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port: free } = probe.address() as { port: number };
      probe.close(() => done(free));
    });
  });
  const data = mkdtempSync(join(tmpdir(), "mightyconsole-smoke-"));
  const server = spawn(options.binary, ["--listen", `127.0.0.1:${port}`, "--data", data], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`the server did not start:\n${log}`)), 30_000);
      server.stderr!.on("data", (chunk: Buffer) => {
        log += chunk.toString();
        if (log.includes("open https://localhost:")) {
          clearTimeout(timer);
          done();
        }
      });
      server.on("exit", (code) => fail(new Error(`the server exited (${code}):\n${log}`)));
    });
    console.log(log.trim());
    if (!/UI built in \(\d+ files\)/.test(log)) problems.push("the server has no built-in UI");
    const page = await get(port, "/");
    if (page.status !== 200) problems.push(`GET / answered ${page.status}`);
    if (!String(page.headers["content-security-policy"] ?? "").startsWith("default-src 'self'")) problems.push("the page has no CSP");
    // Everyone signs in (DOC-25 §3.2.5, §3.2.6): the signed-out page and its pre-session token.
    if (!String(page.headers["set-cookie"] ?? "").includes("__Host-mc_pre=")) problems.push("the page sets no pre-session cookie");
    if (!page.body.includes('<meta name="mightyconsole-auth" content="signed-out">')) problems.push("the page is not the signed-out page");
    if (!page.body.includes('name="mightyconsole-pre"')) problems.push("the page has no pre-session token");
    // The default administrator (DOC-25 §3.2.7): its password in DATA/admin-password, the log names
    // the file and never the password.
    const passwordFile = join(data, "admin-password");
    if (!existsSync(passwordFile)) problems.push("no DATA/admin-password after a first start");
    else if (log.includes(readFileSync(passwordFile, "utf8").trim())) problems.push("the log holds the administrator's password");
    if (!log.includes(`its password is in ${passwordFile}`)) problems.push("the log does not name DATA/admin-password");
    const script = /assets\/[^"]+\.js/.exec(page.body)?.[0];
    if (!script) problems.push("the page names no script");
    else if ((await get(port, `/${script}`)).status !== 200) problems.push(`${script} is not served`);
    if ((await get(port, "/assets/missing.js")).status !== 404) problems.push("a missing asset is not a 404");
  } finally {
    server.kill();
    rmSync(data, { recursive: true, force: true });
  }
  if (problems.length > 0) throw new Error(`smoke check failed:\n  ${problems.join("\n  ")}`);
  console.log("smoke: ok");
}

/** SHA256SUMS over every file in `dir` (not itself), `sha256sum -c` format, sorted by name. */
export async function writeChecksums(dir: string): Promise<string> {
  const files = readdirSync(dir)
    .filter((f) => f !== "SHA256SUMS" && statSync(join(dir, f)).isFile())
    .sort();
  const lines: string[] = [];
  for (const file of files) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(dir, file))) hash.update(chunk as Buffer);
    lines.push(`${hash.digest("hex")}  ${file}`);
  }
  writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Command line

function option(args: string[], name: string, fallback?: string): string {
  const at = args.indexOf(name);
  const value = at >= 0 ? args[at + 1] : fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  const out = () => resolve(option(rest, "--out", join(APP_DIR, "..", "..", "target", "mightyconsole-release")));
  switch (command) {
    case "version":
      console.log(versionFor(readNotes()));
      return;
    case "check": {
      const notes = readNotes();
      console.log(`release notes ok: ${versionFor(notes)} (${notes.length - 1} of ${TOOLS.length} tools)`);
      return;
    }
    case "notes": {
      const text = releaseNotes(readNotes());
      const at = rest.indexOf("--out");
      if (at >= 0) writeFileSync(rest[at + 1]!, text);
      else process.stdout.write(text);
      return;
    }
    case "package": {
      mkdirSync(out(), { recursive: true });
      console.log(packageArchive({ name: option(rest, "--name"), binary: option(rest, "--binary"), notices: option(rest, "--notices"), out: out() }));
      return;
    }
    case "image": {
      mkdirSync(out(), { recursive: true });
      console.log(buildImage({ arch: option(rest, "--arch"), binary: option(rest, "--binary"), notices: option(rest, "--notices"), out: out(), ...(rest.includes("--revision") ? { revision: option(rest, "--revision") } : {}) }));
      return;
    }
    case "docs": {
      mkdirSync(out(), { recursive: true });
      writeDocs({ notices: option(rest, "--notices"), out: out() });
      return;
    }
    case "smoke": {
      const at = rest.indexOf("--version");
      await smoke({ binary: option(rest, "--binary"), ...(at >= 0 ? { version: rest[at + 1]! } : {}) });
      return;
    }
    case "checksums": {
      const dir = rest[0];
      if (!dir) throw new Error("checksums DIR");
      console.log(await writeChecksums(dir));
      return;
    }
    default:
      console.error(`usage: release.mts version | check | notes [--out FILE] | package --name NAME --binary PATH --notices FILE [--out DIR] | image --arch amd64|arm64 --binary PATH --notices FILE [--out DIR] [--revision SHA] | docs --notices FILE [--out DIR] | smoke --binary PATH [--version V] | checksums DIR`);
      process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

