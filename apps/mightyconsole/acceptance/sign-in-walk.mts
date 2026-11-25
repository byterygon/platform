#!/usr/bin/env node
// The sign-in in a real browser against the lab's Dex (DOC-25 §3.2.2, §6; TSK-136): what only a
// browser shows. The `SameSite=Lax` login cookie survives the IdP's cross-site redirect back, and
// the 200 page's meta refresh carries the new `SameSite=Strict` session to the page asked for.
//
//   node sign-in-walk.mts SERVER EVIDENCE_DIR
//
// It starts SERVER on https://localhost:17443 (the redirect URI the lab's Dex client registers)
// with `[auth.oidc]` from `lab/.generated/credentials.json`. It opens /nats signed out, which goes
// to Dex's login form, and signs in as alice. It then checks the page, the cookies (through
// DevTools, so HttpOnly ones too) and the WebSocket, and signs out. Needs `lab up idp`, a built UI
// (`pnpm --filter @byterygon/mightyconsole build`, done here when missing) and a Chromium browser.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "..");
const PORT = 17443;
const ORIGIN = `https://localhost:${PORT}`;

/** A cookie's attributes, never its value (the evidence is kept). */
const attributes = (c: Cookie | undefined) => (c ? `sameSite=${c.sameSite} httpOnly=${c.httpOnly} secure=${c.secure} path=${c.path}` : "missing");

interface Cookie {
  name: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: string;
  path: string;
}

