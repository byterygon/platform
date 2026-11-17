#!/usr/bin/env node
// Checks the built bundle (dist/) after `vite build`: the Arrow decoder Worker must contain the
// decoder. The jsdom tests decode in the calling thread, so only the build shows whether the
// Worker the app starts can answer; an empty Worker leaves every query waiting for its schema.
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assets = fileURLToPath(new URL("../dist/assets/", import.meta.url));
const workers = readdirSync(assets).filter((name) => /^arrow-worker-.*\.js$/.test(name));
const failures: string[] = [];
if (workers.length !== 1) failures.push(`expected one arrow-worker-*.js in dist/assets, found ${workers.length}`);
for (const name of workers) {
  const text = readFileSync(assets + name, "utf8");
  // The decoder's channel name, and apache-arrow's reader beside it (tens of kB): present only if
  // serveArrowDecoder was bundled.
  if (!text.includes("ambidex.arrow.v1") || text.length < 50_000) {
    failures.push(`dist/assets/${name} (${text.length} bytes) does not contain the Arrow decoder`);
  }
}
if (failures.length > 0) {
  for (const f of failures) console.error(`check-dist: ${f}`);
  process.exit(1);
}
console.log(`check-dist: ${workers[0]} contains the Arrow decoder`);
