import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const root = new URL("../", import.meta.url);
const files = [
  "results/fingerprints.json",
  "ts/generated.mjs",
  "ts/generated.d.ts",
  "ts/workloads.mjs",
  "rust/src/generated_ids.rs",
];
const before = files.map((f) => readFileSync(new URL(f, root)));
const fingerprint = execFileSync(
  "cargo",
  [
    "run",
    "--manifest-path",
    new URL("rust/Cargo.toml", root).pathname,
    "--offline",
    "--locked",
    "--bin",
    "fingerprint",
  ],
  { encoding: "utf8" },
);
if (fingerprint !== before[0].toString())
  throw new Error("Rust semantic metadata drift");
execFileSync(process.execPath, [
  new URL("./export.mjs", import.meta.url).pathname,
]);
for (let i = 0; i < files.length; i++)
  if (!before[i].equals(readFileSync(new URL(files[i], root))))
    throw new Error("generated file drift: " + files[i]);
console.log("Experimental generated artifacts are current.");