async function main(server: string, evidence: string): Promise<number> {
  const { findBrowser } = await import("../../../packages/ui/scripts/browser-check.ts");
  const cdp = await import("../ui/scripts/cdp.ts");
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error("sign-in walk: no browser (set BYTERYGON_BROWSER)");
    return 1;
  }
  const generated = join(APP, "lab", ".generated");
  const credentials = JSON.parse(readFileSync(join(generated, "credentials.json"), "utf8")) as { idp?: Record<string, unknown> };
  const idp = credentials.idp as { issuer: string; caFile: string; clientId: string; clientSecretFile: string; redirectUris: string[]; users: { username: string; email: string; password: string }[] } | undefined;
  if (!idp) {
    console.error("sign-in walk: no idp in lab/.generated/credentials.json (run `lab up idp`)");
    return 1;
  }
  if (!idp.redirectUris.includes(`${ORIGIN}/auth/callback`)) {
    console.error(`sign-in walk: the lab's Dex does not register ${ORIGIN}/auth/callback (run \`lab down\`, then \`lab up idp\`)`);
    return 1;
  }
  const ui = join(APP, "ui", "dist");
  if (!existsSync(join(ui, "index.html"))) {
    const build = spawnSync("pnpm", ["--filter", "@byterygon/mightyconsole", "build"], { stdio: "inherit" });
    if (build.status !== 0) return 1;
  }
  const alice = idp.users.find((u) => u.username === "alice")!;
  const data = mkdtempSync(join(tmpdir(), "mightyconsole-sign-in-"));
  const shots = join(evidence, "screenshots");
  mkdirSync(shots, { recursive: true });
  const config = join(data, "config.toml");
  writeFileSync(
    config,
    [
      "[server]",
      `listen = "127.0.0.1:${PORT}"`,
      `public_origin = "${ORIGIN}"`,
      "",
      "[auth.oidc]",
      `issuer = "${idp.issuer}"`,
      `client_id = "${idp.clientId}"`,
      `client_secret_file = "${join(generated, idp.clientSecretFile)}"`,
      `ca_file = "${join(generated, idp.caFile)}"`,
      'scopes = ["openid", "profile", "email", "groups"]',
      'display_name = "Lab Dex"',
      "",
    ].join("\n"),
  );
  chmodSync(config, 0o600);
  let child: ChildProcess | undefined;
  let chrome: ChildProcess | undefined;
  const failures: string[] = [];
  const check = (ok: boolean, what: string) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
    if (!ok) failures.push(what);
  };
  try {
    child = spawn(server, ["--config", config, "--data", data, "--ui", ui], { stdio: ["ignore", "ignore", "pipe"] });
    const [startup] = await cdp.waitForLine(child, /[\s\S]*open https:\/\/localhost:\d+\//, "mightyconsole-server");
    writeFileSync(join(evidence, "sign-in-server.log"), startup ?? "");
    check(/sign-in through https:\/\/localhost:5556\/dex/.test(startup ?? ""), "the server signs in through the lab's Dex");
    const browser = await cdp.launchBrowser(browserPath, data);
    chrome = browser.chrome;
    const page = await cdp.openPage(browser.cdp);
    const cookies = async (url: string) => ((await page.send("Network.getCookies", { urls: [url] })) as { cookies: Cookie[] }).cookies;

    // Signed out: the page shows the sign-in (built-in accounts and the IdP); its "Sign in with
    // Lab Dex" goes to Dex's form.
    await page.navigate(`${ORIGIN}/nats`);
    const offered = await cdp.waitUntil(page, `[...document.querySelectorAll("a")].some((a) => a.textContent === "Sign in with Lab Dex")`, 30_000);
    check(offered, "a signed-out page offers the sign-in form and Sign in with Lab Dex");
    await page.evaluate(`[...document.querySelectorAll("a")].find((a) => a.textContent === "Sign in with Lab Dex").click()`);
    const atDex = await cdp.waitUntil(page, `location.host === "localhost:5556" && document.querySelector("input[name=login]")`, 30_000);
    check(atDex, "a signed-out page goes to Dex's login form");
    await page.screenshot(join(shots, "sign-in-01-dex-form.png"));
    const pending = (await cookies(ORIGIN)).find((c) => c.name === "__Host-mc_login");
    check(pending?.sameSite === "Lax" && pending.httpOnly && pending.secure && pending.path === "/", `the login cookie is __Host-, Lax, HttpOnly, Secure (${attributes(pending)})`);

    // Sign in at Dex; the browser comes back to the callback and on to /nats.
    await page.evaluate(`(() => {
      document.querySelector("input[name=login]").value = ${JSON.stringify(alice.email)};
      document.querySelector("input[name=password]").value = ${JSON.stringify(alice.password)};
      document.querySelector("form").requestSubmit();
      return true;
    })()`);
    const back = await cdp.waitUntil(page, `location.origin === ${JSON.stringify(ORIGIN)} && location.pathname === "/nats" && document.querySelector('meta[name="mightyconsole-auth"]')?.content === "signed-in"`, 30_000);
    check(back, "after Dex the browser lands on /nats, signed in (the Lax login cookie came back, the meta refresh carried the Strict session)");
    const jar = await cookies(ORIGIN);
    const session = jar.find((c) => c.name === "__Host-ambidex_session");
    check(session?.sameSite === "Strict" && session.httpOnly && session.secure && session.path === "/", `the session cookie is __Host-, Strict, HttpOnly, Secure (${attributes(session)})`);
    check(!jar.some((c) => c.name === "__Host-mc_login"), "the login cookie is gone");
    const connected = await cdp.waitUntil(page, `document.getElementById("root")?.children.length > 0`, 20_000);
    check(connected && page.requests.some((r) => r.startsWith(`wss://localhost:${PORT}/rpc/ws`)), "the app loaded and opened its WebSocket");
    await cdp.sleep(1_000);
    await page.screenshot(join(shots, "sign-in-02-signed-in.png"));
    check(!page.errors.some((e) => /WebSocket|Unauthenticated/.test(e)), `no WebSocket refusal (${page.errors.slice(0, 3).join("; ")})`);

    // Sign out from the page (the UI's button is TSK-140): the cookie goes, a reload is signed out.
    const status = await page.evaluate<number>(`fetch("/auth/logout", { method: "POST", redirect: "manual", headers: { "X-Mightyconsole-Csrf": document.querySelector('meta[name="mightyconsole-csrf"]').content } }).then((r) => r.type === "opaqueredirect" ? 303 : r.status)`);
    check(status === 303, `sign-out answers 303 (${status})`);
    check(!(await cookies(ORIGIN)).some((c) => c.name === "__Host-ambidex_session"), "sign-out removed the session cookie");
    await page.navigate(`${ORIGIN}/`);
    check(await cdp.waitUntil(page, `document.querySelector('meta[name="mightyconsole-auth"]')?.content === "signed-out" && [...document.querySelectorAll("a")].some((a) => a.textContent === "Sign in with Lab Dex")`, 30_000), "after sign-out the page shows the sign-in again");
    await page.screenshot(join(shots, "sign-in-03-signed-out.png"));
  } catch (error) {
    failures.push(String((error as Error).message));
    console.error(`sign-in walk: ${(error as Error).message}`);
  } finally {
    chrome?.kill();
    child?.kill();
    await cdp.sleep(200);
    rmSync(data, { recursive: true, force: true });
  }
  writeFileSync(join(evidence, "sign-in-walk.txt"), failures.length === 0 ? "ok\n" : `${failures.join("\n")}\n`);
  console.log(failures.length === 0 ? "sign-in walk: ok" : `sign-in walk: ${failures.length} failed`);
  return failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [server, evidence] = process.argv.slice(2);
  if (!server || !evidence) {
    console.error("usage: node sign-in-walk.mts SERVER EVIDENCE_DIR");
    process.exit(2);
  }
  main(resolve(server), resolve(evidence)).then((code) => process.exit(code));
}
