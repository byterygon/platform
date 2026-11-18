// The screenshot set of the DBee screens (TSK-64): every screen of the preview (the app on the
// tests' fake core, preview.html) in light and dark, comfortable and compact, at the window size the
// mockup draws (1280 x 800). Development only; nothing here ships.
//
//   node scripts/screenshots.ts [out-dir]        (default: screenshots/, not committed)
//
// The browser is $BYTERYGON_BROWSER, else Chrome, Chromium or Edge from the usual places (the
// search of packages/data-grid's frame check, plus Edge on macOS). The Vite dev server listens on
// 127.0.0.1 only and stops at the end; nothing is fetched from elsewhere.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The screens, as preview.html parameters, named as the mockup names them. */
export const SCREENS = [
  { id: "empty", title: "First run: empty shell", query: "scene=empty" },
  { id: "streaming", title: "Tree, query streaming", query: "scene=streaming" },
  { id: "main", title: "Query with rows", query: "scene=main" },
  { id: "error", title: "Syntax error", query: "scene=error" },
  { id: "sheet", title: "New connection sheet", query: "scene=empty&open=sheet" },
  { id: "approve", title: "Approve access", query: "scene=empty&open=approve" },
  { id: "settings", title: "Settings", query: "scene=main&run=0&open=settings" },
  { id: "toast", title: "Access about to expire", query: "scene=toast" },
  { id: "tabs", title: "More tabs than fit (overflow menu)", query: "scene=main&tabs=12" },
  { id: "shortcuts", title: "Keyboard shortcuts (a Table)", query: "scene=main&run=0&open=shortcuts" },
] as const;
const SCHEMES = ["light", "dark"] as const;
const DENSITIES = ["comfortable", "compact"] as const;

function findBrowser(): string | null {
  const fromEnv = process.env.BYTERYGON_BROWSER ?? process.env.CHROME_PATH;
  if (fromEnv) return existsSync(fromEnv) ? fromEnv : null;
  const onPath = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"].flatMap((name) => (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir, name)));
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const playwright = [join(homedir(), "Library", "Caches", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")].flatMap((dir) =>
    existsSync(dir)
      ? readdirSync(dir)
          .filter((d) => /^chromium-\d+$/.test(d))
          .sort()
          .reverse()
          .flatMap((d) => [join(dir, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"), join(dir, d, "chrome-linux64", "chrome")])
      : [],
  );
  return [...onPath, ...(platform() === "darwin" ? mac : []), ...playwright].find((path) => existsSync(path) && statSync(path).isFile()) ?? null;
}

/** Runs the browser and resolves with its exit code and stderr (killed after 60 s). */
function run(command: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, stderr });
    });
  });
}

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? join(ROOT, "screenshots"));
  const browser = findBrowser();
  if (!browser) {
    console.error("screenshots: no Chromium-family browser found (set BYTERYGON_BROWSER to its executable)");
    process.exit(2);
  }
  mkdirSync(out, { recursive: true });
  const vite = await import("vite");
  const server = await vite.createServer({ configFile: join(ROOT, "vite.config.ts"), root: ROOT, logLevel: "error", server: { host: "127.0.0.1", port: 0, strictPort: false } });
  await server.listen();
  const address = server.httpServer?.address();
  const port = typeof address === "object" && address ? address.port : 5173;
  const profile = mkdtempSync(join(tmpdir(), "dbee-shots-"));
  const shots: { screen: string; scheme: string; density: string; file: string }[] = [];
  try {
    for (const screen of SCREENS) {
      for (const scheme of SCHEMES) {
        for (const density of DENSITIES) {
          const file = `${screen.id}-${scheme}-${density}.png`;
          const url = `http://127.0.0.1:${port}/preview.html?${screen.query}&scheme=${scheme}&density=${density}`;
          // Asynchronous: the dev server runs in this process and must answer while the browser loads.
          const result = await run(browser, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", `--user-data-dir=${join(profile, `${screen.id}-${scheme}-${density}`)}`, "--window-size=1280,800", "--virtual-time-budget=12000", `--screenshot=${join(out, file)}`, url]);
          if (result.code !== 0 || !existsSync(join(out, file))) throw new Error(`screenshots: ${file} failed (${result.code}): ${result.stderr.split("\n").filter((l) => /error/i.test(l) && !/CVDisplayLink|GPU|gl_/.test(l)).slice(-4).join(" | ")}`);
          shots.push({ screen: screen.id, scheme, density, file });
          console.log(`screenshots: ${file}`);
        }
      }
    }
    writeFileSync(join(out, "index.json"), `${JSON.stringify({ size: [1280, 800], screens: SCREENS, shots }, null, 2)}\n`);
  } finally {
    await server.close();
    rmSync(profile, { recursive: true, force: true });
  }
  console.log(`screenshots: ${shots.length} in ${out}`);
}

await main();
