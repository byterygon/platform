import { buildSync } from "esbuild";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
const jsonEntry = `import {encodeTyped,decodeTyped} from './semantic.mjs';export const encodeJson=(v,s)=>encodeTyped(v,s,'json');export const decodeJson=(b,s)=>decodeTyped(b,s,'json');`;
const profiles = {
  json: jsonEntry,
  dual:
    jsonEntry +
    `export const encodeCbor=(v,s)=>encodeTyped(v,s,'cbor');export const decodeCbor=(b,s)=>decodeTyped(b,s,'cbor');`,
  cborX: "export {Encoder,Decoder} from 'cbor-x';",
};
const rows = [];
for (const [name, contents] of Object.entries(profiles)) {
  const plugins =
    name === "json"
      ? [
          {
            name: "json-only-build",
            setup(build) {
              build.onLoad({ filter: /codec\.mjs$/ }, (args) => {
                let source = readFileSync(args.path, "utf8");
                const start = source.indexOf("export function encode("),
                  end = source.indexOf("function compare(", start);
                source =
                  source.slice(0, start) +
                  'export function encode(){throw new Error("CBOR excluded from JSON-only build");}\n' +
                  source.slice(end);
                const from = source.indexOf("export function decode("),
                  to = source.indexOf("// Recursive-descent", from);
                source =
                  source.slice(0, from) +
                  'export function decode(){throw new Error("CBOR excluded from JSON-only build");}\n' +
                  source.slice(to);
                return { contents: source, loader: "js" };
              });
            },
          },
        ]
      : [];
  const result = await (
    await import("esbuild")
  ).build({
    stdin: { contents, resolveDir: new URL(".", import.meta.url).pathname },
    bundle: true,
    minify: true,
    format: "esm",
    platform: "browser",
    write: false,
    plugins,
  });
  const bytes = result.outputFiles[0].contents;
  rows.push({
    name,
    minifiedBytes: bytes.length,
    gzipBytes: gzipSync(bytes).length,
  });
}
const delta =
  rows.find((x) => x.name === "dual").gzipBytes -
  rows.find((x) => x.name === "json").gzipBytes;
writeFileSync(
  new URL("../results/bundle.json", import.meta.url),
  JSON.stringify(
    {
      measurement:
        "Experimental JSON-only build excludes raw CBOR implementations through an explicit build transform; dual adds them. This is not a production package-size promise. cbor-x is a separate library comparator.",
      incrementalGzipBytes: delta,
      rows,
    },
    null,
    2,
  ) + "\n",
);
